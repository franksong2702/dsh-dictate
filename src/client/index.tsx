import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { SettingsPanel, type ModelOption } from './SettingsPanel.tsx'
import { TranscriptionDock } from './TranscriptionDock.tsx'
import { loadPrefs, subscribePrefs, updatePrefs } from './prefs.ts'
import { resetTranscription, updateTranscription } from './transcriptionStore.ts'
import {
  parseContextTerms,
  type ContextTerm,
  type ContextTermsRequest,
} from '../terms.ts'

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

function applyContextTerms(
  recognition: WebkitSpeechRecognition,
  terms: readonly ContextTerm[],
): void {
  const Phrase = window.SpeechRecognitionPhrase
  if (Phrase === undefined || recognition.phrases === undefined) return
  try {
    recognition.phrases = terms.map(term => new Phrase(term.text, term.boost))
  } catch {
    // A browser service may expose the API but reject contextual phrases; ordinary recognition remains active.
  }
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

function VoiceInputSettings({ loadModels }: {
  readonly loadModels: () => Promise<readonly ModelOption[]>
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
  return <SettingsPanel modelOptions={modelOptions} />
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
    id: 'dictate',
    order: 115,
  }, () => <VoiceInputSettings loadModels={loadModels} />))
}

/** Manual click-to-start, click-to-stop dictation control. */
export function VoiceInputButton({
  inputActions,
  input,
  sessionId,
  polish,
  loadContextTerms,
}: VoiceInputProps) {
  const [recording, setRecording] = useState(false)
  const prefs = useSyncExternalStore(subscribePrefs, loadPrefs, () => loadPrefs())
  const recognitionRef = useRef<WebkitSpeechRecognition>()
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
  const retryWithoutPhraseBiasRef = useRef(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const toggleRef = useRef<() => void>(() => {})
  draftRef.current = input.draft
  actionsRef.current = inputActions

  const supported = typeof window !== 'undefined'
    && (window.SpeechRecognition !== undefined || window.webkitSpeechRecognition !== undefined)
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
    const recognition = recognitionRef.current
    if (recognition !== undefined) {
      recognition.onstart = null
      recognition.onresult = null
      recognition.onerror = null
      recognition.onend = null
      recognition.abort()
    }
    recognitionRef.current = undefined
    polishAbortRef.current?.abort()
    polishAbortRef.current = undefined
    termsRequestRef.current?.controller.abort()
    termsRequestRef.current = undefined
    contextTermsRef.current = []
    contextTermsKeyRef.current = undefined
    retryWithoutPhraseBiasRef.current = false
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
    if (recognitionRef.current !== undefined) {
      finalizingRef.current = true
      updateTranscription(sessionId, {
        phase: 'finalizing',
        status: '正在确认文字',
      })
      recognitionRef.current.stop()
      return
    }
    if (!supported) {
      showTransientMessage('当前浏览器不支持语音识别，请使用 Chrome 或 Edge', true)
      return
    }
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition
    if (Recognition === undefined) return

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
    const skipPhraseBias = retryWithoutPhraseBiasRef.current
    retryWithoutPhraseBiasRef.current = false
    finalizingRef.current = false
    let finalText = ''
    const recognition = new Recognition()
    recognition.lang = prefs.lang
    recognition.continuous = true
    recognition.interimResults = true
    recognition.maxAlternatives = 1
    const canBiasRecognition = contextOptimizationEnabled && !skipPhraseBias
      && window.SpeechRecognitionPhrase !== undefined
      && recognition.phrases !== undefined
    if (canBiasRecognition && cachedTerms !== undefined && cachedTerms.length > 0) {
      applyContextTerms(recognition, cachedTerms)
    }
    recognition.onstart = () => {
      clearMessageTimer()
      failedRef.current = false
      setRecording(true)
      updateTranscription(sessionId, {
        phase: finalizingRef.current ? 'finalizing' : 'listening',
        finalText: '',
        interimText: '',
        status: '正在听写',
      })
    }
    recognition.onresult = event => {
      const finalSegments: string[] = []
      const interimSegments: string[] = []
      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index]
        if (result === undefined) continue
        const text = result[0]?.transcript ?? ''
        if (result.isFinal) finalSegments.push(text)
        else interimSegments.push(text)
      }
      finalText = joinRecognitionSegments(finalSegments, prefs.lang)
      const finalizing = finalizingRef.current
      updateTranscription(sessionId, {
        phase: finalizing ? 'finalizing' : 'listening',
        finalText,
        interimText: joinRecognitionSegments(interimSegments, prefs.lang),
        status: finalizing ? '正在确认文字' : '正在听写',
      })
    }
    recognition.onerror = event => {
      if (event.error === 'aborted' || event.error === 'no-speech') return
      if (event.error === 'phrases-not-supported') {
        if (!skipPhraseBias) retryWithoutPhraseBiasRef.current = true
        else {
          failedRef.current = true
          showTransientMessage('当前语音识别服务不可用，请稍后重试', true)
        }
        return
      }
      failedRef.current = true
      showTransientMessage(event.error === 'not-allowed'
        ? '麦克风权限被拒绝，请在浏览器地址栏允许后重试'
        : `语音识别失败：${event.error}`, true)
    }
    recognition.onend = () => {
      recognitionRef.current = undefined
      setRecording(false)
      const allowAutomaticSend = finalizingRef.current && prefs.autoSendEnabled
      finalizingRef.current = false
      const transcript = finalText.trim()
      if (retryWithoutPhraseBiasRef.current && transcript === '') {
        toggle()
        return
      }
      if (transcript !== '') {
        void finishTranscript(transcript, allowAutomaticSend)
      } else if (!failedRef.current) {
        showTransientMessage('没有识别到语音')
      }
    }
    recognitionRef.current = recognition
    try {
      recognition.start()
      if (shouldLoadContextTerms) {
        void requestContextTermsRef.current(termsRequestAtStart, termsKeyAtStart).then((terms) => {
          if (recognitionRef.current !== recognition) return
          if (canBiasRecognition && terms.length > 0) applyContextTerms(recognition, terms)
        }, () => {
          // Context-term extraction is optional; ordinary recognition remains active.
        })
      }
    } catch {
      recognitionRef.current = undefined
      showTransientMessage('无法启动麦克风', true)
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
        aria-pressed={recording}
        title={supported
          ? recording ? '点击结束并转写' : '点击开始录音'
          : '当前浏览器不支持语音识别，请使用 Chrome 或 Edge'}
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
          background: recording ? '#e5484d' : 'transparent',
          color: recording ? '#fff' : 'currentColor',
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
