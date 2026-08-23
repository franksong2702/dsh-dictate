import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { delimiter, isAbsolute } from 'node:path'
import {
  LOCAL_SERVICE_ENDPOINT,
  parseLocalServiceStartRequest,
  type LocalServiceStage,
  type LocalServiceStatus,
} from './local-service-contract.ts'

export interface LocalServiceAutoStartConfig {
  readonly localServiceAutoStart: boolean
  readonly localServiceOrigin: string
}

interface LocalServiceLifecycleControl {
  status(): Promise<Pick<LocalServiceStatus, 'phase' | 'managed'>>
  start(origin: string): Promise<Pick<LocalServiceStatus, 'phase'>>
  stop(): Promise<Pick<LocalServiceStatus, 'phase'>>
}

/** Reconcile one persisted auto-start choice without stopping a service when the choice is disabled. */
export class LocalServiceAutoStartManager {
  private previousOrigin: string | undefined

  constructor(private readonly service: LocalServiceLifecycleControl) {}

  async reconcile(config: LocalServiceAutoStartConfig): Promise<void> {
    if (!config.localServiceAutoStart) return
    const origin = parseLocalServiceStartRequest({ origin: config.localServiceOrigin }).origin
    if (this.previousOrigin !== undefined && this.previousOrigin !== origin) {
      const status = await this.service.status()
      if (status.managed && status.phase !== 'stopped') await this.service.stop()
    }
    this.previousOrigin = origin
    await this.service.start(origin)
  }
}

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
  now(): number
}

export interface LocalServiceControllerOptions {
  readonly executable?: string
  readonly workingDirectory?: string
  readonly modelPath?: string
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
    now: () => Date.now(),
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
  private readonly modelPath: string | undefined
  private process: LocalServiceProcess | undefined
  private phase: LocalServiceStatus['phase'] = 'stopped'
  private stage: LocalServiceStage = 'idle'
  private message = '本地服务未启动'
  private progressPercent: number | null = null
  private startedAt: number | undefined
  private output = ''
  private startPromise: Promise<LocalServiceStatus> | undefined
  private readinessPromise: Promise<LocalServiceStatus> | undefined
  private stopPromise: Promise<LocalServiceStatus> | undefined
  private requestedStop = false
  private activeOrigin: string | undefined

  constructor(
    runtime: LocalServiceRuntime = processRuntime(),
    options: LocalServiceControllerOptions = {},
  ) {
    this.runtime = runtime
    this.executable = options.executable?.trim()
      || runtime.env.DSH_DICTATE_FUNASR_SERVER?.trim()
      || DEFAULT_EXECUTABLE
    this.workingDirectory = options.workingDirectory?.trim()
      || runtime.env.DSH_DICTATE_FUNASR_WORKDIR?.trim()
      || runtime.cwd
    this.modelPath = options.modelPath?.trim() || undefined
  }

  private snapshot(managed = this.process !== undefined): LocalServiceStatus {
    return {
      phase: this.phase,
      stage: this.stage,
      endpoint: LOCAL_SERVICE_ENDPOINT,
      managed,
      message: this.message,
      progressPercent: this.progressPercent,
      elapsedSeconds: this.startedAt === undefined
        ? null
        : Math.max(0, Math.floor((this.runtime.now() - this.startedAt) / 1_000)),
    }
  }

  private updateStartupStatus(): void {
    if (this.phase !== 'starting') return
    const output = this.output.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    const latestIndex = (pattern: RegExp): number => [...output.matchAll(pattern)].at(-1)?.index ?? -1
    const healthIndex = latestIndex(/Application startup complete|Uvicorn running|Docs:\s+http|URL:\s+http/g)
    const percentages = [...output.matchAll(/model\.pt:\s*(\d{1,3})%/g)]
    const latestPercentage = percentages.at(-1)
    const modelCheckIndex = latestIndex(/Downloading\s+\d+\s+files|download models from model hub/gi)
    const downloadIndex = latestPercentage?.index ?? -1
    const loadingIndex = latestIndex(/Loading fallback model|funasr version:/gi)
    const latestStageIndex = Math.max(healthIndex, modelCheckIndex, downloadIndex, loadingIndex)
    if (latestStageIndex === healthIndex && healthIndex >= 0) {
      this.stage = 'checking-health'
      this.message = 'SenseVoice 模型已加载，正在检查服务'
      this.progressPercent = null
      return
    }
    if (latestStageIndex === downloadIndex && downloadIndex >= 0) {
      this.stage = 'downloading-model'
      this.progressPercent = Math.min(100, Number(latestPercentage?.[1]))
      this.message = `正在下载 SenseVoice 模型（${this.progressPercent}%）`
      return
    }
    if (latestStageIndex === modelCheckIndex && modelCheckIndex >= 0) {
      this.stage = 'checking-model'
      this.progressPercent = null
      this.message = '正在检查 SenseVoice 模型文件'
      return
    }
    if (latestStageIndex === loadingIndex && loadingIndex >= 0) {
      this.stage = 'loading-model'
      this.message = '正在加载 SenseVoice 模型到内存'
      this.progressPercent = null
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
      this.stage = this.process === undefined ? 'external' : 'ready'
      this.message = this.process === undefined ? '检测到外部启动的本地服务' : '本地 SenseVoice 服务运行中'
      this.progressPercent = null
      return this.snapshot()
    }
    if (this.phase === 'starting' || this.phase === 'stopping') return this.snapshot()
    if (this.process !== undefined) {
      this.phase = 'error'
      this.stage = 'failed'
      this.message = '本地服务进程存在，但健康检查失败'
      return this.snapshot()
    }
    if (this.phase !== 'error') {
      this.phase = 'stopped'
      this.stage = 'idle'
      this.message = '本地服务未启动'
      this.progressPercent = null
      this.startedAt = undefined
    }
    return this.snapshot(false)
  }

  start(origin: string, signal?: AbortSignal): Promise<LocalServiceStatus> {
    if (this.startPromise !== undefined) return Promise.resolve(this.snapshot(this.process !== undefined))
    if (this.process === undefined && this.phase !== 'starting') this.requestedStop = false
    const initialPromise = this.startImpl(origin, signal)
    const readiness = initialPromise.then(
      async () => { await this.readinessPromise },
      () => undefined,
    )
    let tracked!: Promise<LocalServiceStatus>
    tracked = readiness.then(() => this.snapshot(this.process !== undefined)).finally(() => {
      if (this.startPromise === tracked) this.startPromise = undefined
    })
    this.startPromise = tracked
    return initialPromise
  }

  private async startImpl(origin: string, signal?: AbortSignal): Promise<LocalServiceStatus> {
    if (await this.healthy()) {
      if (signal?.aborted || this.requestedStop) return this.stoppedSnapshot()
      if (this.process !== undefined && this.activeOrigin !== origin) {
        await this.stopImpl()
        this.requestedStop = false
      } else {
        this.phase = 'running'
        this.stage = this.process === undefined ? 'external' : 'ready'
        this.message = this.process === undefined ? '检测到外部启动的本地服务' : '本地 SenseVoice 服务运行中'
        this.progressPercent = null
        return this.snapshot()
      }
    }
    if (signal?.aborted || this.requestedStop) return this.stoppedSnapshot()
    if (this.process !== undefined) {
      this.phase = 'error'
      this.stage = 'failed'
      this.message = '旧的本地服务进程尚未退出'
      return this.snapshot()
    }
    this.startedAt = this.runtime.now()
    this.phase = 'starting'
    this.stage = 'checking-runtime'
    this.message = '正在检查 funasr-server 运行环境'
    this.progressPercent = null
    if (!await this.runtime.executableAvailable(this.executable, this.runtime.env)) {
      this.phase = 'error'
      this.stage = 'failed'
      this.message = '未找到 funasr-server；请在 DSH host 环境配置 DSH_DICTATE_FUNASR_SERVER'
      return this.snapshot(false)
    }
    if (signal?.aborted || this.requestedStop) return this.stoppedSnapshot()

    this.stage = 'starting-process'
    this.message = '正在启动本地服务进程'
    this.output = ''
    this.requestedStop = false
    const args = [
      '--host', '127.0.0.1',
      '--port', String(DEFAULT_PORT),
      '--device', 'cpu',
      ...(this.modelPath === undefined ? ['--model', 'sensevoice'] : ['--model-path', this.modelPath]),
      '--cors-origin', origin,
    ]
    const child = this.runtime.spawn(this.executable, args, {
      cwd: this.workingDirectory,
      env: this.runtime.env,
    })
    this.process = child
    this.activeOrigin = origin
    const abortHandler = (): void => {
      if (this.process !== child) return
      this.requestedStop = true
      child.kill('SIGTERM')
    }
    signal?.addEventListener('abort', abortHandler, { once: true })
    child.stdout.on('data', chunk => {
      this.output = appendOutput(this.output, chunk)
      this.updateStartupStatus()
    })
    child.stderr.on('data', chunk => {
      this.output = appendOutput(this.output, chunk)
      this.updateStartupStatus()
    })
    child.on('error', (error) => {
      if (this.process !== child) return
      this.process = undefined
      this.activeOrigin = undefined
      this.phase = 'error'
      this.stage = 'failed'
      this.message = `无法启动本地服务：${error.message}`
    })
    child.on('exit', (code, signal) => {
      if (this.process !== child) return
      this.process = undefined
      this.activeOrigin = undefined
      if (this.requestedStop) {
        if (this.phase !== 'error') {
          this.phase = 'stopped'
          this.stage = 'idle'
          this.message = '本地服务已停止'
          this.progressPercent = null
          this.startedAt = undefined
        }
      } else {
        this.phase = 'error'
        this.stage = 'failed'
        const detail = this.output.trim().split('\n').at(-1)?.slice(0, 240)
        this.message = `本地服务意外退出（${signal ?? code ?? 'unknown'}）${detail === undefined ? '' : `：${detail}`}`
      }
    })

    const readiness = this.waitUntilReady(child)
    let trackedReadiness!: Promise<LocalServiceStatus>
    trackedReadiness = readiness.finally(() => {
      signal?.removeEventListener('abort', abortHandler)
      if (this.readinessPromise === trackedReadiness) this.readinessPromise = undefined
    })
    this.readinessPromise = trackedReadiness
    return this.snapshot(true)
  }

  private stoppedSnapshot(): LocalServiceStatus {
    this.phase = 'stopped'
    this.stage = 'idle'
    this.message = '本地服务未启动'
    this.progressPercent = null
    this.startedAt = undefined
    return this.snapshot(false)
  }

  private async waitUntilReady(child: LocalServiceProcess): Promise<LocalServiceStatus> {
    for (let attempt = 0; attempt < READY_ATTEMPTS; attempt += 1) {
      if (this.process !== child) return this.snapshot(false)
      if (await this.healthy()) {
        this.phase = 'running'
        this.stage = 'ready'
        this.message = '本地 SenseVoice 服务运行中'
        this.progressPercent = null
        return this.snapshot(true)
      }
      await this.runtime.delay(READY_INTERVAL_MS)
    }
    this.phase = 'error'
    this.stage = 'failed'
    const detail = this.output.trim().split('\n').at(-1)?.slice(0, 240)
    this.message = `SenseVoice 在 ${READY_TIMEOUT_MS / 1_000} 秒内未通过健康检查${detail === undefined ? '' : `：${detail}`}`
    this.requestedStop = true
    child.kill('SIGTERM')
    return this.snapshot(false)
  }

  async stop(): Promise<LocalServiceStatus> {
    if (this.stopPromise !== undefined) return this.stopPromise
    this.requestedStop = true
    this.stopPromise = this.stopImpl().finally(() => { this.stopPromise = undefined })
    return this.stopPromise
  }

  private async stopImpl(): Promise<LocalServiceStatus> {
    const child = this.process
    if (child === undefined) {
      if (await this.healthy()) {
        this.phase = 'running'
        this.stage = 'external'
        this.message = '服务由插件外部启动，不能从此处停止'
        this.progressPercent = null
        return this.snapshot(false)
      }
      this.phase = 'stopped'
      this.stage = 'idle'
      this.message = '本地服务未启动'
      this.progressPercent = null
      this.startedAt = undefined
      return this.snapshot(false)
    }
    this.phase = 'stopping'
    this.stage = 'stopping'
    this.message = '正在停止本地服务'
    this.progressPercent = null
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
    this.requestedStop = true
    if (this.process !== undefined) await this.stop()
    if (this.startPromise !== undefined) await this.startPromise.catch(() => {})
    if (this.process !== undefined) await this.stop()
  }
}
