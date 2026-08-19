import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { SettingsPanel, type ModelOption } from './SettingsPanel.tsx'
import { TranscriptionDock } from './TranscriptionDock.tsx'
import { loadPrefs, subscribePrefs, updatePrefs } from './prefs.ts'
import { createLocalEndpointProvider } from './localEndpointProvider.ts'
import { createWebSpeechProvider } from './webSpeechProvider.ts'
import type {
  AsrContextTerm,
  AsrProvider,
  AsrProviderError,
  AsrProviderSession,
  AsrProviderStartOptions,
} from './asrProvider.ts'
import { resetTranscription, updateTranscription } from './transcriptionStore.ts'
import {
  parseContextTerms,
  type ContextTerm,
  type ContextTermsRequest,
} from '../terms.ts'
import { DICTATE_SETTINGS_NAMESPACE } from '../settings-contract.ts'
import {
  parseLocalServiceStatus,
  type LocalServiceStatus,
} from '../local-service-contract.ts'

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
  return <SettingsPanel modelOptions={modelOptions} localService={localService} />
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
  const callLocalService = async (
    endpoint: 'local-service-status' | 'local-service-start' | 'local-service-stop',
    signal: AbortSignal,
  ): Promise<LocalServiceStatus> => {
    const payload = endpoint === 'local-service-start' ? { origin: window.location.origin } : {}
    const result = await connection.rpc.call('/dictate', endpoint, payload, signal)
    if (!result.ok) throw new Error(result.error.message)
    return parseLocalServiceStatus(result.value)
  }
  const localService = {
    status: (signal: AbortSignal) => callLocalService('local-service-status', signal),
    start: (signal: AbortSignal) => callLocalService('local-service-start', signal),
    stop: (signal: AbortSignal) => callLocalService('local-service-stop', signal),
  }
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'dictate-recorder',
    order: 10,
  }, props => <VoiceInputButton
    {...props as VoiceInputProps}
    polish={polish}
    loadContextTerms={loadContextTerms}
  />))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'dictate-transcription',
    order: 90,
  }, props => <TranscriptionDock sessionId={(props as VoiceInputProps).sessionId} />))
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: DICTATE_SETTINGS_NAMESPACE,
  }, () => <VoiceInputSettings loadModels={loadModels} localService={localService} />))
}

/** Manual click-to-start, click-to-stop dictation control. */
export function VoiceInputButton({
  inputActions,
  input,
  sessionId,
  polish,
  loadContextTerms,
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
  const messageTimerRef = useRef<number>()
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

  const showTransientMessage = (text: string, error = false): void => {
    clearMessageTimer()
    updateTranscription(sessionId, {
      phase: error ? 'error' : 'complete',
      finalText: '',
      interimText: '',
      status: text,
    })
    messageTimerRef.current = window.setTimeout(() => {
      resetTranscription(sessionId)
      messageTimerRef.current = undefined
    }, 3000)
  }

  useEffect(() => () => {
    clearMessageTimer()
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
      insertTranscript(transcript, allowAutomaticSend)
      showTransientMessage(allowAutomaticSend
        ? prefs.modelPolishEnabled && selected === undefined
          ? '未选择润色模型，原始转写已交给 DSH 发送'
          : '转写结果已交给 DSH 发送'
        : prefs.modelPolishEnabled && selected === undefined
          ? '请选择润色模型'
          : '语音已转入输入框，请检查后发送',
      prefs.modelPolishEnabled && selected === undefined)
      return
    }
    clearMessageTimer()
    updateTranscription(sessionId, {
      phase: 'polishing',
      finalText: transcript,
      interimText: '',
      status: '模型润色中',
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
      showTransientMessage(allowAutomaticSend
        ? '润色结果已交给 DSH 发送'
        : '语音已转入输入框，请检查后发送')
    } catch {
      if (controller.signal.aborted) return
      insertTranscript(transcript, allowAutomaticSend)
      showTransientMessage(allowAutomaticSend
        ? '模型润色失败，原始转写已交给 DSH 发送'
        : '模型润色失败，已保留原始转写', true)
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
      finalizingRef.current = true
      setRecording(false)
      const localMode = activeProviderRef.current === 'local-endpoint'
      setPreparing(localMode)
      updateTranscription(sessionId, {
        phase: 'finalizing',
        status: localMode ? '正在整理录音' : '正在确认文字',
      })
      void activeSession.stop()
      return
    }
    if (startAbortRef.current !== undefined) {
      startAbortRef.current.abort()
      return
    }
    if (!supported) {
      showTransientMessage(prefs.transcriptionProvider === 'web-speech'
        ? '当前浏览器不支持语音识别，请使用 Chrome 或 Edge'
        : '当前浏览器不支持本地录音，请使用最新版 Chrome 或 Edge', true)
      return
    }

    clearTermsDebounce()
    polishAbortRef.current?.abort()
    polishAbortRef.current = undefined
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

    const providerId = prefs.transcriptionProvider
    const localMode = providerId === 'local-endpoint'
    const provider = injectedProvider ?? (providerId === 'web-speech'
      ? WEB_SPEECH_PROVIDER
      : createLocalEndpointProvider({ endpoint: prefs.localEndpoint }))
    const controller = new AbortController()
    startAbortRef.current = controller
    finalizingRef.current = false
    failedRef.current = false
    let ended = false
    const finalSegments: string[] = []
    const currentFinalText = (): string => joinRecognitionSegments(finalSegments, prefs.lang)

    activeProviderRef.current = providerId
    if (localMode) {
      setPreparing(true)
      clearMessageTimer()
      updateTranscription(sessionId, {
        phase: 'preparing',
        finalText: '',
        interimText: '',
        status: '正在准备本地录音',
      })
    }

    const startOptions: AsrProviderStartOptions = {
      lang: prefs.lang,
      terms: (cachedTerms ?? []) as readonly AsrContextTerm[],
      signal: controller.signal,
      onStart: () => {
        clearMessageTimer()
        setPreparing(false)
        setRecording(true)
        updateTranscription(sessionId, {
          phase: 'listening',
          finalText: '',
          interimText: '',
          status: localMode ? '正在录音' : '正在听写',
        })
      },
      onInterim: (text) => {
        updateTranscription(sessionId, {
          phase: finalizingRef.current ? 'finalizing' : 'listening',
          finalText: currentFinalText(),
          interimText: text,
          status: finalizingRef.current ? '正在确认文字' : '正在听写',
        })
      },
      onFinal: (text) => {
        if (text.trim() !== '') finalSegments.push(text)
        updateTranscription(sessionId, {
          phase: finalizingRef.current ? 'finalizing' : 'listening',
          finalText: currentFinalText(),
          interimText: '',
          status: finalizingRef.current
            ? localMode ? '正在由本地服务转写' : '正在确认文字'
            : localMode ? '正在录音' : '正在听写',
        })
      },
      onStatus: (status) => {
        if (status !== 'stopping') return
        setRecording(false)
        setPreparing(localMode)
        updateTranscription(sessionId, {
          phase: 'finalizing',
          status: localMode ? '正在整理录音' : '正在确认文字',
        })
      },
      onProgress: (progress) => {
        if (progress.message === undefined) return
        updateTranscription(sessionId, {
          phase: progress.phase === 'microphone' ? 'preparing' : 'finalizing',
          status: progress.message,
        })
      },
      onError: (error) => {
        failedRef.current = true
        showTransientMessage(error.message, true)
      },
      onEnd: (reason) => {
        ended = true
        sessionRef.current = undefined
        activeProviderRef.current = undefined
        startAbortRef.current = undefined
        setRecording(false)
        setPreparing(false)
        const allowAutomaticSend = reason === 'stop' && finalizingRef.current && prefs.autoSendEnabled
        finalizingRef.current = false
        const transcript = currentFinalText().trim()
        if (transcript !== '') {
          void finishTranscript(transcript, allowAutomaticSend)
        } else if (!failedRef.current && reason !== 'abort') {
          showTransientMessage('没有识别到语音')
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
      activeProviderRef.current = undefined
      if (shouldLoadContextTerms) {
        void requestContextTermsRef.current(termsRequestAtStart, termsKeyAtStart).then((terms) => {
          if (sessionRef.current === session) void session.updateTerms(terms)
        }, () => {
          // Context-term extraction is optional; recognition and polishing retain their fallbacks.
        })
      }
    }
    const rejectSession = (error: unknown): void => {
      startAbortRef.current = undefined
      setRecording(false)
      setPreparing(false)
      if (controller.signal.aborted) {
        resetTranscription(sessionId)
        return
      }
      if (!failedRef.current) showTransientMessage(providerErrorMessage(error), true)
    }
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
