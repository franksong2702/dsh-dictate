import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { SettingsPanel, type ModelOption } from './SettingsPanel.tsx'
import {
  formatRecordingDuration,
  TRANSCRIPTION_COMPLETE_VISIBLE_MS,
  TranscriptionDock,
} from './TranscriptionDock.tsx'
import { DEFAULT_LOCAL_ENDPOINT, loadPrefs, subscribePrefs, updatePrefs } from './prefs.ts'
import {
  checkLocalEndpoint as checkLocalEndpointHealth,
  createLocalEndpointProvider,
} from './localEndpointProvider.ts'
import { createWebSpeechProvider } from './webSpeechProvider.ts'
import {
  asrProviderError,
  type AsrContextTerm,
  type AsrProvider,
  type AsrProviderError,
  type AsrProviderSession,
  type AsrProviderStartOptions,
} from './asrProvider.ts'
import {
  getTranscriptionSnapshot,
  resetTranscription,
  updateTranscription,
  upsertTranscriptionEvent,
  type TranscriptionPhase,
  type TranscriptionTimelineEvent,
} from './transcriptionStore.ts'
import {
  parseContextTerms,
  type ContextTerm,
  type ContextTermsRequest,
} from '../terms.ts'
import { DICTATE_SETTINGS_NAMESPACE } from '../settings-contract.ts'
import {
  parseLocalServiceAutoStartSettings,
  parseLocalServiceInstallStatus,
  parseLocalServiceStatus,
  type LocalServiceAutoStartSettings,
  type LocalServiceInstallStatus,
  type LocalServiceStatus,
} from '../local-service-contract.ts'

/*
 * DSH 0.1.1-rc.2 renders this session-scoped slot at runtime but omits it from
 * the published SlotMap declaration. Keep the bridge exact so a future host
 * declaration either merges cleanly or produces a useful contract mismatch.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'conversation.input.overlay': {
      kind: 'list'
      scope: 'session'
    }
  }
}

interface InputActions {
  setDraft(text: string): void
  submit(): void
}

interface VoiceInputProps {
  readonly inputActions: InputActions
  readonly input: {
    readonly draft: string
    readonly phase?: 'plain' | 'adjudicating' | 'claimed' | 'submitting'
  }
  readonly sessionId: string
  readonly polish?: (request: PolishClientRequest, signal: AbortSignal) => Promise<string>
  readonly loadContextTerms?: (
    request: ContextTermsRequest,
    signal: AbortSignal,
  ) => Promise<readonly ContextTerm[]>
  readonly checkLocalEndpoint?: (endpoint: string, signal: AbortSignal) => Promise<string>
  /** Test seam and future host override for the two user-selectable routes. */
  readonly providers?: Partial<Record<'web-speech' | 'local-endpoint', AsrProvider>>
}

interface PolishClientRequest {
  readonly sessionId: string
  readonly provider: string
  readonly model: string
  readonly transcript: string
  readonly terms: readonly ContextTerm[]
}

interface ModelReference {
  readonly provider: string
  readonly model: string
}

/** Client services used by the composer contribution. */
export const inject = ['connection', 'slots']

/** Encode provider and model as an opaque select value without delimiter assumptions. */
export function encodeModelReference(reference: ModelReference): string {
  return JSON.stringify([reference.provider, reference.model])
}

/** Decode one browser-local model selection before it crosses the RPC boundary. */
export function decodeModelReference(value: string): ModelReference | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed) || parsed.length !== 2
      || typeof parsed[0] !== 'string' || parsed[0] === ''
      || typeof parsed[1] !== 'string' || parsed[1] === '') return undefined
    return { provider: parsed[0], model: parsed[1] }
  } catch {
    return undefined
  }
}

/** Join recognition segments without inserting spaces into CJK dictation. */
export function joinRecognitionSegments(segments: readonly string[], lang: string): string {
  const values = segments.map(segment => segment.trim()).filter(segment => segment !== '')
  return values.join(/^(?:zh|ja|ko)(?:-|$)/i.test(lang) ? '' : ' ')
}

function rightModifierCode(userAgent: string): 'MetaRight' | 'ControlRight' {
  return /\bMacintosh\b|\bMac OS X\b/i.test(userAgent) ? 'MetaRight' : 'ControlRight'
}

function contextTermsKey(
  request: ContextTermsRequest,
  composerPhase: VoiceInputProps['input']['phase'],
): string {
  return JSON.stringify([
    request.sessionId,
    request.draft,
    composerPhase ?? '',
    request.includeInferred,
    request.model ?? null,
  ])
}

const WEB_SPEECH_PROVIDER = createWebSpeechProvider()
export const DICTATION_WARNING_MS = 8 * 60 * 1_000
export const DICTATION_MAX_DURATION_MS = 9 * 60 * 1_000
export const MEANINGFUL_TRANSCRIPTION_STAGE_MS = 3_000

const COUNTDOWN_ANNOUNCEMENT_SECONDS = new Set([60, 30, 10, 5, 4, 3, 2, 1])

function countdownText(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000))
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

function providerErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error
    && typeof (error as AsrProviderError).message === 'string') {
    return (error as AsrProviderError).message
  }
  return '无法启动语音输入'
}

function VoiceInputSettings({ loadModels, localService }: {
  readonly loadModels: () => Promise<readonly ModelOption[]>
  readonly localService: {
    readonly status: (signal: AbortSignal) => Promise<LocalServiceStatus>
    readonly start: (signal: AbortSignal) => Promise<LocalServiceStatus>
    readonly stop: (signal: AbortSignal) => Promise<LocalServiceStatus>
    readonly install: {
      readonly status: (signal: AbortSignal) => Promise<LocalServiceInstallStatus>
      readonly start: (signal: AbortSignal) => Promise<LocalServiceInstallStatus>
      readonly cancel: (signal: AbortSignal) => Promise<LocalServiceInstallStatus>
    }
    readonly autoStart: {
      readonly get: (signal: AbortSignal) => Promise<LocalServiceAutoStartSettings>
      readonly set: (enabled: boolean, signal: AbortSignal) => Promise<LocalServiceAutoStartSettings>
    }
  }
}): ReactNode {
  const [modelOptions, setModelOptions] = useState<readonly ModelOption[]>([])
  useEffect(() => {
    let active = true
    void loadModels().then((options) => {
      if (!active) return
      setModelOptions(options)
      const selected = loadPrefs().selectedModel
      if (selected !== '' && !options.some(option => option.value === selected)) {
        updatePrefs({ selectedModel: '' })
      }
    }, () => {
      if (active) setModelOptions([])
    })
    return () => { active = false }
  }, [loadModels])
  return <SettingsPanel
    modelOptions={modelOptions}
    localService={localService}
  />
}

/** Register one manual dictation button immediately before the send action. */
export function apply(ctx: ClientContext): void {
  const connection = (ctx as ClientContext & { readonly connection: ConnectionHandle }).connection
  const loadModels = async (): Promise<readonly ModelOption[]> => {
    const response = await connection.api.llm.models({})
    if (!response.result.ok) throw new Error(response.result.error.message)
    return response.result.value.groups.flatMap(group => group.models.map(model => ({
      value: encodeModelReference({ provider: group.id, model: model.id }),
      label: `${model.name} · ${group.name}`,
    })))
  }
  const polish = async (request: PolishClientRequest, signal: AbortSignal): Promise<string> => {
    const result = await connection.rpc.call('/dictate', 'polish', request, signal)
    if (!result.ok) throw new Error(result.error.message)
    const value = result.value
    if (typeof value !== 'object' || value === null || !('text' in value)
      || typeof (value as { text?: unknown }).text !== 'string'
      || (value as { text: string }).text.trim() === '') {
      throw new Error('model polish returned an invalid result')
    }
    return (value as { text: string }).text.trim()
  }
  const loadContextTerms = async (
    request: ContextTermsRequest,
    signal: AbortSignal,
  ): Promise<readonly ContextTerm[]> => {
    const result = await connection.rpc.call('/dictate', 'terms', request, signal)
    if (!result.ok) throw new Error(result.error.message)
    const value = result.value
    if (typeof value !== 'object' || value === null || !('terms' in value)) {
      throw new Error('context terms returned an invalid result')
    }
    return parseContextTerms((value as { readonly terms?: unknown }).terms)
  }
  const testEndpoint = (endpoint: string, signal: AbortSignal): Promise<string> =>
    checkLocalEndpointHealth(endpoint, signal)
  const callLocalService = async (
    endpoint: 'local-service-status' | 'local-service-start' | 'local-service-stop',
    signal: AbortSignal,
  ): Promise<LocalServiceStatus> => {
    const payload = endpoint === 'local-service-start' ? { origin: window.location.origin } : {}
    const result = await connection.rpc.call('/dictate', endpoint, payload, signal)
    if (!result.ok) throw new Error(result.error.message)
    return parseLocalServiceStatus(result.value)
  }
  const callLocalServiceAutoStart = async (
    endpoint: 'local-service-autostart-status' | 'local-service-autostart-set',
    enabled: boolean | undefined,
    signal: AbortSignal,
  ): Promise<LocalServiceAutoStartSettings> => {
    const payload = endpoint === 'local-service-autostart-set'
      ? { enabled, origin: window.location.origin }
      : {}
    const result = await connection.rpc.call('/dictate', endpoint, payload, signal)
    if (!result.ok) throw new Error(result.error.message)
    return parseLocalServiceAutoStartSettings(result.value)
  }
  const callLocalServiceInstall = async (
    endpoint: 'local-service-install-status' | 'local-service-install-start' | 'local-service-install-cancel',
    signal: AbortSignal,
  ): Promise<LocalServiceInstallStatus> => {
    const payload = endpoint === 'local-service-install-start'
      ? { origin: window.location.origin }
      : {}
    const result = await connection.rpc.call('/dictate', endpoint, payload, signal)
    if (!result.ok) throw new Error(result.error.message)
    return parseLocalServiceInstallStatus(result.value)
  }
  const localService = {
    status: (signal: AbortSignal) => callLocalService('local-service-status', signal),
    start: (signal: AbortSignal) => callLocalService('local-service-start', signal),
    stop: (signal: AbortSignal) => callLocalService('local-service-stop', signal),
    install: {
      status: (signal: AbortSignal) => callLocalServiceInstall('local-service-install-status', signal),
      start: (signal: AbortSignal) => callLocalServiceInstall('local-service-install-start', signal),
      cancel: (signal: AbortSignal) => callLocalServiceInstall('local-service-install-cancel', signal),
    },
    autoStart: {
      get: (signal: AbortSignal) => callLocalServiceAutoStart('local-service-autostart-status', undefined, signal),
      set: (enabled: boolean, signal: AbortSignal) =>
        callLocalServiceAutoStart('local-service-autostart-set', enabled, signal),
    },
  }
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'dictate-recorder',
    order: 10,
  }, props => <VoiceInputButton
    {...props as VoiceInputProps}
    polish={polish}
    loadContextTerms={loadContextTerms}
    checkLocalEndpoint={testEndpoint}
  />))
  ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
    name: 'conversation.input.overlay',
    id: 'dictate-transcription',
    order: 90,
  }, props => <TranscriptionDock sessionId={props.sessionId} />))
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: DICTATE_SETTINGS_NAMESPACE,
  }, () => <VoiceInputSettings
    loadModels={loadModels}
    localService={localService}
  />))
}

/** Manual click-to-start, click-to-stop dictation control. */
export function VoiceInputButton({
  inputActions,
  input,
  sessionId,
  polish,
  loadContextTerms,
  checkLocalEndpoint,
  providers,
}: VoiceInputProps) {
  const [recording, setRecording] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const prefs = useSyncExternalStore(subscribePrefs, loadPrefs, () => loadPrefs())
  const sessionRef = useRef<AsrProviderSession>()
  const activeProviderRef = useRef<'web-speech' | 'local-endpoint'>()
  const startAbortRef = useRef<AbortController>()
  const draftRef = useRef(input.draft)
  const actionsRef = useRef(inputActions)
  const failedRef = useRef(false)
  const finalizingRef = useRef(false)
  const automaticStopRef = useRef(false)
  const messageTimerRef = useRef<number>()
  const permissionStatusTimerRef = useRef<number>()
  const warningTimerRef = useRef<number>()
  const countdownTimerRef = useRef<number>()
  const deadlineTimerRef = useRef<number>()
  const dictationStartedAtRef = useRef<number>()
  const recordingElapsedMsRef = useRef<number | null>(null)
  const countdownActiveRef = useRef(false)
  const finalizingStartedAtRef = useRef<number>()
  const polishAbortRef = useRef<AbortController>()
  const contextTermsRef = useRef<readonly ContextTerm[]>([])
  const contextTermsKeyRef = useRef<string>()
  const termsDebounceTimerRef = useRef<number>()
  const termsRequestRef = useRef<{
    readonly key: string
    readonly controller: AbortController
    readonly promise: Promise<readonly ContextTerm[]>
  }>()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const toggleRef = useRef<() => void>(() => {})
  draftRef.current = input.draft
  actionsRef.current = inputActions

  const injectedProvider = providers?.[prefs.transcriptionProvider]
  const supported = sessionRef.current !== undefined || startAbortRef.current !== undefined
    || injectedProvider !== undefined || (prefs.transcriptionProvider === 'web-speech'
    ? typeof window !== 'undefined'
      && (window.SpeechRecognition !== undefined || window.webkitSpeechRecognition !== undefined)
    : typeof window !== 'undefined'
      && navigator.mediaDevices?.getUserMedia !== undefined
      && (window.AudioContext !== undefined
        || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext !== undefined)
      && typeof window.fetch === 'function')
  const contextOptimizationEnabled = prefs.mixedLanguageOptimizationEnabled && prefs.lang.startsWith('zh-')
  const selectedModel = prefs.modelPolishEnabled ? decodeModelReference(prefs.selectedModel) : undefined
  const contextTermsRequest: ContextTermsRequest = {
    sessionId,
    draft: input.draft,
    includeInferred: contextOptimizationEnabled,
    ...(selectedModel === undefined ? {} : { model: selectedModel }),
  }
  const contextTermsRequestKey = contextTermsKey(contextTermsRequest, input.phase)
  const shouldLoadContextTerms = loadContextTerms !== undefined
    && (contextOptimizationEnabled || selectedModel !== undefined)

  const requestContextTermsRef = useRef<(
    request: ContextTermsRequest,
    key: string,
  ) => Promise<readonly ContextTerm[]>>(() => Promise.resolve([]))
  requestContextTermsRef.current = (request, key) => {
    if (loadContextTerms === undefined) return Promise.resolve([])
    const current = termsRequestRef.current
    if (current?.key === key) return current.promise
    current?.controller.abort()
    const controller = new AbortController()
    const promise = loadContextTerms(request, controller.signal).then((terms) => {
      if (!controller.signal.aborted) {
        contextTermsRef.current = terms
        contextTermsKeyRef.current = key
      }
      return terms
    })
    const requestState = { key, controller, promise }
    termsRequestRef.current = requestState
    void promise.then(() => {
      if (termsRequestRef.current === requestState) termsRequestRef.current = undefined
    }, () => {
      if (termsRequestRef.current === requestState) termsRequestRef.current = undefined
    })
    return promise
  }

  const clearTermsDebounce = (): void => {
    if (termsDebounceTimerRef.current === undefined) return
    window.clearTimeout(termsDebounceTimerRef.current)
    termsDebounceTimerRef.current = undefined
  }

  const clearMessageTimer = (): void => {
    if (messageTimerRef.current === undefined) return
    window.clearTimeout(messageTimerRef.current)
    messageTimerRef.current = undefined
  }

  const clearPermissionStatusTimer = (): void => {
    if (permissionStatusTimerRef.current === undefined) return
    window.clearTimeout(permissionStatusTimerRef.current)
    permissionStatusTimerRef.current = undefined
  }

  const clearDictationTimers = (): void => {
    if (warningTimerRef.current !== undefined) window.clearTimeout(warningTimerRef.current)
    if (countdownTimerRef.current !== undefined) window.clearInterval(countdownTimerRef.current)
    if (deadlineTimerRef.current !== undefined) window.clearTimeout(deadlineTimerRef.current)
    warningTimerRef.current = undefined
    countdownTimerRef.current = undefined
    deadlineTimerRef.current = undefined
    countdownActiveRef.current = false
  }

  const currentRecordingElapsedMs = (): number | null => {
    const startedAt = dictationStartedAtRef.current
    if (startedAt === undefined) return recordingElapsedMsRef.current
    return Math.min(DICTATION_MAX_DURATION_MS, Math.max(0, Date.now() - startedAt))
  }

  const freezeRecordingClock = (elapsedOverride?: number): number | null => {
    const elapsed = elapsedOverride ?? currentRecordingElapsedMs()
    clearDictationTimers()
    dictationStartedAtRef.current = undefined
    recordingElapsedMsRef.current = elapsed
    if (elapsed !== null) updateTranscription(sessionId, { recordingElapsedMs: elapsed })
    return elapsed
  }

  const addTimelineEvent = (
    id: string,
    phase: Exclude<TranscriptionPhase, 'idle'>,
    label: string,
    detail: string,
    tone: TranscriptionTimelineEvent['tone'],
    elapsedMs: number | null = currentRecordingElapsedMs(),
  ): void => {
    upsertTranscriptionEvent(sessionId, { id, phase, label, detail, tone, elapsedMs })
  }

  const recordingStopDetail = (elapsedMs: number | null, reason: string): string => (
    `录音时长 ${formatRecordingDuration(elapsedMs ?? 0)} · ${reason}`
  )

  const finishFinalizingStage = (retainAsHistory: boolean): void => {
    const startedAt = finalizingStartedAtRef.current
    finalizingStartedAtRef.current = undefined
    if (!retainAsHistory || startedAt === undefined
      || Date.now() - startedAt < MEANINGFUL_TRANSCRIPTION_STAGE_MS) return
    addTimelineEvent(
      'transcription-complete',
      'finalizing',
      '转写已完成',
      '已生成初步转写',
      'complete',
      null,
    )
  }

  const startDictationTimers = (localMode: boolean): void => {
    clearDictationTimers()
    const startedAt = Date.now()
    const deadline = startedAt + DICTATION_MAX_DURATION_MS
    dictationStartedAtRef.current = startedAt
    recordingElapsedMsRef.current = 0
    countdownActiveRef.current = false
    updateTranscription(sessionId, { recordingElapsedMs: 0 })
    const updateClock = (): void => {
      const elapsedMs = Math.min(DICTATION_MAX_DURATION_MS, Math.max(0, Date.now() - startedAt))
      recordingElapsedMsRef.current = elapsedMs
      const patch: {
        recordingElapsedMs: number
        phase?: 'listening'
        status?: string
        hint?: string
        action?: null
        announcement?: string
      } = { recordingElapsedMs: elapsedMs }
      if (countdownActiveRef.current) {
        const remainingMs = Math.max(0, deadline - Date.now())
        const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1_000))
        const detail = `${countdownText(remainingMs)} 后自动结束并转写`
        patch.phase = 'listening'
        patch.status = localMode ? '正在录音中' : '正在听写中'
        patch.hint = detail
        patch.action = null
        if (COUNTDOWN_ANNOUNCEMENT_SECONDS.has(remainingSeconds)) {
          patch.announcement = `${patch.status}。${remainingSeconds} 秒后自动结束并转写`
        }
      }
      updateTranscription(sessionId, patch)
    }
    countdownTimerRef.current = window.setInterval(updateClock, 1_000)
    warningTimerRef.current = window.setTimeout(() => {
      warningTimerRef.current = undefined
      if (finalizingRef.current || sessionRef.current === undefined) return
      countdownActiveRef.current = true
      updateClock()
    }, DICTATION_WARNING_MS)
    deadlineTimerRef.current = window.setTimeout(() => {
      const activeSession = sessionRef.current
      if (activeSession === undefined || finalizingRef.current) return
      freezeRecordingClock(DICTATION_MAX_DURATION_MS)
      automaticStopRef.current = true
      finalizingRef.current = true
      finalizingStartedAtRef.current = Date.now()
      setRecording(false)
      setPreparing(localMode)
      addTimelineEvent(
        'recording-stop',
        'finalizing',
        '录音已结束',
        recordingStopDetail(DICTATION_MAX_DURATION_MS, '已达到时长上限'),
        'complete',
        DICTATION_MAX_DURATION_MS,
      )
      updateTranscription(sessionId, {
        phase: 'finalizing',
        status: localMode ? '正在转写中' : '正在确认中',
        hint: localMode
          ? '已达到 9 分钟上限，正在处理录音…'
          : '已达到 9 分钟上限，正在确认识别结果…',
        announcement: localMode
          ? '正在转写中。录音时长 9 分钟，正在处理最后一段录音'
          : '正在确认中。录音时长 9 分钟，正在确认识别结果',
        action: null,
      })
      void activeSession.stop()
    }, DICTATION_MAX_DURATION_MS)
  }

  const showTransientMessage = (title: string, detail: string, error = false): void => {
    clearMessageTimer()
    clearPermissionStatusTimer()
    freezeRecordingClock()
    finishFinalizingStage(false)
    addTimelineEvent(
      error ? 'error' : 'complete',
      error ? 'error' : 'complete',
      title,
      detail,
      error ? 'error' : 'complete',
    )
    updateTranscription(sessionId, {
      phase: error ? 'error' : 'complete',
      finalText: '',
      interimText: '',
      status: title,
      hint: detail,
      announcement: `${title}。${detail}`,
      action: null,
    })
    if (!error) {
      messageTimerRef.current = window.setTimeout(() => {
        resetTranscription(sessionId)
        messageTimerRef.current = undefined
      }, TRANSCRIPTION_COMPLETE_VISIBLE_MS)
    }
  }

  useEffect(() => () => {
    clearMessageTimer()
    clearPermissionStatusTimer()
    clearDictationTimers()
    clearTermsDebounce()
    startAbortRef.current?.abort()
    startAbortRef.current = undefined
    void sessionRef.current?.abort()
    sessionRef.current = undefined
    activeProviderRef.current = undefined
    polishAbortRef.current?.abort()
    polishAbortRef.current = undefined
    termsRequestRef.current?.controller.abort()
    termsRequestRef.current = undefined
    contextTermsRef.current = []
    contextTermsKeyRef.current = undefined
    finalizingRef.current = false
    automaticStopRef.current = false
    finalizingStartedAtRef.current = undefined
    dictationStartedAtRef.current = undefined
    recordingElapsedMsRef.current = null
    resetTranscription(sessionId)
  }, [sessionId])

  useEffect(() => {
    clearTermsDebounce()
    if (!shouldLoadContextTerms) {
      const current = termsRequestRef.current
      current?.controller.abort()
      termsRequestRef.current = undefined
      contextTermsRef.current = []
      contextTermsKeyRef.current = undefined
      return
    }
    const current = termsRequestRef.current
    if (current !== undefined && current.key !== contextTermsRequestKey) {
      current.controller.abort()
      termsRequestRef.current = undefined
    }
    const timer = window.setTimeout(() => {
      termsDebounceTimerRef.current = undefined
      void requestContextTermsRef.current(contextTermsRequest, contextTermsRequestKey).catch(() => {
        // Context-term extraction is optional; recognition and polishing keep their deterministic fallbacks.
      })
    }, 1000)
    termsDebounceTimerRef.current = timer
    return () => {
      if (termsDebounceTimerRef.current === timer) {
        window.clearTimeout(timer)
        termsDebounceTimerRef.current = undefined
      }
      const request = termsRequestRef.current
      if (request?.key === contextTermsRequestKey) {
        request.controller.abort()
        termsRequestRef.current = undefined
      }
    }
  }, [
    contextTermsRequestKey,
    shouldLoadContextTerms,
  ])

  const insertTranscript = (transcript: string, allowAutomaticSend: boolean): void => {
    const current = draftRef.current.trim()
    const prefix = current === '' ? '' : `${draftRef.current} `
    const nextDraft = `${prefix}${transcript}`
    draftRef.current = nextDraft
    actionsRef.current.setDraft(nextDraft)
    if (allowAutomaticSend) actionsRef.current.submit()
  }

  const termsForPolish = (selected: ModelReference): readonly ContextTerm[] => {
    const request: ContextTermsRequest = {
      sessionId,
      draft: draftRef.current,
      includeInferred: contextOptimizationEnabled,
      model: selected,
    }
    const key = contextTermsKey(request, input.phase)
    if (contextTermsKeyRef.current === key) return contextTermsRef.current
    return []
  }

  const finishTranscript = async (transcript: string, allowAutomaticSend: boolean): Promise<void> => {
    const selected = selectedModel
    if (!prefs.modelPolishEnabled || polish === undefined || selected === undefined) {
      finishFinalizingStage(false)
      insertTranscript(transcript, allowAutomaticSend)
      const polishUnavailable = prefs.modelPolishEnabled && selected === undefined
      showTransientMessage(
        polishUnavailable ? '润色未完成' : '已转写完成',
        allowAutomaticSend
          ? polishUnavailable
            ? '未选择润色模型，原始转写已直接发送'
            : '转写结果已直接发送'
          : polishUnavailable
            ? '请选择润色模型；原始转写已写入输入框'
            : '转写结果已写入输入框，请检查后发送',
        polishUnavailable,
      )
      return
    }
    clearMessageTimer()
    finishFinalizingStage(true)
    updateTranscription(sessionId, {
      phase: 'polishing',
      finalText: transcript,
      interimText: '',
      status: '正在润色中',
      hint: allowAutomaticSend
        ? '初步转写不是最终结果；完成后将直接发送'
        : '初步转写不是最终结果；完成后将写入输入框',
      announcement: allowAutomaticSend
        ? '正在润色中。初步转写不是最终结果，润色后将直接发送'
        : '正在润色中。初步转写不是最终结果，润色后将写入输入框',
    })
    const controller = new AbortController()
    polishAbortRef.current?.abort()
    polishAbortRef.current = controller
    try {
      const terms = termsForPolish(selected)
      const text = await polish({
        sessionId,
        ...selected,
        transcript,
        terms,
      }, controller.signal)
      if (controller.signal.aborted) return
      insertTranscript(text, allowAutomaticSend)
      showTransientMessage(
        '已润色完成',
        allowAutomaticSend ? '最终结果已直接发送' : '最终结果已写入输入框',
      )
    } catch {
      if (controller.signal.aborted) return
      insertTranscript(transcript, allowAutomaticSend)
      showTransientMessage(
        '润色未完成',
        allowAutomaticSend ? '原始转写已直接发送' : '原始转写已写入输入框',
        true,
      )
    } finally {
      if (polishAbortRef.current === controller) polishAbortRef.current = undefined
    }
  }

  const toggle = (): void => {
    const activeSession = sessionRef.current
    if (activeSession !== undefined) {
      if (finalizingRef.current) {
        void activeSession.abort()
        return
      }
      const elapsedMs = freezeRecordingClock()
      automaticStopRef.current = false
      finalizingRef.current = true
      finalizingStartedAtRef.current = Date.now()
      setRecording(false)
      const localMode = activeProviderRef.current === 'local-endpoint'
      setPreparing(localMode)
      addTimelineEvent(
        'recording-stop',
        'finalizing',
        '录音已结束',
        recordingStopDetail(elapsedMs, '用户主动结束'),
        'complete',
        elapsedMs,
      )
      updateTranscription(sessionId, {
        phase: 'finalizing',
        status: localMode ? '正在转写中' : '正在确认中',
        hint: localMode ? '正在处理录音，请稍候…' : '正在确认识别结果，请稍候…',
        announcement: localMode
          ? '正在转写中。正在处理最后一段录音'
          : '正在确认中。正在确认识别结果',
        action: null,
      })
      void activeSession.stop()
      return
    }
    if (startAbortRef.current !== undefined) {
      const retryAfterPreflightError = getTranscriptionSnapshot(sessionId).phase === 'error'
      clearDictationTimers()
      clearPermissionStatusTimer()
      startAbortRef.current.abort()
      startAbortRef.current = undefined
      activeProviderRef.current = undefined
      setPreparing(false)
      resetTranscription(sessionId)
      if (!retryAfterPreflightError) return
    }
    if (!supported) {
      clearMessageTimer()
      resetTranscription(sessionId)
      recordingElapsedMsRef.current = null
      dictationStartedAtRef.current = undefined
      showTransientMessage(
        '转写未完成',
        prefs.transcriptionProvider === 'web-speech'
          ? '当前浏览器不支持语音识别，请使用 Chrome 或 Edge'
          : '当前浏览器不支持本地录音，请使用最新版 Chrome 或 Edge',
        true,
      )
      return
    }

    clearTermsDebounce()
    polishAbortRef.current?.abort()
    polishAbortRef.current = undefined
    clearMessageTimer()
    clearPermissionStatusTimer()
    clearDictationTimers()
    dictationStartedAtRef.current = undefined
    recordingElapsedMsRef.current = null
    resetTranscription(sessionId)
    const termsRequestAtStart: ContextTermsRequest = {
      ...contextTermsRequest,
      draft: draftRef.current,
    }
    const termsKeyAtStart = contextTermsKey(termsRequestAtStart, input.phase)
    const cachedTerms = contextTermsKeyRef.current === termsKeyAtStart
      ? contextTermsRef.current
      : undefined
    const currentTermsRequest = termsRequestRef.current
    if (currentTermsRequest !== undefined && currentTermsRequest.key !== termsKeyAtStart) {
      currentTermsRequest.controller.abort()
      termsRequestRef.current = undefined
    }
    if (cachedTerms === undefined) contextTermsRef.current = []

    let providerId = prefs.transcriptionProvider
    let localMode = providerId === 'local-endpoint'
    let provider = injectedProvider ?? (providerId === 'web-speech'
      ? WEB_SPEECH_PROVIDER
      : createLocalEndpointProvider({ endpoint: DEFAULT_LOCAL_ENDPOINT }))
    const controller = new AbortController()
    startAbortRef.current = controller
    finalizingRef.current = false
    automaticStopRef.current = false
    finalizingStartedAtRef.current = undefined
    failedRef.current = false
    let ended = false
    let fallbackNotice = false
    const finalSegments: string[] = []
    const currentFinalText = (): string => joinRecognitionSegments(finalSegments, prefs.lang)

    activeProviderRef.current = providerId
    if (localMode) {
      setPreparing(true)
    }

    const prepareForLocalMicrophone = (): void => {
      if (!localMode) return
      permissionStatusTimerRef.current = window.setTimeout(() => {
        permissionStatusTimerRef.current = undefined
        if (startAbortRef.current !== controller) return
        updateTranscription(sessionId, {
          phase: 'preparing',
          finalText: '',
          interimText: '',
          status: '等待授权中',
          hint: '请按浏览器提示允许麦克风访问…',
          announcement: '等待授权中。请按浏览器提示允许麦克风访问',
          action: null,
        })
      }, 2000)
    }

    const startOptions: AsrProviderStartOptions = {
      lang: prefs.lang,
      terms: (cachedTerms ?? []) as readonly AsrContextTerm[],
      signal: controller.signal,
      onStart: () => {
        clearMessageTimer()
        clearPermissionStatusTimer()
        setPreparing(false)
        setRecording(true)
        startDictationTimers(localMode)
        updateTranscription(sessionId, {
          phase: 'listening',
          finalText: '',
          interimText: '',
          status: localMode ? '正在录音中' : '正在听写中',
          hint: localMode
            ? '再次点击麦克风结束并转写'
            : fallbackNotice
              ? '本地语音识别暂不可用，本次已改用浏览器语音识别；请开始说话…'
              : '请开始说话…',
          announcement: localMode
            ? '正在录音中。再次点击麦克风结束并转写'
            : fallbackNotice
              ? '正在听写中。本次已改用浏览器语音识别，请开始说话'
              : '正在听写中。请开始说话',
          action: null,
        })
      },
      onInterim: (text) => {
        if (countdownActiveRef.current && !finalizingRef.current) {
          updateTranscription(sessionId, {
            finalText: currentFinalText(),
            interimText: text,
          })
          return
        }
        updateTranscription(sessionId, {
          phase: finalizingRef.current ? 'finalizing' : 'listening',
          finalText: currentFinalText(),
          interimText: text,
          status: finalizingRef.current ? '正在确认中' : '正在听写中',
        })
      },
      onFinal: (text) => {
        if (text.trim() !== '') finalSegments.push(text)
        const showStableText = !localMode || finalizingRef.current
        if (countdownActiveRef.current && !finalizingRef.current) {
          updateTranscription(sessionId, {
            finalText: showStableText ? currentFinalText() : '',
            interimText: '',
          })
          return
        }
        updateTranscription(sessionId, {
          phase: finalizingRef.current ? 'finalizing' : 'listening',
          finalText: showStableText ? currentFinalText() : '',
          interimText: '',
          status: finalizingRef.current
            ? localMode ? '正在转写中' : '正在确认中'
            : localMode ? '正在录音中' : '正在听写中',
        })
      },
      onStatus: (status) => {
        if (status !== 'stopping') return
        setRecording(false)
        setPreparing(localMode)
        updateTranscription(sessionId, {
          phase: 'finalizing',
          status: localMode ? '正在转写中' : '正在确认中',
          hint: localMode ? '正在处理录音，请稍候…' : '正在确认识别结果，请稍候…',
          announcement: automaticStopRef.current
            ? localMode
              ? '正在转写中。录音已达到 9 分钟上限'
              : '正在确认中。录音已达到 9 分钟上限'
            : localMode
              ? '正在转写中。正在处理最后一段录音'
              : '正在确认中。正在确认识别结果',
          action: null,
        })
      },
      onProgress: (progress) => {
        if (progress.message === undefined) return
        if (progress.phase === 'microphone') return
        if (countdownActiveRef.current && !finalizingRef.current) return
        if (progress.phase === 'voice') {
          if (!localMode || finalizingRef.current) return
          updateTranscription(sessionId, {
            phase: 'listening',
            status: '正在录音中',
            hint: '已检测到语音；再次点击麦克风结束并转写',
            announcement: '正在录音中。已检测到语音',
            action: null,
          })
          return
        }
        if (localMode && !finalizingRef.current) return
        clearPermissionStatusTimer()
        updateTranscription(sessionId, {
          phase: 'finalizing',
          status: '正在转写中',
          hint: progress.phase === 'audio'
            ? '正在处理录音，请稍候…'
            : '正在生成转写结果，请稍候…',
          announcement: progress.phase === 'audio'
            ? '正在转写中。正在处理录音'
            : '正在转写中。正在生成转写结果',
          action: null,
        })
      },
      onError: (error) => {
        clearPermissionStatusTimer()
        failedRef.current = true
        showTransientMessage('转写未完成', error.message, true)
      },
      onEnd: (reason) => {
        freezeRecordingClock()
        clearPermissionStatusTimer()
        ended = true
        sessionRef.current = undefined
        activeProviderRef.current = undefined
        startAbortRef.current = undefined
        setRecording(false)
        setPreparing(false)
        const allowAutomaticSend = reason === 'stop' && finalizingRef.current
          && !automaticStopRef.current && prefs.autoSendEnabled
        finalizingRef.current = false
        automaticStopRef.current = false
        const transcript = currentFinalText().trim()
        if (transcript !== '') {
          void finishTranscript(transcript, allowAutomaticSend)
        } else if (!failedRef.current && reason !== 'abort') {
          showTransientMessage('转写未完成', '没有识别到语音，请重试', true)
        } else if (reason === 'abort' && !failedRef.current) {
          resetTranscription(sessionId)
        }
      },
    }
    const acceptSession = (session: AsrProviderSession): void => {
      if (ended || controller.signal.aborted) {
        void session.abort()
        return
      }
      sessionRef.current = session
      startAbortRef.current = undefined
      if (shouldLoadContextTerms) {
        void requestContextTermsRef.current(termsRequestAtStart, termsKeyAtStart).then((terms) => {
          if (sessionRef.current === session) void session.updateTerms(terms)
        }, () => {
          // Context-term extraction is optional; recognition and polishing retain their fallbacks.
        })
      }
    }
    const rejectSession = (error: unknown): void => {
      clearPermissionStatusTimer()
      startAbortRef.current = undefined
      activeProviderRef.current = undefined
      setRecording(false)
      setPreparing(false)
      if (controller.signal.aborted) {
        resetTranscription(sessionId)
        return
      }
      if (!failedRef.current) showTransientMessage('转写未完成', providerErrorMessage(error), true)
    }

    const beginProvider = (): void => {
      try {
        const started = provider.start(startOptions)
        const pending = started as Partial<Promise<AsrProviderSession>>
        if (typeof pending.then === 'function') {
          void (started as Promise<AsrProviderSession>).then(acceptSession, rejectSession)
        } else {
          acceptSession(started as AsrProviderSession)
        }
      } catch (error) {
        rejectSession(error)
      }
    }

    const webSpeechAvailable = providers?.['web-speech'] !== undefined
      || (typeof window !== 'undefined'
        && (window.SpeechRecognition !== undefined || window.webkitSpeechRecognition !== undefined))
    const fallbackToWebSpeech = (): void => {
      if (controller.signal.aborted || startAbortRef.current !== controller) return
      if (!webSpeechAvailable) {
        rejectSession(asrProviderError(
          'unsupported',
          '本地服务不可用，且当前浏览器不支持 Web Speech 回退',
        ))
        return
      }
      clearMessageTimer()
      clearPermissionStatusTimer()
      resetTranscription(sessionId)
      setPreparing(false)
      providerId = 'web-speech'
      localMode = false
      fallbackNotice = true
      provider = providers?.['web-speech'] ?? WEB_SPEECH_PROVIDER
      activeProviderRef.current = providerId
      beginProvider()
    }
    const handlePreflightFailure = (error: unknown): void => {
      if (controller.signal.aborted) {
        rejectSession(error)
        return
      }
      clearPermissionStatusTimer()
      setPreparing(false)
      const detail = providerErrorMessage(error)
      if (webSpeechAvailable) {
        clearMessageTimer()
        updateTranscription(sessionId, {
          phase: 'error',
          finalText: '',
          interimText: '',
          status: '本地识别不可用',
          hint: `${detail}。可再次点击麦克风重试，或仅本次改用浏览器语音识别。`,
          announcement: `本地识别不可用。${detail}`,
          action: { label: '本次改用浏览器识别', run: fallbackToWebSpeech },
        })
        addTimelineEvent(
          'error',
          'error',
          '本地识别不可用',
          detail,
          'error',
          null,
        )
        return
      }
      rejectSession(error)
    }

    if (localMode && checkLocalEndpoint !== undefined) {
      void checkLocalEndpoint(DEFAULT_LOCAL_ENDPOINT, controller.signal).then(() => {
        if (controller.signal.aborted || startAbortRef.current !== controller) return
        prepareForLocalMicrophone()
        beginProvider()
      }, handlePreflightFailure)
    } else {
      prepareForLocalMicrophone()
      beginProvider()
    }
  }
  toggleRef.current = toggle

  useEffect(() => {
    if (!prefs.composerShortcutEnabled) return
    const card = buttonRef.current?.closest('[data-composer-card]')
    if (card === null || card === undefined) return
    const modifierCode = rightModifierCode(window.navigator.userAgent)
    let armed = false
    let chorded = false
    const reset = (): void => {
      armed = false
      chorded = false
    }
    const ownsFocusedComposer = (target: EventTarget | null): target is HTMLTextAreaElement =>
      target instanceof HTMLTextAreaElement
      && target === document.activeElement
      && target.closest('[data-composer-card]') === card
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.code !== modifierCode) {
        if (armed) chorded = true
        return
      }
      const anotherModifier = modifierCode === 'MetaRight'
        ? event.ctrlKey || event.altKey || event.shiftKey
        : event.metaKey || event.altKey || event.shiftKey
      if (!ownsFocusedComposer(event.target) || event.repeat || event.isComposing || anotherModifier) {
        armed = false
        chorded = true
        return
      }
      armed = true
      chorded = false
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.code !== modifierCode) return
      const shouldToggle = armed && !chorded && !event.isComposing && ownsFocusedComposer(event.target)
      reset()
      if (shouldToggle) toggleRef.current()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', reset)
    }
  }, [prefs.composerShortcutEnabled])

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center' }}>
      <button
        ref={buttonRef}
        type="button"
        aria-label="语音输入"
        aria-pressed={recording || preparing}
        title={supported
          ? (activeProviderRef.current ?? prefs.transcriptionProvider) === 'local-endpoint'
            ? preparing
              ? finalizingRef.current ? '点击取消本地转写' : '点击取消本地录音准备'
              : recording ? '点击结束并转写' : '点击开始本地录音'
            : recording ? '点击结束并转写' : '点击开始录音'
          : prefs.transcriptionProvider === 'web-speech'
            ? '当前浏览器不支持语音识别，请使用 Chrome 或 Edge'
            : '当前浏览器不支持本地录音，请使用最新版 Chrome 或 Edge'}
        onClick={toggle}
        style={{
          width: 28,
          height: 28,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: 0,
          borderRadius: 6,
          cursor: 'pointer',
          background: recording || preparing ? '#e5484d' : 'transparent',
          color: recording || preparing ? '#fff' : 'currentColor',
        }}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm6-3a6 6 0 0 1-12 0H4a8 8 0 0 0 7 7.94V22h2v-2.06A8 8 0 0 0 20 12h-2Z"
          />
        </svg>
      </button>
    </div>
  )
}
