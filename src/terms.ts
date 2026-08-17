/** Maximum number of temporary recognition hints sent across the browser boundary. */
export const CONTEXT_TERM_LIMIT = 32
/** Maximum number of Unicode code points in one temporary recognition hint. */
export const CONTEXT_TERM_CODE_POINT_LIMIT = 64
/** Maximum browser Composer draft size accepted for temporary term extraction. */
export const CONTEXT_DRAFT_BYTE_LIMIT = 8 * 1024
/** Minimum contextual-biasing strength for dynamically extracted terms. */
export const CONTEXT_TERM_MIN_BOOST = 2
/** Maximum contextual-biasing strength for dynamically extracted terms. */
export const CONTEXT_TERM_MAX_BOOST = 6

/** Request for terms derived from one visible Session tail and its Composer draft. */
export interface ContextTermsRequest {
  readonly sessionId: string
  readonly draft: string
  readonly includeInferred: boolean
  /** The same provider/model route selected for transcript polishing, when enabled. */
  readonly model?: ContextTermsModelRoute
}

/** One provider/model route used for an auxiliary model request. */
export interface ContextTermsModelRoute {
  readonly provider: string
  readonly model: string
}

/** One bounded, weighted term shared by recognition biasing and model polishing. */
export interface ContextTerm {
  readonly text: string
  readonly boost: number
  readonly source: 'session' | 'composer'
}

/** One visible text source used to derive temporary terminology. */
export interface ContextTermSource {
  readonly text: string
  readonly source: ContextTerm['source']
}

const encoder = new TextEncoder()
const commonEnglishWords = new Set([
  'about', 'after', 'again', 'also', 'and', 'are', 'because', 'before', 'but', 'can', 'could',
  'earlier',
  'for', 'from', 'have', 'into', 'just', 'more', 'not', 'now', 'only', 'our', 'should', 'that',
  'the', 'their', 'then', 'there', 'these', 'they', 'this', 'those', 'use', 'was', 'we', 'what',
  'when', 'where', 'which', 'will', 'with', 'would', 'you', 'your',
])

function normalizeTerm(value: string): string | undefined {
  const term = value.trim().replace(/\s+/g, ' ')
  const length = Array.from(term).length
  if (length < 2 || length > CONTEXT_TERM_CODE_POINT_LIMIT || /^\p{Number}+$/u.test(term)) return undefined
  if (/^[A-Za-z]+$/.test(term) && commonEnglishWords.has(term.toLowerCase())) return undefined
  return term
}

/**
 * Validate and deduplicate a term list before it crosses a recognition or model boundary.
 * @param values - untrusted term-list value.
 * @returns bounded terms in source priority order.
 */
export function parseContextTerms(values: unknown): ContextTerm[] {
  if (!Array.isArray(values) || values.length > CONTEXT_TERM_LIMIT) {
    throw new Error(`terms must be an array with at most ${CONTEXT_TERM_LIMIT} items`)
  }
  const terms: ContextTerm[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'object' || value === null) throw new Error('each term must be an object')
    const candidate = value as {
      readonly text?: unknown
      readonly boost?: unknown
      readonly source?: unknown
    }
    if (typeof candidate.text !== 'string') throw new Error('each term text must be a string')
    if (typeof candidate.boost !== 'number' || !Number.isFinite(candidate.boost)
      || candidate.boost < CONTEXT_TERM_MIN_BOOST || candidate.boost > CONTEXT_TERM_MAX_BOOST) {
      throw new Error(`each term boost must be between ${CONTEXT_TERM_MIN_BOOST} and ${CONTEXT_TERM_MAX_BOOST}`)
    }
    if (candidate.source !== 'session' && candidate.source !== 'composer') {
      throw new Error('each term source must be session or composer')
    }
    const term = normalizeTerm(candidate.text)
    if (term === undefined) throw new Error(`each term must contain 2-${CONTEXT_TERM_CODE_POINT_LIMIT} characters`)
    const key = term.toLocaleLowerCase('en-US')
    if (seen.has(key)) continue
    seen.add(key)
    terms.push({
      text: term,
      boost: candidate.boost,
      source: candidate.source,
    })
  }
  return terms
}

/** Validate the browser request used to derive temporary context terms. */
export function parseContextTermsRequest(payload: unknown): ContextTermsRequest {
  if (typeof payload !== 'object' || payload === null) throw new Error('request must be an object')
  const value = payload as {
    readonly sessionId?: unknown
    readonly draft?: unknown
    readonly includeInferred?: unknown
    readonly model?: unknown
  }
  if (typeof value.sessionId !== 'string' || value.sessionId.trim() === '') {
    throw new Error('sessionId must be a non-empty string')
  }
  if (typeof value.draft !== 'string') throw new Error('draft must be a string')
  if (encoder.encode(value.draft).byteLength > CONTEXT_DRAFT_BYTE_LIMIT) {
    throw new Error(`draft exceeds ${CONTEXT_DRAFT_BYTE_LIMIT} UTF-8 bytes`)
  }
  if (typeof value.includeInferred !== 'boolean') throw new Error('includeInferred must be a boolean')
  let model: ContextTermsModelRoute | undefined
  if (value.model !== undefined) {
    if (typeof value.model !== 'object' || value.model === null) {
      throw new Error('model must be an object')
    }
    const route = value.model as { readonly provider?: unknown; readonly model?: unknown }
    if (typeof route.provider !== 'string' || route.provider.trim() === '') {
      throw new Error('model provider must be a non-empty string')
    }
    if (typeof route.model !== 'string' || route.model.trim() === '') {
      throw new Error('model id must be a non-empty string')
    }
    model = { provider: route.provider, model: route.model }
  }
  return { sessionId: value.sessionId, draft: value.draft, includeInferred: value.includeInferred, model }
}

/**
 * Extract bounded English, technical, and explicitly quoted terms from recent visible text.
 * @param sources - oldest-to-newest visible Session text followed by the current Composer draft.
 * @returns ranked temporary terms suitable for recognition biasing and model reference.
 */
export function extractContextTerms(sources: readonly ContextTermSource[]): ContextTerm[] {
  interface Candidate {
    text: string
    score: number
    occurrences: number
    explicit: boolean
    source: ContextTerm['source']
    newestIndex: number
  }
  const candidates = new Map<string, Candidate>()
  const add = (value: string, sourceIndex: number, explicit: boolean, phraseLength: number): void => {
    const term = normalizeTerm(value)
    if (term === undefined) return
    const key = term.toLocaleLowerCase('en-US')
    const input = sources[sourceIndex]
    if (input === undefined) return
    const sourceBonus = input.source === 'composer' ? 4 : Math.max(0, 3 - (sources.length - 1 - sourceIndex))
    const base = explicit ? 10 : phraseLength > 1 ? 6 + phraseLength : 3
    const existing = candidates.get(key)
    if (existing === undefined) {
      candidates.set(key, {
        text: term,
        score: base + sourceBonus,
        occurrences: 1,
        explicit,
        source: input.source,
        newestIndex: sourceIndex,
      })
      return
    }
    existing.score = Math.max(existing.score, base + sourceBonus)
    existing.occurrences += 1
    existing.explicit ||= explicit
    if (input.source === 'composer') existing.source = 'composer'
    existing.newestIndex = Math.max(existing.newestIndex, sourceIndex)
  }

  for (let sourceIndex = sources.length - 1; sourceIndex >= 0; sourceIndex -= 1) {
    const source = sources[sourceIndex]?.text ?? ''
    for (const match of source.matchAll(/`([^`\n]+)`|“([^”\n]+)”|「([^」\n]+)」|『([^』\n]+)』|"([^"\n]+)"/gu)) {
      add(match.slice(1).find(value => value !== undefined) ?? '', sourceIndex, true, 1)
    }

    const matches = [...source.matchAll(/[A-Za-z][A-Za-z0-9]*(?:[._+#/-][A-Za-z0-9]+)*/g)]
    for (let index = 0; index < matches.length; index += 1) {
      const current = matches[index]
      if (current === undefined) continue
      const sequence = [current[0]]
      for (let nextIndex = index + 1; nextIndex < Math.min(index + 3, matches.length); nextIndex += 1) {
        const previous = matches[nextIndex - 1]
        const next = matches[nextIndex]
        if (previous === undefined || next === undefined || previous.index === undefined || next.index === undefined) break
        const gap = source.slice(previous.index + previous[0].length, next.index)
        if (!/^\s+$/.test(gap)) break
        sequence.push(next[0])
        if (sequence.every(token => /[A-Z0-9._+#/-]/.test(token))) {
          add(sequence.join(' '), sourceIndex, false, sequence.length)
        }
      }
      if (/[A-Z0-9._+#/-]/.test(current[0])) add(current[0], sourceIndex, false, 1)
    }
  }

  const ranked = [...candidates.values()].sort((left, right) =>
    (right.score + Math.min(right.occurrences - 1, 2)) - (left.score + Math.min(left.occurrences - 1, 2))
    || right.text.split(/\s+/).length - left.text.split(/\s+/).length
    || right.newestIndex - left.newestIndex)
  const selected: Candidate[] = []
  for (const candidate of ranked) {
    const key = candidate.text.toLocaleLowerCase('en-US')
    const isRedundant = !candidate.explicit && candidate.occurrences === 1 && selected.some((parent) => {
      const parentKey = parent.text.toLocaleLowerCase('en-US')
      return parentKey !== key && parentKey.split(/\s+/).length > 1
        && (` ${parentKey} `).includes(` ${key} `)
    })
    if (!isRedundant) selected.push(candidate)
    if (selected.length >= CONTEXT_TERM_LIMIT) break
  }
  return selected.map((candidate) => ({
    text: candidate.text,
    boost: Math.max(CONTEXT_TERM_MIN_BOOST, Math.min(
      CONTEXT_TERM_MAX_BOOST,
      Math.round((candidate.score + Math.min(candidate.occurrences - 1, 2)) / 3),
    )),
    source: candidate.source,
  }))
}
