import {
  BlockAssembler,
  createUserMessage,
  type FinishReason,
  type LlmRuntime,
  type Message,
} from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionStore } from '@deepseek-ai/dsh-session'
import {
  CONTEXT_TERM_LIMIT,
  extractContextTerms,
  parseContextTerms,
  type ContextTerm,
  type ContextTermsModelRoute,
  type ContextTermsRequest,
  type ContextTermSource,
} from './terms.ts'
import { selectPolishContext } from './polish.ts'

/** Maximum model output accepted for temporary terminology extraction. */
export const TERM_EXTRACTION_MAX_OUTPUT_TOKENS = 256
/** Maximum source-grounded model terms allowed to displace deterministic rule terms. */
export const TERM_EXTRACTION_MODEL_TERM_LIMIT = 16
/** Maximum time spent on one optional model terminology request. */
export const TERM_EXTRACTION_TIMEOUT_MS = 15_000
/** Maximum settled terminology results retained by the host. */
export const TERM_EXTRACTION_CACHE_LIMIT = 32
/** Maximum in-flight terminology requests retained by the host. */
export const TERM_EXTRACTION_IN_FLIGHT_LIMIT = 32
/** Boost assigned to a model-confirmed term before rule-derived duplicates are merged. */
export const TERM_EXTRACTION_MODEL_BOOST = 5

/** Host services required for visible-context terminology extraction. */
export interface TermExtractionHost {
  readonly llm: LlmRuntime
  readonly sessions: SessionStore
}

/** Model-facing instruction requiring a strict, source-grounded JSON response. */
export const TERM_EXTRACTION_SYSTEM_PROMPT = [
  'Extract only useful proper nouns, named entities, product names, technical terms, and unusual Chinese or English vocabulary from the supplied visible text.',
  'Every returned term must be copied verbatim from the supplied Session or Composer text, ignoring letter case only.',
  'Prefer terms that speech recognition is likely to get wrong: English technical terms and product names spoken inside Chinese sentences, transliterated proper nouns, identifiers, API and field names, and Chinese terms with common homophones.',
  'Skip ordinary vocabulary that recognition would already get right.',
  'Do not infer, translate, normalize, complete, or invent a term. Do not return ordinary prose words.',
  `Return exactly one JSON object with exactly one key: {"terms":["term"]}. Return at most ${TERM_EXTRACTION_MODEL_TERM_LIMIT} terms, or an empty array when no useful terms are present.`,
  'Return JSON only. Do not use Markdown fences, commentary, or any additional keys.',
].join('\n')

interface TermExtractionInput {
  readonly sessionId: ReturnType<typeof SessionId>
  readonly sources: readonly ContextTermSource[]
  readonly route: ContextTermsModelRoute
}

const settledCache = new Map<string, readonly ContextTerm[]>()
const inFlight = new Map<string, Promise<readonly ContextTerm[]>>()

function boundedSet<T>(map: Map<string, T>, key: string, value: T, limit: number): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > limit) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

/** Clear process-local term caches between host lifecycles or deterministic tests. */
export function resetTermExtractionCache(): void {
  settledCache.clear()
  inFlight.clear()
}

function routeKey(route: ContextTermsModelRoute | undefined): readonly [string, string] | [] {
  return route === undefined ? [] : [route.provider, route.model]
}

function cacheKey(input: {
  readonly sessionId: string
  readonly sources: readonly ContextTermSource[]
  readonly route?: ContextTermsModelRoute
}): string {
  return JSON.stringify([input.sessionId, input.sources, routeKey(input.route)])
}

function visibleSources(session: ReturnType<SessionStore['get']>, draft: string): ContextTermSource[] {
  if (session === undefined) return [{ text: draft, source: 'composer' }]
  return [
    ...selectPolishContext(session.deriveMessages()).map(message => ({
      text: message.text,
      source: 'session' as const,
    })),
    { text: draft, source: 'composer' as const },
  ]
}

function finishFailure(reason: FinishReason): Error | undefined {
  switch (reason.kind) {
    case 'stop': return undefined
    case 'error':
    case 'aborted': return new Error(reason.failure.message)
    case 'max-tokens': return new Error('term extraction output reached its token limit')
    case 'tool-calls': return new Error('term extraction unexpectedly requested a tool')
    default: return new Error(`unsupported model finish reason: ${String((reason as { kind?: unknown }).kind)}`)
  }
}

function frameTermExtractionInput(sources: readonly ContextTermSource[]): string {
  return `Extract terms from this JSON object:\n${JSON.stringify({ sources })}`
}

function hasTerm(source: string, term: string): boolean {
  return source.toLocaleLowerCase('en-US').includes(term.toLocaleLowerCase('en-US'))
}

function sourceForTerm(sources: readonly ContextTermSource[], term: string): ContextTerm['source'] | undefined {
  // Composer is the freshest and most specific visible source. Fall back to Session only
  // after checking every Composer source, so a model cannot choose provenance itself.
  for (const source of sources) {
    if (source.source === 'composer' && hasTerm(source.text, term)) return 'composer'
  }
  for (const source of sources) {
    if (source.source === 'session' && hasTerm(source.text, term)) return 'session'
  }
  return undefined
}

function parseModelTerms(value: string, sources: readonly ContextTermSource[]): ContextTerm[] {
  const text = value.trim()
  if (text === '' || text.includes('```')) throw new Error('term extraction returned non-JSON text')
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    throw new Error('term extraction returned invalid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('term extraction JSON must be an object')
  }
  const record = parsed as { readonly terms?: unknown }
  if (Object.keys(parsed).length !== 1 || !Array.isArray(record.terms)
    || record.terms.length > TERM_EXTRACTION_MODEL_TERM_LIMIT) {
    throw new Error('term extraction JSON must contain only a bounded terms array')
  }
  const terms: ContextTerm[] = []
  const seen = new Set<string>()
  for (const candidate of record.terms) {
    if (typeof candidate !== 'string') throw new Error('term extraction terms must be strings')
    let validated: ContextTerm[]
    try {
      validated = parseContextTerms([{
        text: candidate,
        boost: TERM_EXTRACTION_MODEL_BOOST,
        source: 'session',
      }])
    } catch {
      continue
    }
    const term = validated[0]
    if (term === undefined) continue
    const source = sourceForTerm(sources, term.text)
    if (source === undefined) continue
    const key = term.text.toLocaleLowerCase('en-US')
    if (seen.has(key)) continue
    seen.add(key)
    terms.push({ ...term, source })
  }
  return terms
}

async function extractWithModel(
  llm: LlmRuntime,
  input: TermExtractionInput,
  signal?: AbortSignal,
): Promise<ContextTerm[]> {
  const timeout = AbortSignal.timeout(TERM_EXTRACTION_TIMEOUT_MS)
  const callSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  const assembler = new BlockAssembler()
  const messages: Message[] = [createUserMessage({
    source: { kind: 'plugin', plugin: 'dsh-dictate' },
    content: [{ type: 'text', text: frameTermExtractionInput(input.sources) }],
  })]
  for await (const chunk of llm.stream({
    provider: input.route.provider,
    model: input.route.model,
    messages,
    system: TERM_EXTRACTION_SYSTEM_PROMPT,
    maxTokens: TERM_EXTRACTION_MAX_OUTPUT_TOKENS,
    sessionId: input.sessionId,
    signal: callSignal,
  })) assembler.push(chunk)
  const failure = finishFailure(assembler.finish)
  if (failure !== undefined) throw failure
  const blocks = assembler.blocks()
  if (blocks.some(block => block.type === 'tool-call')) {
    throw new Error('term extraction output must contain text only')
  }
  const text = blocks
    .filter((block): block is Extract<(typeof blocks)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
  return parseModelTerms(text, input.sources)
}

function mergeTerms(rules: readonly ContextTerm[], inferred: readonly ContextTerm[]): ContextTerm[] {
  const merged: ContextTerm[] = []
  const indexes = new Map<string, number>()
  // Reserve at most half of the bounded list for model-confirmed entities, then let
  // deterministic rules fill the remaining slots and strengthen duplicates.
  for (const term of [...inferred, ...rules]) {
    const key = term.text.toLocaleLowerCase('en-US')
    const existingIndex = indexes.get(key)
    if (existingIndex === undefined) {
      indexes.set(key, merged.length)
      merged.push({ ...term })
      if (merged.length >= CONTEXT_TERM_LIMIT) break
      continue
    }
    const existing = merged[existingIndex]
    if (existing === undefined) continue
    merged[existingIndex] = {
      ...existing,
      boost: Math.max(existing.boost, term.boost),
      source: term.source === 'composer' ? 'composer' : existing.source,
    }
  }
  return merged
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(new Error('term extraction was cancelled'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      reject(new Error('term extraction was cancelled'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(value => {
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }, error => {
      signal.removeEventListener('abort', onAbort)
      reject(error)
    })
  })
}

/**
 * Derive temporary terms from visible Session and Composer text, optionally enriching rules
 * with terms from the selected model. Model failures are intentionally reduced to rule terms.
 * @param host - host Session and LLM services.
 * @param request - validated browser term request.
 * @param signal - browser request cancellation.
 * @returns bounded, source-grounded temporary terms.
 */
export async function extractContextTermsForRequest(
  host: TermExtractionHost,
  request: ContextTermsRequest,
  signal?: AbortSignal,
): Promise<ContextTerm[]> {
  if (signal?.aborted) throw new Error('term extraction was cancelled')
  const sessionId = SessionId(request.sessionId)
  const session = host.sessions.get(sessionId)
  if (session === undefined) throw new Error(`session not found: ${request.sessionId}`)
  const sources = visibleSources(session, request.draft)
  const rules = extractContextTerms(sources)
  const key = cacheKey({ sessionId: request.sessionId, sources, route: request.model })
  const cached = settledCache.get(key)
  if (cached !== undefined || settledCache.has(key)) return [...(cached ?? [])]
  if (request.model === undefined) {
    const result = [...rules]
    boundedSet(settledCache, key, result, TERM_EXTRACTION_CACHE_LIMIT)
    return result
  }

  const existing = inFlight.get(key)
  if (existing !== undefined) {
    try {
      return [...await abortable(existing, signal)]
    } catch (error) {
      if (signal?.aborted) throw error
      return [...rules]
    }
  }

  if (inFlight.size >= TERM_EXTRACTION_IN_FLIGHT_LIMIT) return [...rules]
  const input: TermExtractionInput = { sessionId, sources, route: request.model }
  const operation = (async (): Promise<readonly ContextTerm[]> => {
    let inferred: ContextTerm[] = []
    try {
      inferred = await extractWithModel(host.llm, input, signal)
    } catch (error) {
      if (signal?.aborted) throw error
      return [...rules]
    }
    const result = mergeTerms(rules, inferred)
    boundedSet(settledCache, key, result, TERM_EXTRACTION_CACHE_LIMIT)
    return result
  })()
  inFlight.set(key, operation)
  try {
    return [...await abortable(operation, signal)]
  } catch (error) {
    if (signal?.aborted) throw error
    return [...rules]
  } finally {
    if (inFlight.get(key) === operation) inFlight.delete(key)
  }
}
