/** Lifecycle phases exposed by the live transcription surface. */
export type TranscriptionPhase =
  | 'idle'
  | 'preparing'
  | 'listening'
  | 'finalizing'
  | 'polishing'
  | 'complete'
  | 'dictionary'
  | 'error'

/** One meaningful point retained in the session's voice-status timeline. */
export interface TranscriptionTimelineEvent {
  readonly id: string
  readonly elapsedMs: number | null
  readonly phase: Exclude<TranscriptionPhase, 'idle'>
  readonly label: string
  readonly detail: string
  readonly tone: 'complete' | 'warning' | 'error'
}

/** One explicit user choice attached to a transient Composer status. */
export interface TranscriptionAction {
  readonly label: string
  readonly run: () => void
}

/** Read-only state rendered for one session's transcription dock. */
export interface TranscriptionSnapshot {
  readonly phase: TranscriptionPhase
  readonly finalText: string
  readonly interimText: string
  readonly status: string
  readonly hint: string
  readonly action: TranscriptionAction | null
  readonly secondaryAction: TranscriptionAction | null
  readonly recordingElapsedMs: number | null
  readonly announcement: string
  readonly history: readonly TranscriptionTimelineEvent[]
}

const MAX_TIMELINE_EVENTS = 12
const EMPTY_TIMELINE: readonly TranscriptionTimelineEvent[] = Object.freeze([])

/** Stable empty state shared by sessions that have not started transcribing. */
export const EMPTY_TRANSCRIPTION: TranscriptionSnapshot = Object.freeze({
  phase: 'idle',
  finalText: '',
  interimText: '',
  status: '',
  hint: '',
  action: null,
  secondaryAction: null,
  recordingElapsedMs: null,
  announcement: '',
  history: EMPTY_TIMELINE,
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

function sameTimelineEvent(
  left: TranscriptionTimelineEvent,
  right: TranscriptionTimelineEvent,
): boolean {
  return left.id === right.id
    && left.elapsedMs === right.elapsedMs
    && left.phase === right.phase
    && left.label === right.label
    && left.detail === right.detail
    && left.tone === right.tone
}

function sameTimeline(
  left: readonly TranscriptionTimelineEvent[],
  right: readonly TranscriptionTimelineEvent[],
): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  return left.every((event, index) => {
    const other = right[index]
    return other !== undefined && sameTimelineEvent(event, other)
  })
}

function normalizeTimeline(
  history: readonly TranscriptionTimelineEvent[],
): readonly TranscriptionTimelineEvent[] {
  if (history.length === 0) return EMPTY_TIMELINE
  const recent = history.length > MAX_TIMELINE_EVENTS
    ? history.slice(-MAX_TIMELINE_EVENTS)
    : [...history]
  return Object.freeze(recent.map((event) => Object.freeze({ ...event })))
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
  const requestedHistory = 'history' in patch
    ? patch.history ?? EMPTY_TIMELINE
    : previous.history
  const candidateHistory = requestedHistory === previous.history
    ? previous.history
    : normalizeTimeline(requestedHistory)
  const nextHistory = sameTimeline(candidateHistory, previous.history)
    ? previous.history
    : candidateHistory
  const next: TranscriptionSnapshot = {
    phase: patch.phase ?? previous.phase,
    finalText: patch.finalText ?? previous.finalText,
    interimText: patch.interimText ?? previous.interimText,
    status: patch.status ?? previous.status,
    hint: patch.hint ?? previous.hint,
    action: 'action' in patch ? patch.action ?? null : previous.action,
    secondaryAction: 'secondaryAction' in patch
      ? patch.secondaryAction ?? null
      : previous.secondaryAction,
    recordingElapsedMs: 'recordingElapsedMs' in patch
      ? patch.recordingElapsedMs ?? null
      : previous.recordingElapsedMs,
    announcement: patch.announcement ?? previous.announcement,
    history: nextHistory,
  }
  if (next.phase === previous.phase && next.finalText === previous.finalText
    && next.interimText === previous.interimText && next.status === previous.status
    && next.hint === previous.hint && next.action === previous.action
    && next.secondaryAction === previous.secondaryAction
    && next.recordingElapsedMs === previous.recordingElapsedMs
    && next.announcement === previous.announcement
    && sameTimeline(next.history, previous.history)) {
    return previous
  }
  entry.snapshot = next
  notify(entry)
  return next
}

/** Add or update one meaningful timeline event without moving an existing id. */
export function upsertTranscriptionEvent(
  sessionId: string,
  event: TranscriptionTimelineEvent,
): TranscriptionSnapshot {
  const entry = getOrCreateEntry(sessionId)
  const previous = entry.snapshot
  const existingIndex = previous.history.findIndex((candidate) => candidate.id === event.id)
  if (existingIndex >= 0) {
    const existing = previous.history[existingIndex]
    if (existing !== undefined && sameTimelineEvent(existing, event)) return previous
    const nextHistory = [...previous.history]
    nextHistory[existingIndex] = Object.freeze({ ...event })
    const next: TranscriptionSnapshot = { ...previous, history: Object.freeze(nextHistory) }
    entry.snapshot = next
    notify(entry)
    return next
  }

  const nextHistory = [...previous.history, Object.freeze({ ...event })]
  if (nextHistory.length > MAX_TIMELINE_EVENTS) nextHistory.splice(0, nextHistory.length - MAX_TIMELINE_EVENTS)
  const next: TranscriptionSnapshot = {
    ...previous,
    history: Object.freeze(nextHistory),
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
