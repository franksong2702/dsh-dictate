import { describe, expect, it, vi } from 'vitest'
import {
  LocalServiceController,
  type LocalServiceProcess,
  type LocalServiceRuntime,
} from '../src/local-service.ts'
import { parseLocalServiceStartRequest } from '../src/local-service-contract.ts'

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
    ...overrides,
  }
}

describe('local SenseVoice service controller', () => {
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
      endpoint: 'http://127.0.0.1:39081',
      managed: false,
      message: '本地服务未启动',
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
      endpoint: 'http://127.0.0.1:39081',
      managed: true,
      message: '正在加载 SenseVoice 模型',
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
