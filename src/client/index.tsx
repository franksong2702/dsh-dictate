import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'

interface InputActions {
  setDraft(text: string): void
}

interface VoiceInputProps {
  readonly inputActions: InputActions
  readonly input: { readonly draft: string }
}

/** Client services used by the composer contribution. */
export const inject = ['slots']

/** Register one manual dictation button immediately before the send action. */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'voice-input-recorder',
    order: 10,
  }, VoiceInputButton))
}

function VoiceInputButton({ inputActions, input }: VoiceInputProps) {
  const [recording, setRecording] = useState(false)
  const [message, setMessage] = useState('')
  const recognitionRef = useRef<WebkitSpeechRecognition>()
  const draftRef = useRef(input.draft)
  const actionsRef = useRef(inputActions)
  const pressedRef = useRef(false)
  const failedRef = useRef(false)
  draftRef.current = input.draft
  actionsRef.current = inputActions

  const supported = typeof window !== 'undefined'
    && (window.SpeechRecognition !== undefined || window.webkitSpeechRecognition !== undefined)

  useEffect(() => () => {
    const recognition = recognitionRef.current
    if (recognition !== undefined) {
      recognition.onstart = null
      recognition.onresult = null
      recognition.onerror = null
      recognition.onend = null
      recognition.abort()
    }
    recognitionRef.current = undefined
  }, [])

  const start = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    if (!supported) {
      setMessage('当前浏览器不支持语音识别，请使用 Chrome 或 Edge')
      return
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition
    if (Recognition === undefined) return

    let finalText = ''
    const recognition = new Recognition()
    recognition.lang = 'zh-CN'
    recognition.continuous = true
    recognition.interimResults = true
    recognition.maxAlternatives = 1
    recognition.onstart = () => {
      failedRef.current = false
      setRecording(true)
      setMessage('正在聆听…')
    }
    recognition.onresult = event => {
      let interim = ''
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]
        if (result === undefined) continue
        const text = result[0]?.transcript ?? ''
        if (result.isFinal) finalText += text
        else interim += text
      }
      setMessage(interim === '' ? '正在聆听…' : `正在聆听… ${interim}`)
    }
    recognition.onerror = event => {
      if (event.error === 'aborted' || event.error === 'no-speech') return
      failedRef.current = true
      setMessage(event.error === 'not-allowed'
        ? '麦克风权限被拒绝，请在浏览器地址栏允许后重试'
        : `语音识别失败：${event.error}`)
    }
    recognition.onend = () => {
      recognitionRef.current = undefined
      pressedRef.current = false
      setRecording(false)
      const transcript = finalText.trim()
      if (transcript !== '') {
        const current = draftRef.current.trim()
        actionsRef.current.setDraft(current === '' ? transcript : `${draftRef.current} ${transcript}`)
        setMessage('语音已转入输入框，请检查后发送')
      } else if (!failedRef.current) {
        setMessage('没有识别到语音')
      }
    }
    recognitionRef.current = recognition
    pressedRef.current = true
    try {
      recognition.start()
    } catch {
      recognitionRef.current = undefined
      pressedRef.current = false
      setMessage('无法启动麦克风')
    }
  }

  const stop = (): void => {
    if (!pressedRef.current) return
    pressedRef.current = false
    recognitionRef.current?.stop()
  }

  return (
    <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      {message !== '' && (
        <div
          role={message.includes('失败') || message.includes('拒绝') ? 'alert' : 'status'}
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 8px)',
            right: 0,
            zIndex: 30,
            width: 240,
            borderRadius: 8,
            padding: '7px 10px',
            background: '#292b30',
            color: '#e8eaed',
            fontSize: 12,
            lineHeight: 1.4,
            pointerEvents: 'none',
          }}
        >
          {message}
        </div>
      )}
      <button
        type="button"
        aria-label="语音输入"
        aria-pressed={recording}
        title={supported ? '按住说话，松手转文字' : '当前浏览器不支持语音识别，请使用 Chrome 或 Edge'}
        onPointerDown={start}
        onPointerUp={stop}
        onPointerCancel={stop}
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
