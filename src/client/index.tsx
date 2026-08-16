import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { SettingsPanel, type ModelOption } from './SettingsPanel.tsx'
import { TranscriptionDock } from './TranscriptionDock.tsx'
import { loadPrefs, subscribePrefs, updatePrefs } from './prefs.ts'
import { resetTranscription, updateTranscription } from './transcriptionStore.ts'

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
}

interface PolishClientRequest {
  readonly sessionId: string
  readonly provider: string
  readonly model: string
  readonly transcript: string
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
    const result = await connection.rpc.call('/voice-input', 'polish', request, signal)
    if (!result.ok) throw new Error(result.error.message)
    const value = result.value
    if (typeof value !== 'object' || value === null || !('text' in value)
      || typeof (value as { text?: unknown }).text !== 'string'
      || (value as { text: string }).text.trim() === '') {
      throw new Error('model polish returned an invalid result')
    }
    return (value as { text: string }).text.trim()
  }
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'voice-input-recorder',
    order: 10,
  }, props => <VoiceInputButton {...props as VoiceInputProps} polish={polish} />))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'voice-input-transcription',
    order: 90,
  }, props => <TranscriptionDock sessionId={(props as VoiceInputProps).sessionId} />))
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    id: 'voice-input',
    order: 115,
  }, () => <VoiceInputSettings loadModels={loadModels} />))
}

/** Manual click-to-start, click-to-stop dictation control. */
export function VoiceInputButton({ inputActions, input, sessionId, polish }: VoiceInputProps) {
  const [recording, setRecording] = useState(false)
  const prefs = useSyncExternalStore(subscribePrefs, loadPrefs, () => loadPrefs())
  const recognitionRef = useRef<WebkitSpeechRecognition>()
  const draftRef = useRef(input.draft)
  const actionsRef = useRef(inputActions)
  const failedRef = useRef(false)
  const finalizingRef = useRef(false)
  const messageTimerRef = useRef<number>()
  const polishAbortRef = useRef<AbortController>()
  draftRef.current = input.draft
  actionsRef.current = inputActions

  const supported = typeof window !== 'undefined'
    && (window.SpeechRecognition !== undefined || window.webkitSpeechRecognition !== undefined)

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
    finalizingRef.current = false
    resetTranscription(sessionId)
  }, [sessionId])

  const insertTranscript = (transcript: string, allowAutomaticSend: boolean): void => {
    const current = draftRef.current.trim()
    const nextDraft = current === '' ? transcript : `${draftRef.current} ${transcript}`
    actionsRef.current.setDraft(nextDraft)
    if (allowAutomaticSend) actionsRef.current.submit()
  }

  const finishTranscript = async (transcript: string, allowAutomaticSend: boolean): Promise<void> => {
    const selected = decodeModelReference(prefs.selectedModel)
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
      const text = await polish({ sessionId, ...selected, transcript }, controller.signal)
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

    polishAbortRef.current?.abort()
    polishAbortRef.current = undefined
    finalizingRef.current = false
    let finalText = ''
    const recognition = new Recognition()
    recognition.lang = prefs.lang
    recognition.continuous = true
    recognition.interimResults = true
    recognition.maxAlternatives = 1
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
      if (transcript !== '') {
        void finishTranscript(transcript, allowAutomaticSend)
      } else if (!failedRef.current) {
        showTransientMessage('没有识别到语音')
      }
    }
    recognitionRef.current = recognition
    try {
      recognition.start()
    } catch {
      recognitionRef.current = undefined
      showTransientMessage('无法启动麦克风', true)
    }
  }

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center' }}>
      <button
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
