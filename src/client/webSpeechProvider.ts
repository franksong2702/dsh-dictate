import {
  asrProviderError,
  emitAsrStatus,
  type AsrContextTerm,
  type AsrProvider,
  type AsrProviderCallbacks,
  type AsrProviderSession,
  type AsrProviderStartOptions,
} from './asrProvider.ts'

function recognitionConstructor(): WebkitSpeechRecognitionConstructor | undefined {
  if (typeof window === 'undefined') return undefined
  return window.SpeechRecognition ?? window.webkitSpeechRecognition
}

function applyTerms(
  recognition: WebkitSpeechRecognition,
  terms: readonly AsrContextTerm[],
): boolean {
  const Phrase = window.SpeechRecognitionPhrase
  if (Phrase === undefined || recognition.phrases === undefined) return false
  try {
    recognition.phrases = terms.map(term => new Phrase(term.text, term.boost))
    return true
  } catch {
    return false
  }
}

function errorMessage(error: string): string {
  if (error === 'not-allowed') return '麦克风权限被拒绝，请在浏览器地址栏允许后重试'
  return `语音识别失败：${error}`
}

/** Create the zero-configuration browser speech-recognition provider. */
export function createWebSpeechProvider(): AsrProvider {
  return {
    start(options: AsrProviderStartOptions = {}): AsrProviderSession {
      const Recognition = recognitionConstructor()
      if (Recognition === undefined) {
        throw asrProviderError('unsupported', '当前浏览器不支持 Web Speech API')
      }
      if (options.signal?.aborted === true) {
        throw asrProviderError('aborted', '语音识别已取消')
      }

      let recognition: WebkitSpeechRecognition | undefined
      let requestedEnd: 'stop' | 'abort' | undefined
      let failed = false
      let restartingWithoutPhrases = false
      let retriedWithoutPhrases = false
      let phraseBiasActive = false
      let ended = false
      let started = false
      let activeTerms = options.terms ?? []
      let resolveEnd: (() => void) | undefined
      const endedPromise = new Promise<void>((resolve) => { resolveEnd = resolve })

      const endOnce = (reason: 'stop' | 'abort' | 'error' | 'ended'): void => {
        if (ended) return
        ended = true
        options.signal?.removeEventListener('abort', abortFromSignal)
        emitAsrStatus(options, reason === 'abort' ? 'aborted' : reason === 'error' ? 'error' : 'complete')
        options.onEnd?.(reason)
        resolveEnd?.()
      }

      const fail = (callbacks: AsrProviderCallbacks, error: string, cause?: unknown): void => {
        failed = true
        callbacks.onError?.(asrProviderError('recognition-failed', errorMessage(error), cause))
      }

      const begin = (usePhrases: boolean): void => {
        if (ended || requestedEnd === 'abort') return
        const next = new Recognition()
        const emittedFinals = new Map<number, string>()
        recognition = next
        next.lang = options.lang ?? 'zh-CN'
        next.continuous = true
        next.interimResults = true
        next.maxAlternatives = 1
        phraseBiasActive = usePhrases && activeTerms.length > 0 && applyTerms(next, activeTerms)
        next.onstart = () => {
          if (!started) {
            started = true
            options.onStart?.()
          }
          emitAsrStatus(options, 'listening')
        }
        next.onresult = (event) => {
          const interim: string[] = []
          for (let index = event.resultIndex; index < event.results.length; index += 1) {
            const result = event.results[index]
            if (result === undefined) continue
            const text = result[0]?.transcript.trim() ?? ''
            if (text === '') continue
            if (result.isFinal) {
              if (emittedFinals.get(index) === text) continue
              emittedFinals.set(index, text)
              options.onFinal?.(text)
            } else {
              interim.push(text)
            }
          }
          options.onInterim?.(interim.join(' '))
        }
        next.onerror = (event) => {
          if (recognition !== next) return
          if (event.error === 'aborted' || event.error === 'no-speech') return
          if (event.error === 'phrases-not-supported') {
            if (phraseBiasActive && !retriedWithoutPhrases) {
              retriedWithoutPhrases = true
              restartingWithoutPhrases = true
            }
            return
          }
          fail(options, event.error, event)
        }
        next.onend = () => {
          if (recognition !== next) return
          recognition = undefined
          if (restartingWithoutPhrases && requestedEnd === undefined) {
            restartingWithoutPhrases = false
            begin(false)
            return
          }
          if (requestedEnd === undefined && !failed) {
            options.onInterim?.('')
            begin(!retriedWithoutPhrases && activeTerms.length > 0)
            return
          }
          endOnce(requestedEnd ?? (failed ? 'error' : 'ended'))
        }
        try {
          next.start()
        } catch (cause) {
          recognition = undefined
          fail(options, 'audio-capture', cause)
          endOnce('error')
        }
      }

      const abortFromSignal = (): void => {
        requestedEnd = 'abort'
        const current = recognition
        if (current === undefined) endOnce('abort')
        else current.abort()
      }
      options.signal?.addEventListener('abort', abortFromSignal, { once: true })
      begin(activeTerms.length > 0)

      return {
        async stop(): Promise<void> {
          if (ended) return
          requestedEnd = 'stop'
          emitAsrStatus(options, 'stopping')
          const current = recognition
          if (current === undefined) endOnce('stop')
          else current.stop()
          await endedPromise
        },
        async abort(): Promise<void> {
          if (ended) return
          requestedEnd = 'abort'
          const current = recognition
          if (current === undefined) endOnce('abort')
          else current.abort()
          await endedPromise
        },
        async updateTerms(terms: readonly AsrContextTerm[]): Promise<void> {
          activeTerms = terms
          if (recognition !== undefined && !retriedWithoutPhrases) {
            phraseBiasActive = applyTerms(recognition, terms)
          }
        },
      }
    },
  }
}
