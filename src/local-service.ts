import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { delimiter, isAbsolute } from 'node:path'
import {
  LOCAL_SERVICE_ENDPOINT,
  type LocalServiceStatus,
} from './local-service-contract.ts'

const DEFAULT_EXECUTABLE = 'funasr-server'
const DEFAULT_PORT = 39_081
const READY_INTERVAL_MS = 500
const READY_TIMEOUT_MS = 180_000
const READY_ATTEMPTS = READY_TIMEOUT_MS / READY_INTERVAL_MS
const STOP_TIMEOUT_MS = 3_000
const OUTPUT_LIMIT = 2_000

export interface LocalServiceProcess {
  readonly pid?: number
  readonly stdout: { on(event: 'data', listener: (chunk: unknown) => void): unknown }
  readonly stderr: { on(event: 'data', listener: (chunk: unknown) => void): unknown }
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

export interface LocalServiceRuntime {
  readonly env: NodeJS.ProcessEnv
  readonly cwd: string
  spawn(file: string, args: readonly string[], options: {
    readonly cwd: string
    readonly env: NodeJS.ProcessEnv
  }): LocalServiceProcess
  fetch(input: string, init: RequestInit): Promise<Response>
  delay(milliseconds: number): Promise<void>
  executableAvailable(file: string, env: NodeJS.ProcessEnv): Promise<boolean>
}

function processRuntime(): LocalServiceRuntime {
  return {
    env: process.env,
    cwd: process.cwd(),
    spawn: (file, args, options) => spawn(file, args, {
      ...options,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as unknown as LocalServiceProcess,
    fetch: (input, init) => fetch(input, init),
    delay: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    executableAvailable: async (file, env) => {
      if (isAbsolute(file)) {
        try {
          await access(file)
          return true
        } catch {
          return false
        }
      }
      const path = env.PATH ?? ''
      for (const directory of path.split(delimiter).filter(Boolean)) {
        try {
          await access(`${directory}/${file}`)
          return true
        } catch {
          // Continue through the bounded PATH entries.
        }
      }
      return false
    },
  }
}

function appendOutput(current: string, chunk: unknown): string {
  const next = `${current}${String(chunk)}`
  return next.length <= OUTPUT_LIMIT ? next : next.slice(-OUTPUT_LIMIT)
}

/** Own one loopback-only FunASR child process for the lifetime of the host plugin. */
export class LocalServiceController {
  private readonly runtime: LocalServiceRuntime
  private readonly executable: string
  private readonly workingDirectory: string
  private process: LocalServiceProcess | undefined
  private phase: LocalServiceStatus['phase'] = 'stopped'
  private message = '本地服务未启动'
  private output = ''
  private startPromise: Promise<LocalServiceStatus> | undefined
  private stopPromise: Promise<LocalServiceStatus> | undefined
  private requestedStop = false

  constructor(runtime: LocalServiceRuntime = processRuntime()) {
    this.runtime = runtime
    this.executable = runtime.env.DSH_DICTATE_FUNASR_SERVER?.trim() || DEFAULT_EXECUTABLE
    this.workingDirectory = runtime.env.DSH_DICTATE_FUNASR_WORKDIR?.trim() || runtime.cwd
  }

  private snapshot(managed = this.process !== undefined): LocalServiceStatus {
    return {
      phase: this.phase,
      endpoint: LOCAL_SERVICE_ENDPOINT,
      managed,
      message: this.message,
    }
  }

  private async healthy(): Promise<boolean> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 750)
    try {
      const response = await this.runtime.fetch(`${LOCAL_SERVICE_ENDPOINT}/v1/models`, {
        method: 'GET',
        signal: controller.signal,
      })
      return response.ok
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  async status(): Promise<LocalServiceStatus> {
    if (await this.healthy()) {
      this.phase = 'running'
      this.message = this.process === undefined ? '检测到外部启动的本地服务' : '本地 SenseVoice 服务运行中'
      return this.snapshot()
    }
    if (this.phase === 'starting' || this.phase === 'stopping') return this.snapshot()
    if (this.process !== undefined) {
      this.phase = 'error'
      this.message = '本地服务进程存在，但健康检查失败'
      return this.snapshot()
    }
    if (this.phase !== 'error') {
      this.phase = 'stopped'
      this.message = '本地服务未启动'
    }
    return this.snapshot(false)
  }

  async start(origin: string): Promise<LocalServiceStatus> {
    if (this.startPromise !== undefined) return this.snapshot()
    return this.startImpl(origin)
  }

  private async startImpl(origin: string): Promise<LocalServiceStatus> {
    if (await this.healthy()) {
      this.phase = 'running'
      this.message = this.process === undefined ? '检测到外部启动的本地服务' : '本地 SenseVoice 服务运行中'
      return this.snapshot()
    }
    if (this.process !== undefined) {
      this.phase = 'error'
      this.message = '旧的本地服务进程尚未退出'
      return this.snapshot()
    }
    if (!await this.runtime.executableAvailable(this.executable, this.runtime.env)) {
      this.phase = 'error'
      this.message = '未找到 funasr-server；请在 DSH host 环境配置 DSH_DICTATE_FUNASR_SERVER'
      return this.snapshot(false)
    }

    this.phase = 'starting'
    this.message = '正在加载 SenseVoice 模型'
    this.output = ''
    this.requestedStop = false
    const child = this.runtime.spawn(this.executable, [
      '--host', '127.0.0.1',
      '--port', String(DEFAULT_PORT),
      '--device', 'cpu',
      '--model', 'sensevoice',
      '--cors-origin', origin,
    ], {
      cwd: this.workingDirectory,
      env: this.runtime.env,
    })
    this.process = child
    child.stdout.on('data', chunk => { this.output = appendOutput(this.output, chunk) })
    child.stderr.on('data', chunk => { this.output = appendOutput(this.output, chunk) })
    child.on('error', (error) => {
      if (this.process !== child) return
      this.process = undefined
      this.phase = 'error'
      this.message = `无法启动本地服务：${error.message}`
    })
    child.on('exit', (code, signal) => {
      if (this.process !== child) return
      this.process = undefined
      if (this.requestedStop) {
        this.phase = 'stopped'
        this.message = '本地服务已停止'
      } else {
        this.phase = 'error'
        const detail = this.output.trim().split('\n').at(-1)?.slice(0, 240)
        this.message = `本地服务意外退出（${signal ?? code ?? 'unknown'}）${detail === undefined ? '' : `：${detail}`}`
      }
    })

    this.startPromise = this.waitUntilReady(child).finally(() => { this.startPromise = undefined })
    return this.snapshot(true)
  }

  private async waitUntilReady(child: LocalServiceProcess): Promise<LocalServiceStatus> {
    for (let attempt = 0; attempt < READY_ATTEMPTS; attempt += 1) {
      if (this.process !== child) return this.snapshot(false)
      if (await this.healthy()) {
        this.phase = 'running'
        this.message = '本地 SenseVoice 服务运行中'
        return this.snapshot(true)
      }
      await this.runtime.delay(READY_INTERVAL_MS)
    }
    this.phase = 'error'
    const detail = this.output.trim().split('\n').at(-1)?.slice(0, 240)
    this.message = `SenseVoice 在 ${READY_TIMEOUT_MS / 1_000} 秒内未通过健康检查${detail === undefined ? '' : `：${detail}`}`
    this.requestedStop = true
    child.kill('SIGTERM')
    return this.snapshot(true)
  }

  async stop(): Promise<LocalServiceStatus> {
    if (this.stopPromise !== undefined) return this.stopPromise
    this.stopPromise = this.stopImpl().finally(() => { this.stopPromise = undefined })
    return this.stopPromise
  }

  private async stopImpl(): Promise<LocalServiceStatus> {
    const child = this.process
    if (child === undefined) {
      if (await this.healthy()) {
        this.phase = 'running'
        this.message = '服务由插件外部启动，不能从此处停止'
        return this.snapshot(false)
      }
      this.phase = 'stopped'
      this.message = '本地服务未启动'
      return this.snapshot(false)
    }
    this.phase = 'stopping'
    this.message = '正在停止本地服务'
    this.requestedStop = true
    child.kill('SIGTERM')
    for (let elapsed = 0; elapsed < STOP_TIMEOUT_MS; elapsed += 100) {
      if (this.process !== child) return this.snapshot(false)
      await this.runtime.delay(100)
    }
    child.kill('SIGKILL')
    return this.snapshot(true)
  }

  async dispose(): Promise<void> {
    if (this.process !== undefined) await this.stop()
  }
}
