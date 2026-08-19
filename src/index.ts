import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { SessionStore } from '@deepseek-ai/dsh-session'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { extractContextTermsForRequest } from './term-extraction.ts'
import { parsePolishRequest, polishTranscript } from './polish.ts'
import { DICTATE_SETTINGS_NAMESPACE } from './settings-contract.ts'
import { parseContextTermsRequest } from './terms.ts'
import { LocalServiceController } from './local-service.ts'
import { parseLocalServiceStartRequest } from './local-service-contract.ts'

/** Cordis plugin name used by the profile bundle patch. */
export const name = 'dsh-dictate'

/** Settings namespace used to pair the RC7 Host plugin with its browser card. */
const DICTATE_SETTINGS_NS = settingsNamespace(DICTATE_SETTINGS_NAMESPACE)

/** Host configuration remains empty because dictation preferences are browser-local. */
export interface Config {}

export const Config: z<Config> = z.object({})

/** Host services used by the browser-safe Contextual Dictation RPC. */
export const inject = ['connection', 'llm', 'sessions']

/** Register trusted-host terminology and transcript-polishing endpoints. */
export function apply(ctx: Context, config: Config = {}): void {
  const host = ctx as Context & {
    readonly connection: HostConnectionHandle
    readonly llm: LlmRuntime
    readonly sessions: SessionStore
  }
  const localService = new LocalServiceController()
  ctx.effect(() => () => localService.dispose(), 'dictate: stop managed local ASR on plugin disposal')
  ctx.effect(() => host.connection.rpc.handle('/dictate', async (endpoint, payload, signal) => {
    try {
      if (endpoint === 'local-service-status') {
        return { ok: true, value: await localService.status() }
      }
      if (endpoint === 'local-service-start') {
        const request = parseLocalServiceStartRequest(payload)
        return { ok: true, value: await localService.start(request.origin) }
      }
      if (endpoint === 'local-service-stop') {
        return { ok: true, value: await localService.stop() }
      }
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
  }, { authority: 'trusted-host' }), 'dictate: contextual terminology and model polish RPC')
  installSettingsSection(ctx, DICTATE_SETTINGS_NS, Config, config, {
    setSource() {
      // Dictation preferences intentionally remain local to each browser.
    },
    onChange() {},
  })
}
