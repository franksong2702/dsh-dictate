import type { Context } from '@deepseek-ai/cordis'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { SessionStore } from '@deepseek-ai/dsh-session'
import { parsePolishRequest, polishTranscript } from './polish.ts'

/** Cordis plugin name used by the profile bundle patch. */
export const name = 'dsh-voice-input'

/** Host services used by the browser-safe transcript polishing RPC. */
export const inject = ['connection', 'llm', 'sessions']

/** Register the trusted-host transcript polishing endpoint. */
export function apply(ctx: Context): void {
  const host = ctx as Context & {
    readonly connection: HostConnectionHandle
    readonly llm: LlmRuntime
    readonly sessions: SessionStore
  }
  ctx.effect(() => host.connection.rpc.handle('/voice-input', async (endpoint, payload, signal) => {
    if (endpoint !== 'polish') {
      return { ok: false, error: { code: 'internal', message: `unknown Voice Input endpoint: ${endpoint}`, details: {} } }
    }
    try {
      const value = await polishTranscript(host, parsePolishRequest(payload), signal)
      return { ok: true, value }
    } catch (error: unknown) {
      if (signal.aborted) {
        return { ok: false, error: { code: 'cancelled', message: 'model polish was cancelled', details: {} } }
      }
      return {
        ok: false,
        error: {
          code: 'internal',
          message: error instanceof Error ? error.message : 'model polish failed',
          details: {},
        },
      }
    }
  }, { authority: 'trusted-host' }), 'voice-input: model polish RPC')
}
