import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { SessionStore } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-settings'
import { extractContextTermsForRequest } from './term-extraction.ts'
import { parsePolishRequest, polishTranscript } from './polish.ts'
import { DICTATE_SETTINGS_NAMESPACE } from './settings-contract.ts'
import { parseContextTermsRequest } from './terms.ts'
import { LocalServiceAutoStartManager, LocalServiceController } from './local-service.ts'
import { LocalServiceInstaller } from './local-service-installer.ts'
import {
  parseLocalServiceAutoStartRequest,
  parseLocalServiceStartRequest,
} from './local-service-contract.ts'

/** Cordis plugin name used by the profile bundle patch. */
export const name = 'dsh-dictate'

/** Settings namespace used to pair the Host plugin with its browser card. */
const DICTATE_SETTINGS_NS = DICTATE_SETTINGS_NAMESPACE

/** Host-persisted service lifecycle settings; recognition preferences remain browser-local. */
export interface Config {
  readonly localServiceAutoStart: boolean
  readonly localServiceOrigin: string
}

export const Config: z<Config> = z.object({
  localServiceAutoStart: z.boolean().default(false),
  localServiceOrigin: z.string().default(''),
})

const DEFAULT_CONFIG: Config = {
  localServiceAutoStart: false,
  localServiceOrigin: '',
}

function validateConfig(config: Config): void {
  if (config.localServiceOrigin !== '') {
    parseLocalServiceStartRequest({ origin: config.localServiceOrigin })
  } else if (config.localServiceAutoStart) {
    throw new Error('localServiceOrigin must be a loopback URL when auto-start is enabled')
  }
}

/** Host services used by the browser-safe Contextual Dictation RPC. */
export const inject = ['connection', 'llm', 'sessions', 'settings']

/** Register trusted-host terminology and transcript-polishing endpoints. */
export function apply(ctx: Context, config: Config = DEFAULT_CONFIG): void {
  const host = ctx as Context & {
    readonly connection: HostConnectionHandle
    readonly llm: LlmRuntime
    readonly sessions: SessionStore
  }
  const installer = new LocalServiceInstaller()
  const localService = new LocalServiceController(undefined, installer.available
    ? {
        executable: installer.executablePath,
        workingDirectory: installer.installRoot,
        modelPath: installer.modelPath,
      }
    : {})
  const startValidatedLocalService = async (origin: string, signal?: AbortSignal) => {
    const installStatus = await installer.status()
    if (installStatus.phase !== 'installed') {
      throw new Error('本地语音识别需要先在插件设置中完成安装或更新')
    }
    return localService.start(origin, signal)
  }
  const autoStart = new LocalServiceAutoStartManager({
    status: () => localService.status(),
    start: origin => startValidatedLocalService(origin),
    stop: () => localService.stop(),
  })
  let currentConfig = (): Config => config
  let stopped = false
  let reconcileTail = Promise.resolve()
  const scheduleAutoStart = (): void => {
    reconcileTail = reconcileTail.then(async () => {
      if (stopped) return
      await autoStart.reconcile(currentConfig())
    }, async () => {
      if (stopped) return
      await autoStart.reconcile(currentConfig())
    }).catch((error: unknown) => {
      ctx.logger.warn('dsh-dictate: local ASR auto-start failed')
      ctx.logger.warn(error)
    })
  }
  ctx.effect(() => async () => {
    stopped = true
    await reconcileTail
    await localService.dispose()
    await installer.dispose()
  }, 'dictate: stop managed local ASR on plugin disposal')
  ctx.effect(() => host.connection.rpc.handle('/dictate', async (endpoint, payload, signal) => {
    try {
      if (endpoint === 'local-service-status') {
        return { ok: true, value: await localService.status() }
      }
      if (endpoint === 'local-service-start') {
        const request = parseLocalServiceStartRequest(payload)
        return { ok: true, value: await startValidatedLocalService(request.origin, signal) }
      }
      if (endpoint === 'local-service-stop') {
        return { ok: true, value: await localService.stop() }
      }
      if (endpoint === 'local-service-install-status') {
        return { ok: true, value: await installer.status() }
      }
      if (endpoint === 'local-service-install-start') {
        const request = parseLocalServiceStartRequest(payload)
        return {
          ok: true,
          value: await installer.start(async installSignal => {
            await startValidatedLocalService(request.origin, installSignal)
          }),
        }
      }
      if (endpoint === 'local-service-install-cancel') {
        return { ok: true, value: await installer.cancel() }
      }
      if (endpoint === 'local-service-autostart-status') {
        const current = currentConfig()
        return { ok: true, value: {
          enabled: current.localServiceAutoStart,
          origin: current.localServiceOrigin,
        } }
      }
      if (endpoint === 'local-service-autostart-set') {
        const request = parseLocalServiceAutoStartRequest(payload)
        await host.settings.update(DICTATE_SETTINGS_NS, {
          localServiceAutoStart: request.enabled,
          localServiceOrigin: request.origin,
        })
        return { ok: true, value: request }
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
  }), 'dictate: contextual terminology and model polish RPC')
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, DICTATE_SETTINGS_NS, Config, config, {
      setSource(source) { currentConfig = source },
      onChange: scheduleAutoStart,
      validate: validateConfig,
    })
  })
}
