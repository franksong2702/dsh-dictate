/** Lifecycle phases exposed by the live transcription surface. */
export type TranscriptionPhase =
  | 'idle'
  | 'preparing'
  | 'listening'
  | 'finalizing'
  | 'polishing'
  | 'complete'
  | 'error'

/** Read-only state rendered for one session's transcription dock. */
export interface TranscriptionSnapshot {
  readonly phase: TranscriptionPhase
  readonly finalText: string
  readonly interimText: string
  readonly status: string
  readonly hint: string
}

/** Stable empty state shared by sessions that have not started transcribing. */
export const EMPTY_TRANSCRIPTION: TranscriptionSnapshot = Object.freeze({
  phase: 'idle',
  finalText: '',
  interimText: '',
  status: '',
  hint: '',
})

interface TranscriptionEntry {
  snapshot: TranscriptionSnapshot
  readonly listeners: Set<() => void>
}

/*
 * Entries are keyed by session rather than held as one process-wide snapshot.
 * A non-empty snapshot is retained after its listeners leave so a later dock
 * can resume the same session; resetTranscription returns it to EMPTY and lets
 * the entry be collected when no listeners remain.
 */
const entries = new Map<string, TranscriptionEntry>()

function getOrCreateEntry(sessionId: string): TranscriptionEntry {
  const existing = entries.get(sessionId)
  if (existing !== undefined) return existing
  const entry: TranscriptionEntry = { snapshot: EMPTY_TRANSCRIPTION, listeners: new Set() }
  entries.set(sessionId, entry)
  return entry
}

function maybeDeleteEntry(sessionId: string, entry: TranscriptionEntry): void {
  if (entry.listeners.size === 0 && entry.snapshot === EMPTY_TRANSCRIPTION
    && entries.get(sessionId) === entry) {
    entries.delete(sessionId)
  }
}

function notify(entry: TranscriptionEntry): void {
  for (const listener of [...entry.listeners]) listener()
}

/** Read one session's stable snapshot without creating a store entry. */
export function getTranscriptionSnapshot(sessionId: string): TranscriptionSnapshot {
  return entries.get(sessionId)?.snapshot ?? EMPTY_TRANSCRIPTION
}

/** Subscribe to updates for one session and return an idempotent disposer. */
export function subscribeTranscription(sessionId: string, listener: () => void): () => void {
  const entry = getOrCreateEntry(sessionId)
  entry.listeners.add(listener)
  let active = true
  return () => {
    if (!active) return
    active = false
    entry.listeners.delete(listener)
    maybeDeleteEntry(sessionId, entry)
  }
}

/** Merge one session's transcription patch and notify only its subscribers. */
export function updateTranscription(
  sessionId: string,
  patch: Partial<TranscriptionSnapshot>,
): TranscriptionSnapshot {
  const entry = getOrCreateEntry(sessionId)
  const previous = entry.snapshot
  const next: TranscriptionSnapshot = {
    phase: patch.phase ?? previous.phase,
    finalText: patch.finalText ?? previous.finalText,
    interimText: patch.interimText ?? previous.interimText,
    status: patch.status ?? previous.status,
    hint: patch.hint ?? previous.hint,
  }
  if (next.phase === previous.phase && next.finalText === previous.finalText
    && next.interimText === previous.interimText && next.status === previous.status
    && next.hint === previous.hint) {
    return previous
  }
  entry.snapshot = next
  notify(entry)
  return next
}

/** Reset one session to the shared empty snapshot and notify its subscribers. */
export function resetTranscription(sessionId: string): void {
  const entry = entries.get(sessionId)
  if (entry === undefined) return
  if (entry.snapshot !== EMPTY_TRANSCRIPTION) {
    entry.snapshot = EMPTY_TRANSCRIPTION
    notify(entry)
  }
  maybeDeleteEntry(sessionId, entry)
}
