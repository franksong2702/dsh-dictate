import {
  asrProviderError,
  emitAsrStatus,
  type AsrContextTerm,
  type AsrProvider,
  type AsrProviderCallbacks,
  type AsrProviderSession,
  type AsrProviderStartOptions,
} from './asrProvider.ts'

export const LOCAL_ENDPOINT_MODEL = 'sensevoice'
const TARGET_SAMPLE_RATE = 16_000
const PROCESSOR_BUFFER_SIZE = 4096

export interface LocalEndpointAudioNode {
  connect(destination: unknown): unknown
  disconnect(...destinations: unknown[]): void
}

export interface LocalEndpointAudioProcessor extends LocalEndpointAudioNode {
  onaudioprocess: ((event: {
    readonly inputBuffer: { getChannelData(channel: number): Float32Array }
  }) => void) | null
}

export interface LocalEndpointAudioContext {
  readonly sampleRate: number
  readonly destination: unknown
  createMediaStreamSource(stream: MediaStream): LocalEndpointAudioNode
  createScriptProcessor(
    bufferSize: number,
    inputChannels: number,
    outputChannels: number,
  ): LocalEndpointAudioProcessor
  createGain?: () => LocalEndpointAudioGain
  resume?: () => Promise<void>
  close?: () => Promise<void>
}

export interface LocalEndpointAudioGain extends LocalEndpointAudioNode {
  readonly gain: { value: number }
}

export interface LocalEndpointRuntime {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>
  createAudioContext(options?: AudioContextOptions): LocalEndpointAudioContext
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}

export interface LocalEndpointProviderOptions {
  readonly endpoint: string
  readonly model?: string
  readonly runtime?: LocalEndpointRuntime
}

interface CaptureResources {
  readonly stream: MediaStream
  readonly context: LocalEndpointAudioContext
  readonly source: LocalEndpointAudioNode
  readonly processor: LocalEndpointAudioProcessor
  readonly gain?: LocalEndpointAudioGain
}

function browserRuntime(): LocalEndpointRuntime {
  return {
    getUserMedia: constraints => {
      if (typeof navigator === 'undefined' || navigator.mediaDevices?.getUserMedia === undefined) {
        return Promise.reject(new Error('getUserMedia is not supported'))
      }
      return navigator.mediaDevices.getUserMedia(constraints)
    },
    createAudioContext: options => {
      const Constructor = typeof window === 'undefined'
        ? undefined
        : window.AudioContext
          ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (Constructor === undefined) throw new Error('AudioContext is not supported')
      return new Constructor(options) as unknown as LocalEndpointAudioContext
    },
    fetch: (input, init) => fetch(input, init),
  }
}

/** Resolve a loopback-only base URL to the OpenAI-compatible transcription route. */
export function localTranscriptionUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw asrProviderError('endpoint-invalid', '本地服务地址无效')
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
  if (!loopback || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw asrProviderError('endpoint-invalid', '本地服务地址必须使用 localhost 或回环地址')
  }
  url.hash = ''
  url.search = ''
  const path = url.pathname.replace(/\/+$/, '')
  if (path === '' || path === '/') url.pathname = '/v1/audio/transcriptions'
  else if (path === '/v1') url.pathname = '/v1/audio/transcriptions'
  return url.href
}

/** Map the UI BCP-47 language to the language hints accepted by SenseVoice. */
export function localEndpointLanguage(lang: string | undefined): string {
  if (lang === undefined) return 'auto'
  if (/^zh-HK$/i.test(lang)) return 'yue'
  if (/^zh(?:-|$)/i.test(lang)) return 'zh'
  if (/^en(?:-|$)/i.test(lang)) return 'en'
  if (/^ja(?:-|$)/i.test(lang)) return 'ja'
  if (/^ko(?:-|$)/i.test(lang)) return 'ko'
  return 'auto'
}

function concatenate(chunks: readonly Float32Array[]): Float32Array {
  const output = new Float32Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}

/** Downsample microphone PCM with interval averaging to keep speech energy stable. */
export function resampleMonoPcm(
  input: Float32Array,
  sourceRate: number,
  targetRate = TARGET_SAMPLE_RATE,
): Float32Array {
  if (sourceRate <= 0 || targetRate <= 0) throw new Error('sample rates must be positive')
  if (input.length === 0 || sourceRate === targetRate) return input.slice()
  const outputLength = Math.max(1, Math.round(input.length * targetRate / sourceRate))
  const output = new Float32Array(outputLength)
  const ratio = sourceRate / targetRate
  for (let index = 0; index < outputLength; index += 1) {
    const start = index * ratio
    const end = Math.min(input.length, (index + 1) * ratio)
    const first = Math.floor(start)
    const last = Math.max(first + 1, Math.ceil(end))
    let sum = 0
    let weight = 0
    for (let sourceIndex = first; sourceIndex < last && sourceIndex < input.length; sourceIndex += 1) {
      const overlap = Math.max(0, Math.min(end, sourceIndex + 1) - Math.max(start, sourceIndex))
      sum += (input[sourceIndex] ?? 0) * overlap
      weight += overlap
    }
    output[index] = weight === 0 ? 0 : sum / weight
  }
  return output
}

/** Encode mono float PCM as a 16-bit little-endian WAV accepted by FunASR. */
export function encodeMonoWav(samples: Float32Array, sampleRate = TARGET_SAMPLE_RATE): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const writeText = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index))
  }
  writeText(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeText(8, 'WAVE')
  writeText(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeText(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0))
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

function detailMessage(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  for (const key of ['detail', 'error', 'message'] as const) {
    const value = (payload as Record<string, unknown>)[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, 240)
  }
  return undefined
}

function transcriptText(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null || !('text' in payload)) return undefined
  const text = (payload as { readonly text?: unknown }).text
  return typeof text === 'string' ? text.trim() : undefined
}

/** Create a final-transcription provider backed by a loopback FunASR endpoint. */
export function createLocalEndpointProvider(options: LocalEndpointProviderOptions): AsrProvider {
  const runtime = options.runtime ?? browserRuntime()
  const model = options.model ?? LOCAL_ENDPOINT_MODEL
  return {
    async start(callbacks: AsrProviderStartOptions = {}): Promise<AsrProviderSession> {
      const endpoint = localTranscriptionUrl(options.endpoint)
      if (callbacks.signal?.aborted === true) throw asrProviderError('aborted', '本地转写已取消')
      emitAsrStatus(callbacks, 'loading')
      callbacks.onProgress?.({ phase: 'microphone', message: '正在请求麦克风权限' })

      let stream: MediaStream
      try {
        stream = await runtime.getUserMedia({ audio: { channelCount: 1 } })
      } catch (cause) {
        if (Boolean(callbacks.signal?.aborted)) {
          throw asrProviderError('aborted', '本地转写已取消', cause)
        }
        const error = asrProviderError('microphone-failed', '麦克风权限被拒绝或无法访问', cause)
        callbacks.onError?.(error)
        throw error
      }
      if (Boolean(callbacks.signal?.aborted)) {
        for (const track of stream.getTracks()) track.stop()
        throw asrProviderError('aborted', '本地转写已取消')
      }
      let context: LocalEndpointAudioContext
      try {
        context = runtime.createAudioContext({ sampleRate: TARGET_SAMPLE_RATE })
      } catch (cause) {
        for (const track of stream.getTracks()) track.stop()
        const error = asrProviderError('unsupported', '当前浏览器不支持本地录音', cause)
        callbacks.onError?.(error)
        throw error
      }

      let source: LocalEndpointAudioNode | undefined
      let processor: LocalEndpointAudioProcessor | undefined
      let gain: LocalEndpointAudioGain | undefined
      const chunks: Float32Array[] = []
      try {
        source = context.createMediaStreamSource(stream)
        processor = context.createScriptProcessor(PROCESSOR_BUFFER_SIZE, 1, 1)
        gain = context.createGain?.()
        if (gain !== undefined) gain.gain.value = 0
        processor.onaudioprocess = event => {
          const samples = event.inputBuffer.getChannelData(0)
          chunks.push(new Float32Array(samples))
        }
        source.connect(processor)
        if (gain !== undefined) {
          processor.connect(gain)
          gain.connect(context.destination)
        } else {
          processor.connect(context.destination)
        }
        await context.resume?.()
      } catch (cause) {
        try { source?.disconnect() } catch { /* partially connected */ }
        try { processor?.disconnect() } catch { /* partially connected */ }
        try { gain?.disconnect() } catch { /* partially connected */ }
        for (const track of stream.getTracks()) {
          try { track.stop() } catch { /* revoked tracks are already stopped */ }
        }
        try { await context.close?.() } catch { /* context creation already failed */ }
        const error = asrProviderError('audio-failed', '无法开始本地录音', cause)
        callbacks.onError?.(error)
        throw error
      }
      if (Boolean(callbacks.signal?.aborted)) {
        try { source.disconnect() } catch { /* capture is already stopped */ }
        try { processor.disconnect() } catch { /* capture is already stopped */ }
        try { gain?.disconnect() } catch { /* capture is already stopped */ }
        for (const track of stream.getTracks()) track.stop()
        try { await context.close?.() } catch { /* capture is already stopped */ }
        throw asrProviderError('aborted', '本地转写已取消')
      }

      const resources: CaptureResources = { stream, context, source, processor, gain }
      let ended = false
      let closePromise: Promise<void> | undefined
      let cleanupPromise: Promise<void> | undefined
      const requestController = new AbortController()
      let resolveEnd: (() => void) | undefined
      const endedPromise = new Promise<void>((resolve) => { resolveEnd = resolve })

      const cleanup = (): Promise<void> => {
        cleanupPromise ??= (async () => {
          resources.processor.onaudioprocess = null
          try { resources.source.disconnect() } catch { /* already disconnected */ }
          try { resources.processor.disconnect() } catch { /* already disconnected */ }
          try { resources.gain?.disconnect() } catch { /* already disconnected */ }
          for (const track of resources.stream.getTracks()) {
            try { track.stop() } catch { /* revoked tracks are already stopped */ }
          }
          try { await resources.context.close?.() } catch { /* capture is already stopped */ }
        })()
        return cleanupPromise
      }

      const endOnce = (reason: 'stop' | 'abort' | 'error'): void => {
        if (ended) return
        ended = true
        callbacks.signal?.removeEventListener('abort', abortFromSignal)
        emitAsrStatus(callbacks, reason === 'abort' ? 'aborted' : reason === 'error' ? 'error' : 'complete')
        callbacks.onEnd?.(reason)
        resolveEnd?.()
      }

      const abortFromSignal = (): void => { void abortSession() }
      const abortSession = async (): Promise<void> => {
        if (ended) return
        requestController.abort()
        await cleanup()
        endOnce('abort')
      }
      callbacks.signal?.addEventListener('abort', abortFromSignal, { once: true })

      const stopSession = async (): Promise<void> => {
        if (ended) return
        if (closePromise !== undefined) return closePromise
        closePromise = (async () => {
          emitAsrStatus(callbacks, 'stopping')
          callbacks.onProgress?.({ phase: 'audio', message: '正在整理录音' })
          await cleanup()
          if (requestController.signal.aborted) {
            endOnce('abort')
            return
          }
          const input = concatenate(chunks)
          if (input.length === 0) {
            callbacks.onError?.(asrProviderError('audio-failed', '没有采集到音频'))
            endOnce('error')
            return
          }
          const wav = encodeMonoWav(resampleMonoPcm(input, resources.context.sampleRate))
          const form = new FormData()
          form.append('file', wav, 'dictation.wav')
          form.append('model', model)
          form.append('language', localEndpointLanguage(callbacks.lang))
          callbacks.onProgress?.({ phase: 'runtime', message: '正在由本地服务转写' })
          let response: Response
          try {
            response = await runtime.fetch(endpoint, {
              method: 'POST',
              body: form,
              signal: requestController.signal,
            })
          } catch (cause) {
            if (requestController.signal.aborted) {
              endOnce('abort')
              return
            }
            callbacks.onError?.(asrProviderError(
              'endpoint-unreachable',
              '无法连接本地转写服务，请确认服务已启动并允许当前 DSH 地址跨域访问',
              cause,
            ))
            endOnce('error')
            return
          }
          let payload: unknown
          try {
            payload = await response.json()
          } catch (cause) {
            if (requestController.signal.aborted || ended) {
              endOnce('abort')
              return
            }
            callbacks.onError?.(asrProviderError('endpoint-response', '本地服务返回了无法解析的结果', cause))
            endOnce('error')
            return
          }
          if (requestController.signal.aborted || ended) {
            endOnce('abort')
            return
          }
          if (!response.ok) {
            const detail = detailMessage(payload)
            callbacks.onError?.(asrProviderError(
              'endpoint-response',
              `本地服务返回 HTTP ${response.status}${detail === undefined ? '' : `：${detail}`}`,
            ))
            endOnce('error')
            return
          }
          const text = transcriptText(payload)
          if (text === undefined) {
            callbacks.onError?.(asrProviderError('endpoint-response', '本地服务没有返回有效文字'))
            endOnce('error')
            return
          }
          if (text !== '') callbacks.onFinal?.(text)
          endOnce('stop')
        })()
        return closePromise
      }

      callbacks.onStart?.()
      emitAsrStatus(callbacks, 'listening')

      return {
        stop: async () => { await stopSession(); await endedPromise },
        abort: async () => { await abortSession(); await endedPromise },
        updateTerms: async (_terms: readonly AsrContextTerm[]) => {
          // SenseVoice's OpenAI-compatible endpoint does not accept reliable ASR-stage hotwords.
        },
      }
    },
  }
}
