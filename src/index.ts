import type { Context } from '@deepseek-ai/cordis'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { SessionStore } from '@deepseek-ai/dsh-session'
import { extractContextTermsForRequest } from './term-extraction.ts'
import { parsePolishRequest, polishTranscript } from './polish.ts'
import { parseContextTermsRequest } from './terms.ts'

/** Cordis plugin name used by the profile bundle patch. */
export const name = 'dsh-contextual-dictation'

/** Host services used by the browser-safe Contextual Dictation RPC. */
export const inject = ['connection', 'llm', 'sessions']

/** Register trusted-host terminology and transcript-polishing endpoints. */
export function apply(ctx: Context): void {
  const host = ctx as Context & {
    readonly connection: HostConnectionHandle
    readonly llm: LlmRuntime
    readonly sessions: SessionStore
  }
  ctx.effect(() => host.connection.rpc.handle('/contextual-dictation', async (endpoint, payload, signal) => {
    try {
      if (endpoint === 'terms') {
        const request = parseContextTermsRequest(payload)
        return { ok: true, value: {
          terms: await extractContextTermsForRequest(host, request, signal),
        } }
      }
      if (endpoint !== 'polish') {
        throw new Error(`unknown Contextual Dictation endpoint: ${endpoint}`)
      }
      const value = await polishTranscript(host, parsePolishRequest(payload), signal)
      return { ok: true, value }
    } catch (error: unknown) {
      if (signal.aborted) {
        return { ok: false, error: { code: 'cancelled', message: 'Contextual Dictation request was cancelled', details: {} } }
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
  }, { authority: 'trusted-host' }), 'contextual-dictation: contextual terminology and model polish RPC')
}
