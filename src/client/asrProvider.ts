/** A bounded piece of vocabulary supplied to a speech recognizer. */
export interface AsrContextTerm {
  readonly text: string
  readonly boost?: number
}

/** Lifecycle states shared by browser and local-endpoint recognition. */
export type AsrProviderStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'listening'
  | 'stopping'
  | 'complete'
  | 'aborted'
  | 'error'

/** Human-readable provider progress. */
export interface AsrProviderProgress {
  readonly phase: 'runtime' | 'microphone' | 'audio'
  readonly message?: string
  readonly loaded?: number
  readonly total?: number
}

/** Stable error codes used by the Composer surface. */
export type AsrProviderErrorCode =
  | 'unsupported'
  | 'microphone-failed'
  | 'audio-failed'
  | 'recognition-failed'
  | 'endpoint-invalid'
  | 'endpoint-unreachable'
  | 'endpoint-response'
  | 'aborted'
  | 'invalid-state'

/** A readable provider failure that preserves the original cause for diagnostics. */
export interface AsrProviderError {
  readonly code: AsrProviderErrorCode
  readonly message: string
  readonly cause?: unknown
}

/** Event callbacks shared by speech-recognition providers. */
export interface AsrProviderCallbacks {
  readonly onStart?: () => void
  readonly onInterim?: (text: string) => void
  readonly onFinal?: (text: string) => void
  readonly onStatus?: (status: AsrProviderStatus) => void
  readonly onProgress?: (progress: AsrProviderProgress) => void
  readonly onError?: (error: AsrProviderError) => void
  readonly onEnd?: (reason: 'stop' | 'abort' | 'error' | 'ended') => void
}

/** Inputs used to start one recognition session. */
export interface AsrProviderStartOptions extends AsrProviderCallbacks {
  readonly lang?: string
  readonly terms?: readonly AsrContextTerm[]
  readonly signal?: AbortSignal
}

/** Controls one active recording session. */
export interface AsrProviderSession {
  stop(): Promise<void>
  abort(): Promise<void>
  updateTerms(terms: readonly AsrContextTerm[]): Promise<void>
}

/** Common start surface implemented by Web Speech and local endpoints. */
export interface AsrProvider {
  start(options?: AsrProviderStartOptions): AsrProviderSession | Promise<AsrProviderSession>
}

export function asrProviderError(
  code: AsrProviderErrorCode,
  message: string,
  cause?: unknown,
): AsrProviderError {
  return cause === undefined ? { code, message } : { code, message, cause }
}

export function emitAsrStatus(
  callbacks: AsrProviderCallbacks,
  status: AsrProviderStatus,
): void {
  callbacks.onStatus?.(status)
}
