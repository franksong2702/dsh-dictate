import { describe, expect, it, vi } from 'vitest'
import {
  LocalServiceAutoStartManager,
  LocalServiceController,
  type LocalServiceProcess,
  type LocalServiceRuntime,
} from '../src/local-service.ts'
import {
  parseLocalServiceAutoStartRequest,
  parseLocalServiceAutoStartSettings,
  parseLocalServiceStartRequest,
  parseLocalServiceStatus,
} from '../src/local-service-contract.ts'

class FakeProcess implements LocalServiceProcess {
  readonly pid = 1234
  private readonly listeners = new Map<string, Array<(...args: never[]) => void>>()
  readonly stdout = { on: (event: 'data', listener: (chunk: unknown) => void) => this.add(event, listener) }
  readonly stderr = { on: (event: 'data', listener: (chunk: unknown) => void) => this.add(event, listener) }
  readonly kill = vi.fn((signal: NodeJS.Signals = 'SIGTERM') => {
    this.emit('exit', null, signal)
    return true
  })

  on(event: 'error' | 'exit', listener: (...args: never[]) => void): this {
    this.add(event, listener)
    return this
  }

  private add(event: string, listener: (...args: never[]) => void): this {
    const values = this.listeners.get(event) ?? []
    values.push(listener)
    this.listeners.set(event, values)
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args as never[])
  }
}

function runtime(overrides: Partial<LocalServiceRuntime> = {}): LocalServiceRuntime {
  return {
    env: {
      PATH: '/test/bin',
      DSH_DICTATE_FUNASR_SERVER: '/test/funasr-server',
      DSH_DICTATE_FUNASR_WORKDIR: '/test/work',
    },
    cwd: '/fallback',
    spawn: vi.fn(() => new FakeProcess()),
    fetch: vi.fn(async () => new Response('', { status: 503 })),
    delay: vi.fn(async () => {}),
    executableAvailable: vi.fn(async () => true),
    now: vi.fn(() => 10_000),
    ...overrides,
  }
}

describe('local SenseVoice service controller', () => {
  it('accepts only explicit auto-start settings with a loopback origin', () => {
    expect(parseLocalServiceAutoStartRequest({
      enabled: true,
      origin: 'http://127.0.0.1:3081',
    })).toEqual({ enabled: true, origin: 'http://127.0.0.1:3081' })
    expect(parseLocalServiceAutoStartSettings({
      enabled: false,
      origin: 'http://localhost:3081',
    })).toEqual({ enabled: false, origin: 'http://localhost:3081' })
    expect(() => parseLocalServiceAutoStartRequest({
      enabled: true,
      origin: 'https://example.com',
    })).toThrow('origin must be a loopback URL')
  })

  it('auto-starts from persisted settings and restarts only when the CORS origin changes', async () => {
    const status = vi.fn(async () => ({ phase: 'running', managed: true }))
    const start = vi.fn(async () => ({ phase: 'starting' }))
    const stop = vi.fn(async () => ({ phase: 'stopped' }))
    const manager = new LocalServiceAutoStartManager({ status, start, stop } as never)

    await manager.reconcile({
      localServiceAutoStart: false,
      localServiceOrigin: 'http://127.0.0.1:3081',
    })
    expect(start).not.toHaveBeenCalled()

    await manager.reconcile({
      localServiceAutoStart: true,
      localServiceOrigin: 'http://127.0.0.1:3081',
    })
    expect(start).toHaveBeenCalledWith('http://127.0.0.1:3081')
    expect(stop).not.toHaveBeenCalled()

    await manager.reconcile({
      localServiceAutoStart: true,
      localServiceOrigin: 'http://localhost:3081',
    })
    expect(status).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledOnce()
    expect(start).toHaveBeenLastCalledWith('http://localhost:3081')

    await manager.reconcile({
      localServiceAutoStart: false,
      localServiceOrigin: 'http://localhost:3081',
    })
    expect(stop).toHaveBeenCalledOnce()
  })

  it('accepts only loopback browser origins', () => {
    expect(parseLocalServiceStartRequest({ origin: 'http://127.0.0.1:3081' })).toEqual({
      origin: 'http://127.0.0.1:3081',
    })
    expect(parseLocalServiceStartRequest({ origin: 'http://localhost:3081' })).toEqual({
      origin: 'http://localhost:3081',
    })
    expect(() => parseLocalServiceStartRequest({ origin: 'https://example.com' })).toThrow(
      'origin must be a loopback URL',
    )
    expect(() => parseLocalServiceStartRequest({
      origin: 'http://127.0.0.1:3081/path',
      command: 'anything',
    })).toThrow('origin must be a loopback URL')
  })

  it('reports a stopped service without spawning', async () => {
    const testRuntime = runtime()
    const controller = new LocalServiceController(testRuntime)

    await expect(controller.status()).resolves.toEqual({
      phase: 'stopped',
      stage: 'idle',
      endpoint: 'http://127.0.0.1:39081',
      managed: false,
      message: '本地服务未启动',
      progressPercent: null,
      elapsedSeconds: null,
    })
    expect(testRuntime.spawn).not.toHaveBeenCalled()
  })

  it('starts FunASR with fixed arguments and the validated DSH origin', async () => {
    const child = new FakeProcess()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValue(new Response('{}', { status: 200 }))
    const testRuntime = runtime({
      fetch: fetchMock,
      spawn: vi.fn(() => child),
    })
    const controller = new LocalServiceController(testRuntime)

    await expect(controller.start('http://127.0.0.1:3081')).resolves.toEqual({
      phase: 'starting',
      stage: 'starting-process',
      endpoint: 'http://127.0.0.1:39081',
      managed: true,
      message: '正在启动本地服务进程',
      progressPercent: null,
      elapsedSeconds: 0,
    })
    expect(testRuntime.spawn).toHaveBeenCalledWith('/test/funasr-server', [
      '--host', '127.0.0.1',
      '--port', '39081',
      '--device', 'cpu',
      '--model', 'sensevoice',
      '--cors-origin', 'http://127.0.0.1:3081',
    ], {
      cwd: '/test/work',
      env: testRuntime.env,
    })

    await expect(controller.status()).resolves.toMatchObject({ phase: 'running', managed: true })

    await expect(controller.stop()).resolves.toMatchObject({ phase: 'stopped', managed: false })
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('passes an installed native model path to the internal runtime', async () => {
    const child = new FakeProcess()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValue(new Response('{}', { status: 200 }))
    const testRuntime = runtime({
      fetch: fetchMock,
      spawn: vi.fn(() => child),
    })
    const controller = new LocalServiceController(testRuntime, {
      executable: '/test/dsh-dictate-asr',
      workingDirectory: '/test/install-root',
      modelPath: '/test/install-root/models/SenseVoiceSmall-Q8_0.gguf',
    })

    await controller.start('http://127.0.0.1:3081')
    expect(testRuntime.spawn).toHaveBeenCalledWith('/test/dsh-dictate-asr', [
      '--host', '127.0.0.1',
      '--port', '39081',
      '--device', 'cpu',
      '--model-path', '/test/install-root/models/SenseVoiceSmall-Q8_0.gguf',
      '--cors-origin', 'http://127.0.0.1:3081',
    ], expect.objectContaining({ cwd: '/test/install-root' }))
    await controller.stop()
  })

  it('serializes concurrent starts before the first health check completes', async () => {
    let releaseInitialHealth!: (response: Response) => void
    const initialHealth = new Promise<Response>(resolve => { releaseInitialHealth = resolve })
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => initialHealth)
      .mockResolvedValue(new Response('', { status: 503 }))
    const testRuntime = runtime({ fetch: fetchMock })
    const controller = new LocalServiceController(testRuntime)

    const first = controller.start('http://127.0.0.1:3081')
    const second = controller.start('http://127.0.0.1:3081')
    expect(testRuntime.spawn).not.toHaveBeenCalled()

    releaseInitialHealth(new Response('', { status: 503 }))
    await Promise.all([first, second])
    expect(testRuntime.spawn).toHaveBeenCalledOnce()
    await controller.stop()
  })

  it('restarts a managed process when the requested CORS origin changes on first reconcile', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValue(new Response('{}', { status: 200 }))
    const spawn = vi.fn(() => new FakeProcess())
    const testRuntime = runtime({ fetch: fetchMock, spawn })
    const controller = new LocalServiceController(testRuntime)
    const manager = new LocalServiceAutoStartManager(controller)

    await controller.start('http://127.0.0.1:3080')
    await new Promise(resolve => setTimeout(resolve, 0))
    await manager.reconcile({
      localServiceAutoStart: true,
      localServiceOrigin: 'http://127.0.0.1:3081',
    })

    expect(spawn).toHaveBeenCalledTimes(2)
    expect(spawn.mock.calls[1]?.[1]).toContain('http://127.0.0.1:3081')
    await controller.stop()
  })

  it('reports only model-download percentages observed in server output', async () => {
    const child = new FakeProcess()
    const testRuntime = runtime({ spawn: vi.fn(() => child) })
    const controller = new LocalServiceController(testRuntime)

    await controller.start('http://127.0.0.1:3081')
    child.emit('data', 'Downloading 20 files from model hub')
    await expect(controller.status()).resolves.toMatchObject({
      phase: 'starting',
      stage: 'checking-model',
      progressPercent: null,
      message: '正在检查 SenseVoice 模型文件',
    })

    child.emit('data', '\u001b[1Amodel.pt: 42%|████▏     | 393M/936M')
    await expect(controller.status()).resolves.toMatchObject({
      phase: 'starting',
      stage: 'downloading-model',
      progressPercent: 42,
      message: '正在下载 SenseVoice 模型（42%）',
    })

    child.emit('data', 'funasr version: 1.2.7')
    await expect(controller.status()).resolves.toMatchObject({
      phase: 'starting',
      stage: 'loading-model',
      progressPercent: null,
    })

    child.emit('data', 'Application startup complete')
    await expect(controller.status()).resolves.toMatchObject({
      phase: 'starting',
      stage: 'checking-health',
      progressPercent: null,
    })
  })

  it('rejects invalid service progress from the host boundary', () => {
    expect(() => parseLocalServiceStatus({
      phase: 'starting',
      stage: 'downloading-model',
      endpoint: 'http://127.0.0.1:39081',
      managed: true,
      message: '下载中',
      progressPercent: 101,
      elapsedSeconds: 3,
    })).toThrow('local service returned invalid status')
  })

  it('does not spawn when the host executable is unavailable', async () => {
    const testRuntime = runtime({ executableAvailable: vi.fn(async () => false) })
    const controller = new LocalServiceController(testRuntime)

    await expect(controller.start('http://127.0.0.1:3081')).resolves.toMatchObject({
      phase: 'error',
      managed: false,
      message: expect.stringContaining('DSH_DICTATE_FUNASR_SERVER'),
    })
    expect(testRuntime.spawn).not.toHaveBeenCalled()
  })

  it('recognizes but refuses to stop an externally managed service', async () => {
    const testRuntime = runtime({
      fetch: vi.fn(async () => new Response('{}', { status: 200 })),
    })
    const controller = new LocalServiceController(testRuntime)

    await expect(controller.status()).resolves.toMatchObject({ phase: 'running', managed: false })
    await expect(controller.stop()).resolves.toMatchObject({
      phase: 'running',
      managed: false,
      message: '服务由插件外部启动，不能从此处停止',
    })
    expect(testRuntime.spawn).not.toHaveBeenCalled()
  })
})
