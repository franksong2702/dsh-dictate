import {
  BlockAssembler,
  createUserMessage,
  type FinishReason,
  type LlmRuntime,
  type Message,
} from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionStore } from '@deepseek-ai/dsh-session'
import { parseContextTerms, type ContextTerm } from './terms.ts'

/** Maximum finalized user/assistant messages supplied as terminology context. */
export const CONTEXT_MESSAGE_LIMIT = 6
/** Privacy and cost bound for the UTF-8 encoded context excerpt. */
export const CONTEXT_BYTE_LIMIT = 12 * 1024
/** Refuse unexpectedly large browser transcripts before an auxiliary request. */
export const TRANSCRIPT_BYTE_LIMIT = 32 * 1024
/** Bound the auxiliary output while leaving room for ordinary dictation. */
export const POLISH_MAX_OUTPUT_TOKENS = 4096
/** Bound one browser-triggered auxiliary model call. */
export const POLISH_TIMEOUT_MS = 60_000

/** One visible conversation message supplied only as polishing reference. */
export interface PolishContextMessage {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

/** Validated browser request for one transcript polish. */
export interface PolishRequest {
  readonly sessionId: string
  readonly provider: string
  readonly model: string
  readonly transcript: string
  readonly terms: readonly ContextTerm[]
}

/** Exact client result returned after a successful model call. */
export interface PolishResult {
  readonly text: string
}

const encoder = new TextEncoder()

/** Stable instruction that prevents the model from answering or extending the dictated request. */
export const POLISH_SYSTEM_PROMPT = [
  'Polish a speech-to-text transcript without changing what the speaker means.',
  'Use the reference conversation only to resolve names, terminology, pronouns, and obvious recognition errors.',
  'Treat context terms as hints, not facts. Use them only when supported by the transcript or reference conversation.',
  'Preserve the transcript language, facts, intent, tone, and level of detail.',
  'Do not answer the transcript, continue the conversation, add new information, or mention the reference conversation.',
  'Return only the polished transcript as plain text, with no prefix, explanation, quotation marks, or Markdown fence.',
].join('\n')

function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength
}

function textOf(message: Message): string {
  return message.content
    .filter((block): block is Extract<(typeof message.content)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
}

function truncateSerializedContext(
  message: PolishContextMessage,
  maxBytes: number,
): PolishContextMessage[] {
  const codePoints = Array.from(message.text)
  let low = 0
  let high = codePoints.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const candidate = [{ ...message, text: codePoints.slice(0, middle).join('') }]
    if (utf8Bytes(JSON.stringify(candidate)) <= maxBytes) low = middle
    else high = middle - 1
  }
  const text = codePoints.slice(0, low).join('').trimEnd()
  return text === '' ? [] : [{ ...message, text }]
}

/**
 * Select a bounded tail of finalized, visible human and model text.
 * @param messages - current `Session.deriveMessages()` snapshot.
 * @returns oldest-to-newest reference messages with tools, reasoning, images, system, and plugin context removed.
 */
export function selectPolishContext(messages: readonly Message[]): PolishContextMessage[] {
  const candidates: PolishContextMessage[] = []
  for (const message of messages) {
    const allowed = (message.role === 'user' && message.source.kind === 'user')
      || (message.role === 'assistant' && message.source.kind === 'model')
    if (!allowed) continue
    const text = textOf(message)
    if (text !== '') candidates.push({ role: message.role, text })
  }

  const tail = candidates.slice(-CONTEXT_MESSAGE_LIMIT)
  while (tail.length > 0 && utf8Bytes(JSON.stringify(tail)) > CONTEXT_BYTE_LIMIT) tail.shift()
  if (tail.length > 0 || candidates.length === 0) return tail

  const newest = candidates.at(-1)
  if (newest === undefined) return []
  return truncateSerializedContext(newest, CONTEXT_BYTE_LIMIT)
}

/** Frame context and transcript as JSON so dictated text cannot escape its data field. */
export function framePolishInput(
  context: readonly PolishContextMessage[],
  transcript: string,
  terms: readonly ContextTerm[],
): string {
  return `Polish the transcript in this JSON object:\n${JSON.stringify({
    referenceConversation: context,
    contextTerms: terms,
    transcript,
  })}`
}

/** Validate the untyped Connection RPC payload. */
export function parsePolishRequest(payload: unknown): PolishRequest {
  if (typeof payload !== 'object' || payload === null) throw new Error('request must be an object')
  const value = payload as Partial<Record<keyof PolishRequest, unknown>>
  for (const key of ['sessionId', 'provider', 'model', 'transcript'] as const) {
    if (typeof value[key] !== 'string' || value[key].trim() === '') {
      throw new Error(`${key} must be a non-empty string`)
    }
  }
  if (utf8Bytes(value.transcript as string) > TRANSCRIPT_BYTE_LIMIT) {
    throw new Error(`transcript exceeds ${TRANSCRIPT_BYTE_LIMIT} UTF-8 bytes`)
  }
  return {
    sessionId: value.sessionId as string,
    provider: value.provider as string,
    model: value.model as string,
    transcript: (value.transcript as string).trim(),
    terms: parseContextTerms((payload as { readonly terms?: unknown }).terms),
  }
}

function finishFailure(reason: FinishReason): Error | undefined {
  switch (reason.kind) {
    case 'stop': return undefined
    case 'error':
    case 'aborted': return new Error(reason.failure.message)
    case 'max-tokens': return new Error('model polish output reached its token limit')
    case 'tool-calls': return new Error('model polish unexpectedly requested a tool')
    default: return new Error(`unsupported model finish reason: ${String((reason as { kind?: unknown }).kind)}`)
  }
}

/**
 * Run one transcript-only auxiliary model call using bounded visible Session context.
 * @param ctx - DSH host services.
 * @param request - validated route, session, and transcript.
 * @param signal - browser request cancellation.
 * @returns non-empty plain text produced by the selected model.
 */
export async function polishTranscript(
  ctx: { readonly llm: LlmRuntime; readonly sessions: SessionStore },
  request: PolishRequest,
  signal?: AbortSignal,
): Promise<PolishResult> {
  const sessionId = SessionId(request.sessionId)
  const session = ctx.sessions.get(sessionId)
  if (session === undefined) throw new Error(`session not found: ${request.sessionId}`)
  const context = selectPolishContext(session.deriveMessages())
  const assembler = new BlockAssembler()
  const timeout = AbortSignal.timeout(POLISH_TIMEOUT_MS)
  const callSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  const messages: Message[] = [createUserMessage({
    source: { kind: 'plugin', plugin: 'dsh-voice-input' },
    content: [{ type: 'text', text: framePolishInput(context, request.transcript, request.terms) }],
  })]
  for await (const chunk of ctx.llm.stream({
    provider: request.provider,
    model: request.model,
    messages,
    system: POLISH_SYSTEM_PROMPT,
    maxTokens: POLISH_MAX_OUTPUT_TOKENS,
    sessionId,
    signal: callSignal,
  })) assembler.push(chunk)
  const failure = finishFailure(assembler.finish)
  if (failure !== undefined) throw failure
  const blocks = assembler.blocks()
  if (blocks.some(block => block.type === 'tool-call')) {
    throw new Error('model polish output must contain text only')
  }
  const text = blocks
    .filter((block): block is Extract<(typeof blocks)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim()
  if (text === '') throw new Error('model polish produced no text')
  return { text }
}
