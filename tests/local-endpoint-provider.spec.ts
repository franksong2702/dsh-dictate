// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import {
  checkLocalEndpoint,
  createLocalEndpointProvider,
  encodeMonoWav,
  localEndpointLanguage,
  localHealthUrl,
  localTranscriptionUrl,
  resampleMonoPcm,
  type LocalEndpointAudioContext,
  type LocalEndpointAudioNode,
  type LocalEndpointAudioProcessor,
  type LocalEndpointRuntime,
} from '../src/client/localEndpointProvider.ts'

interface RuntimeFixture {
  readonly runtime: LocalEndpointRuntime
  readonly processor: LocalEndpointAudioProcessor
  readonly stopTrack: ReturnType<typeof vi.fn>
  readonly closeContext: ReturnType<typeof vi.fn>
  readonly fetchMock: ReturnType<typeof vi.fn>
  readonly waitMock: ReturnType<typeof vi.fn>
}

function runtimeFixture(
  fetchImplementation: LocalEndpointRuntime['fetch'],
  waitImplementation: NonNullable<LocalEndpointRuntime['wait']> = async () => {},
): RuntimeFixture {
  const stopTrack = vi.fn()
  const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream
  const node = (): LocalEndpointAudioNode => ({ connect: vi.fn(), disconnect: vi.fn() })
  const processor: LocalEndpointAudioProcessor = {
    ...node(),
    onaudioprocess: null,
  }
  const closeContext = vi.fn(() => Promise.resolve())
  const context: LocalEndpointAudioContext = {
    sampleRate: 48_000,
    destination: {},
    createMediaStreamSource: () => node(),
    createScriptProcessor: () => processor,
    createGain: () => ({ ...node(), gain: { value: 1 } }),
    resume: () => Promise.resolve(),
    close: closeContext,
  }
  const fetchMock = vi.fn(fetchImplementation)
  const waitMock = vi.fn(waitImplementation)
  return {
    runtime: {
      getUserMedia: vi.fn(() => Promise.resolve(stream)),
      createAudioContext: vi.fn(() => context),
      fetch: fetchMock,
      wait: waitMock,
    },
    processor,
    stopTrack,
    closeContext,
    fetchMock,
    waitMock,
  }
}

describe('local endpoint provider', () => {
  it('accepts only loopback endpoints and resolves the OpenAI-compatible route', () => {
    expect(localTranscriptionUrl('http://127.0.0.1:39081')).toBe(
      'http://127.0.0.1:39081/v1/audio/transcriptions',
    )
    expect(localTranscriptionUrl('http://localhost:39081/v1')).toBe(
      'http://localhost:39081/v1/audio/transcriptions',
    )
    expect(localTranscriptionUrl('http://[::1]:39081/v1/audio/transcriptions')).toBe(
      'http://[::1]:39081/v1/audio/transcriptions',
    )
    expect(() => localTranscriptionUrl('https://example.com')).toThrow('本地服务地址必须使用')
    expect(() => localTranscriptionUrl('not a URL')).toThrow('本地服务地址无效')
    expect(localHealthUrl('http://127.0.0.1:39081/v1')).toBe('http://127.0.0.1:39081/health')
  })

  it('tests the configured endpoint through its browser-visible health route', async () => {
    const fetchMock = vi.fn(async () => new Response(
      '{"status":"ok","models_loaded":["sensevoice"]}',
      { status: 200 },
    ))
    const message = await checkLocalEndpoint(
      'http://127.0.0.1:39081',
      new AbortController().signal,
      fetchMock,
    )

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:39081/health', expect.objectContaining({
      method: 'GET',
    }))
    expect(message).toBe('连接成功：本地 SenseVoice 服务已就绪')
  })

  it('does not mistake an unrelated healthy loopback service for SenseVoice', async () => {
    await expect(checkLocalEndpoint(
      'http://127.0.0.1:39081',
      new AbortController().signal,
      async () => new Response('{"status":"ok","models_loaded":[]}', { status: 200 }),
    )).rejects.toMatchObject({
      code: 'endpoint-response',
      message: '本地服务尚未加载 SenseVoice 模型',
    })
  })

  it('maps supported UI languages and safely falls back to auto', () => {
    expect(localEndpointLanguage('zh-CN')).toBe('zh')
    expect(localEndpointLanguage('zh-HK')).toBe('yue')
    expect(localEndpointLanguage('en-US')).toBe('en')
    expect(localEndpointLanguage('ja-JP')).toBe('ja')
    expect(localEndpointLanguage('ko-KR')).toBe('ko')
    expect(localEndpointLanguage('fr-FR')).toBe('auto')
  })

  it('downsamples mono PCM and writes a valid 16-bit WAV header', async () => {
    const input = new Float32Array(48_000).fill(0.5)
    const samples = resampleMonoPcm(input, 48_000)
    expect(samples).toHaveLength(16_000)
    expect(samples[0]).toBeCloseTo(0.5)
    const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => { reject(reader.error) }
      reader.onload = () => { resolve(reader.result as ArrayBuffer) }
      reader.readAsArrayBuffer(encodeMonoWav(samples))
    })
    const bytes = new Uint8Array(buffer)
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('RIFF')
    expect(new TextDecoder().decode(bytes.slice(8, 12))).toBe('WAVE')
    expect(new DataView(bytes.buffer).getUint32(24, true)).toBe(16_000)
    expect(new DataView(bytes.buffer).getUint16(34, true)).toBe(16)
  })

  it('records once, posts a SenseVoice WAV, and returns final text', async () => {
    const fixture = runtimeFixture(async () => new Response(
      JSON.stringify({ text: '本地转写结果' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    const onFinal = vi.fn()
    const onEnd = vi.fn()
    const onProgress = vi.fn()
    const provider = createLocalEndpointProvider({
      endpoint: 'http://127.0.0.1:39081',
      runtime: fixture.runtime,
    })

    const session = await provider.start({ lang: 'zh-CN', onFinal, onEnd, onProgress })
    fixture.processor.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array(4_800).fill(0.25) },
    })
    await session.stop()

    expect(fixture.fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fixture.fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:39081/v1/audio/transcriptions')
    const form = init.body as FormData
    expect(form.get('model')).toBe('sensevoice')
    expect(form.get('language')).toBe('zh')
    const audio = form.get('file') as File
    expect(audio.name).toBe('dictation.wav')
    expect(audio.type).toBe('audio/wav')
    expect(audio.size).toBeGreaterThan(44)
    expect(onProgress).toHaveBeenCalledWith({ phase: 'runtime', message: '正在由本地服务转写' })
    expect(onFinal).toHaveBeenCalledWith('本地转写结果')
    expect(onEnd).toHaveBeenCalledOnce()
    expect(onEnd).toHaveBeenCalledWith('stop')
    expect(fixture.stopTrack).toHaveBeenCalledOnce()
    expect(fixture.closeContext).toHaveBeenCalledOnce()
    expect(fixture.waitMock).toHaveBeenCalledWith(600, expect.any(AbortSignal))
  })

  it('transcribes bounded audio segments serially and preserves their order', async () => {
    let resolveFirst: ((response: Response) => void) | undefined
    let request = 0
    const fixture = runtimeFixture(async () => {
      request += 1
      if (request === 1) {
        return new Promise<Response>(resolve => { resolveFirst = resolve })
      }
      return new Response(JSON.stringify({ text: '第二段' }), { status: 200 })
    })
    const onFinal = vi.fn()
    const session = await createLocalEndpointProvider({
      endpoint: 'http://127.0.0.1:39081',
      runtime: fixture.runtime,
      tailCaptureMs: 0,
      segmentMinMs: 1_000,
      segmentSilenceMs: 5_000,
      segmentMaxMs: 1_000,
    }).start({ onFinal })

    fixture.processor.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array(48_000).fill(0.2) },
    })
    await vi.waitFor(() => { expect(fixture.fetchMock).toHaveBeenCalledOnce() })
    fixture.processor.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array(48_000).fill(0.2) },
    })
    expect(fixture.fetchMock).toHaveBeenCalledOnce()

    resolveFirst?.(new Response(JSON.stringify({ text: '第一段' }), { status: 200 }))
    await vi.waitFor(() => { expect(fixture.fetchMock).toHaveBeenCalledTimes(2) })
    await session.stop()

    expect(onFinal.mock.calls).toEqual([['第一段'], ['第二段']])
    for (const [, init] of fixture.fetchMock.mock.calls as [string, RequestInit][]) {
      const audio = (init.body as FormData).get('file') as File
      expect(audio.size).toBeLessThanOrEqual(32_044)
    }
  })

  it('reports voice activity only after sustained speech energy', async () => {
    const fixture = runtimeFixture(async () => new Response(JSON.stringify({ text: '' }), { status: 200 }))
    const onProgress = vi.fn()
    const session = await createLocalEndpointProvider({
      endpoint: 'http://127.0.0.1:39081',
      runtime: fixture.runtime,
    }).start({ onProgress })

    fixture.processor.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array(4_800).fill(0.001) },
    })
    fixture.processor.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array(4_800).fill(0.1) },
    })
    expect(onProgress).not.toHaveBeenCalledWith({ phase: 'voice', message: '已检测到语音' })

    fixture.processor.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array(4_800).fill(0.1) },
    })
    fixture.processor.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array(4_800).fill(0.1) },
    })
    expect(onProgress.mock.calls.filter(([progress]) => progress.phase === 'voice')).toEqual([
      [{ phase: 'voice', message: '已检测到语音' }],
    ])
    await session.abort()
  })

  it('keeps capturing for 600 ms after stop before closing the microphone', async () => {
    let releaseWait: (() => void) | undefined
    const fixture = runtimeFixture(
      async () => new Response(JSON.stringify({ text: '保留尾音' }), { status: 200 }),
      () => new Promise<void>(resolve => { releaseWait = resolve }),
    )
    const session = await createLocalEndpointProvider({
      endpoint: 'http://127.0.0.1:39081',
      runtime: fixture.runtime,
    }).start()
    fixture.processor.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array(4_800).fill(0.2) },
    })

    const stopping = session.stop()
    await vi.waitFor(() => { expect(fixture.waitMock).toHaveBeenCalledWith(600, expect.any(AbortSignal)) })
    expect(fixture.stopTrack).not.toHaveBeenCalled()
    expect(fixture.fetchMock).not.toHaveBeenCalled()
    fixture.processor.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array(4_800).fill(0.2) },
    })

    releaseWait?.()
    await stopping

    const [, init] = fixture.fetchMock.mock.calls[0] as [string, RequestInit]
    const audio = (init.body as FormData).get('file') as File
    expect(audio.size).toBeGreaterThan(6_000)
    expect(fixture.stopTrack).toHaveBeenCalledOnce()
  })

  it('aborts an in-flight endpoint request without emitting a transcript', async () => {
    const fixture = runtimeFixture((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new DOMException('Aborted', 'AbortError')) })
    }))
    const onFinal = vi.fn()
    const onEnd = vi.fn()
    const session = await createLocalEndpointProvider({
      endpoint: 'http://127.0.0.1:39081',
      runtime: fixture.runtime,
    }).start({ onFinal, onEnd })
    fixture.processor.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array(4_800).fill(0.25) },
    })

    const stopping = session.stop()
    await vi.waitFor(() => { expect(fixture.fetchMock).toHaveBeenCalledOnce() })
    await session.abort()
    await stopping

    expect(onFinal).not.toHaveBeenCalled()
    expect(onEnd).toHaveBeenCalledOnce()
    expect(onEnd).toHaveBeenCalledWith('abort')
    expect(fixture.stopTrack).toHaveBeenCalledOnce()
    expect(fixture.closeContext).toHaveBeenCalledOnce()
  })

  it('does not emit a late transcript after cancellation while parsing the response', async () => {
    let resolvePayload: ((value: { text: string }) => void) | undefined
    const fixture = runtimeFixture(async () => ({
      ok: true,
      status: 200,
      json: () => new Promise(resolve => { resolvePayload = resolve }),
    }) as Response)
    const onFinal = vi.fn()
    const onEnd = vi.fn()
    const session = await createLocalEndpointProvider({
      endpoint: 'http://127.0.0.1:39081',
      runtime: fixture.runtime,
    }).start({ onFinal, onEnd })
    fixture.processor.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array([0.1]) },
    })

    const stopping = session.stop()
    await vi.waitFor(() => { expect(resolvePayload).toBeTypeOf('function') })
    await session.abort()
    resolvePayload?.({ text: '不应出现' })
    await stopping

    expect(onFinal).not.toHaveBeenCalled()
    expect(onEnd).toHaveBeenCalledOnce()
    expect(onEnd).toHaveBeenCalledWith('abort')
  })

  it('surfaces a readable endpoint HTTP failure', async () => {
    const fixture = runtimeFixture(async () => new Response(
      JSON.stringify({ detail: 'model unavailable' }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    ))
    const onError = vi.fn()
    const onEnd = vi.fn()
    const session = await createLocalEndpointProvider({
      endpoint: 'http://127.0.0.1:39081',
      runtime: fixture.runtime,
    }).start({ onError, onEnd })
    fixture.processor.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array([0.1]) },
    })
    await session.stop()

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      code: 'endpoint-response',
      message: '本地服务返回 HTTP 503：model unavailable',
    }))
    expect(onEnd).toHaveBeenCalledWith('error')
  })
})
