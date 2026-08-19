export const LOCAL_SERVICE_ENDPOINT = 'http://127.0.0.1:39081'

export type LocalServicePhase = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

/** Browser-safe status returned by the trusted host controller. */
export interface LocalServiceStatus {
  readonly phase: LocalServicePhase
  readonly endpoint: string
  readonly managed: boolean
  readonly message: string
}

export interface LocalServiceStartRequest {
  readonly origin: string
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

export function parseLocalServiceStatus(value: unknown): LocalServiceStatus {
  if (typeof value !== 'object' || value === null) throw new Error('local service returned invalid status')
  const candidate = value as Record<string, unknown>
  const phases = new Set<LocalServicePhase>(['stopped', 'starting', 'running', 'stopping', 'error'])
  if (typeof candidate.phase !== 'string' || !phases.has(candidate.phase as LocalServicePhase)
    || typeof candidate.endpoint !== 'string'
    || typeof candidate.managed !== 'boolean'
    || typeof candidate.message !== 'string') {
    throw new Error('local service returned invalid status')
  }
  return {
    phase: candidate.phase as LocalServicePhase,
    endpoint: candidate.endpoint,
    managed: candidate.managed,
    message: candidate.message,
  }
}
