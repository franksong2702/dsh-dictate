export const LOCAL_SERVICE_ENDPOINT = 'http://127.0.0.1:39081'

export type LocalServicePhase = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'
export type LocalServiceStage =
  | 'idle'
  | 'checking-runtime'
  | 'starting-process'
  | 'checking-model'
  | 'downloading-model'
  | 'loading-model'
  | 'checking-health'
  | 'ready'
  | 'external'
  | 'stopping'
  | 'failed'

/** Browser-safe status returned by the trusted host controller. */
export interface LocalServiceStatus {
  readonly phase: LocalServicePhase
  readonly stage: LocalServiceStage
  readonly endpoint: string
  readonly managed: boolean
  readonly message: string
  readonly progressPercent: number | null
  readonly elapsedSeconds: number | null
}

export interface LocalServiceStartRequest {
  readonly origin: string
}

export interface LocalServiceAutoStartSettings {
  readonly enabled: boolean
  readonly origin: string
}

export type LocalServiceInstallPhase =
  | 'unsupported'
  | 'not-installed'
  | 'installing'
  | 'installed'
  | 'error'

export type LocalServiceInstallStage =
  | 'idle'
  | 'copying-runtime'
  | 'copying-model'
  | 'downloading-model'
  | 'verifying'
  | 'ready'
  | 'cancelled'
  | 'failed'

/** Browser-safe state for the settings-page native ASR installer. */
export interface LocalServiceInstallStatus {
  readonly available: boolean
  readonly phase: LocalServiceInstallPhase
  readonly stage: LocalServiceInstallStage
  readonly message: string
  readonly progressPercent: number | null
  readonly completedBytes: number | null
  readonly totalBytes: number | null
  readonly platform: string
  readonly installPath: string
}

/** Accept only a loopback DSH origin; no command or process arguments cross the RPC boundary. */
export function parseLocalServiceStartRequest(value: unknown): LocalServiceStartRequest {
  if (typeof value !== 'object' || value === null || !('origin' in value)
    || typeof (value as { readonly origin?: unknown }).origin !== 'string') {
    throw new Error('origin must be a loopback URL')
  }
  let origin: URL
  try {
    origin = new URL((value as { readonly origin: string }).origin)
  } catch {
    throw new Error('origin must be a loopback URL')
  }
  const loopback = origin.hostname === '127.0.0.1'
    || origin.hostname === 'localhost'
    || origin.hostname === '[::1]'
  if (!loopback || (origin.protocol !== 'http:' && origin.protocol !== 'https:')
    || origin.username !== '' || origin.password !== '' || origin.pathname !== '/'
    || origin.search !== '' || origin.hash !== '') {
    throw new Error('origin must be a loopback URL')
  }
  return { origin: origin.origin }
}

/** Parse the persisted auto-start choice without allowing a non-loopback CORS origin. */
export function parseLocalServiceAutoStartSettings(value: unknown): LocalServiceAutoStartSettings {
  if (typeof value !== 'object' || value === null
    || !('enabled' in value) || typeof (value as { readonly enabled?: unknown }).enabled !== 'boolean'
    || !('origin' in value) || typeof (value as { readonly origin?: unknown }).origin !== 'string') {
    throw new Error('local service auto-start settings are invalid')
  }
  const enabled = (value as { readonly enabled: boolean }).enabled
  const rawOrigin = (value as { readonly origin: string }).origin
  if (!enabled && rawOrigin === '') return { enabled, origin: '' }
  return { enabled, origin: parseLocalServiceStartRequest({ origin: rawOrigin }).origin }
}

/** Parse one browser request that changes the host-persisted auto-start choice. */
export const parseLocalServiceAutoStartRequest = parseLocalServiceAutoStartSettings

export function parseLocalServiceInstallStatus(value: unknown): LocalServiceInstallStatus {
  if (typeof value !== 'object' || value === null) throw new Error('local service installer returned invalid status')
  const candidate = value as Record<string, unknown>
  const phases = new Set<LocalServiceInstallPhase>([
    'unsupported', 'not-installed', 'installing', 'installed', 'error',
  ])
  const stages = new Set<LocalServiceInstallStage>([
    'idle', 'copying-runtime', 'copying-model', 'downloading-model', 'verifying',
    'ready', 'cancelled', 'failed',
  ])
  const validBytes = (bytes: unknown): bytes is number | null => bytes === null
    || (typeof bytes === 'number' && Number.isInteger(bytes) && bytes >= 0)
  if (typeof candidate.phase !== 'string' || !phases.has(candidate.phase as LocalServiceInstallPhase)
    || typeof candidate.available !== 'boolean'
    || typeof candidate.stage !== 'string' || !stages.has(candidate.stage as LocalServiceInstallStage)
    || typeof candidate.message !== 'string'
    || typeof candidate.platform !== 'string'
    || typeof candidate.installPath !== 'string'
    || !(candidate.progressPercent === null
      || (typeof candidate.progressPercent === 'number'
        && Number.isInteger(candidate.progressPercent)
        && candidate.progressPercent >= 0
        && candidate.progressPercent <= 100))
    || !validBytes(candidate.completedBytes)
    || !validBytes(candidate.totalBytes)) {
    throw new Error('local service installer returned invalid status')
  }
  return {
    available: candidate.available,
    phase: candidate.phase as LocalServiceInstallPhase,
    stage: candidate.stage as LocalServiceInstallStage,
    message: candidate.message,
    progressPercent: candidate.progressPercent as number | null,
    completedBytes: candidate.completedBytes as number | null,
    totalBytes: candidate.totalBytes as number | null,
    platform: candidate.platform,
    installPath: candidate.installPath,
  }
}

export function parseLocalServiceStatus(value: unknown): LocalServiceStatus {
  if (typeof value !== 'object' || value === null) throw new Error('local service returned invalid status')
  const candidate = value as Record<string, unknown>
  const phases = new Set<LocalServicePhase>(['stopped', 'starting', 'running', 'stopping', 'error'])
  const stages = new Set<LocalServiceStage>([
    'idle',
    'checking-runtime',
    'starting-process',
    'checking-model',
    'downloading-model',
    'loading-model',
    'checking-health',
    'ready',
    'external',
    'stopping',
    'failed',
  ])
  if (typeof candidate.phase !== 'string' || !phases.has(candidate.phase as LocalServicePhase)
    || typeof candidate.stage !== 'string' || !stages.has(candidate.stage as LocalServiceStage)
    || typeof candidate.endpoint !== 'string'
    || typeof candidate.managed !== 'boolean'
    || typeof candidate.message !== 'string'
    || !(candidate.progressPercent === null
      || (typeof candidate.progressPercent === 'number'
        && Number.isInteger(candidate.progressPercent)
        && candidate.progressPercent >= 0
        && candidate.progressPercent <= 100))
    || !(candidate.elapsedSeconds === null
      || (typeof candidate.elapsedSeconds === 'number'
        && Number.isInteger(candidate.elapsedSeconds)
        && candidate.elapsedSeconds >= 0))) {
    throw new Error('local service returned invalid status')
  }
  return {
    phase: candidate.phase as LocalServicePhase,
    stage: candidate.stage as LocalServiceStage,
    endpoint: candidate.endpoint,
    managed: candidate.managed,
    message: candidate.message,
    progressPercent: candidate.progressPercent as number | null,
    elapsedSeconds: candidate.elapsedSeconds as number | null,
  }
}
