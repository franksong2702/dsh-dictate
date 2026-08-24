import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LocalServiceInstallStatus } from './local-service-contract.ts'

const MODEL_FILENAME = 'SenseVoiceSmall-Q8_0.gguf'
const MODEL_SIZE = 252_684_608
const MODEL_SHA256 = '6c759ee4c9748c9b3f7a5a60ca74f0f7e685fb9d45d1378fce7cfd62f59adf29'
const MODEL_URL = 'https://huggingface.co/handy-computer/SenseVoiceSmall-gguf/resolve/4a08b8e900b38a977e32eb08d5d0697d6e72ba04/SenseVoiceSmall-Q8_0.gguf'
const MACOS_RUNTIME_SIZE = 4_621_600
const MACOS_RUNTIME_SHA256 = 'dab83ea0c5bfa95b8e9c94f804da7d88c9fc5657ac5ac8503554ec338d5db52f'
const WINDOWS_RUNTIME_SIZE = 5_067_776
const WINDOWS_RUNTIME_SHA256 = '31aa161a992f396ec12712a68fd881f3778d32b173c2b795918ffcc80d38a29f'
const MANIFEST_FILENAME = 'install.json'
const COPY_CHUNK_BYTES = 1024 * 1024

export interface InstallerArtifacts {
  readonly modelFilename: string
  readonly modelSize: number
  readonly modelSha256: string
  readonly modelUrl: string
  readonly runtimeFilename?: string
  readonly bundledRuntimeSource?: string
  readonly runtimeSize?: number
  readonly runtimeSha256?: string
}

function defaultArtifacts(runtime: Pick<LocalServiceInstallerRuntime, 'platform' | 'arch'>): InstallerArtifacts {
  const shared = {
    modelFilename: MODEL_FILENAME,
    modelSize: MODEL_SIZE,
    modelSha256: MODEL_SHA256,
    modelUrl: MODEL_URL,
  }
  if (runtime.platform === 'darwin' && runtime.arch === 'arm64') {
    return {
      ...shared,
      runtimeFilename: 'dsh-dictate-asr',
      bundledRuntimeSource: fileURLToPath(new URL('../native/darwin-arm64/dsh-dictate-asr', import.meta.url)),
      runtimeSize: MACOS_RUNTIME_SIZE,
      runtimeSha256: MACOS_RUNTIME_SHA256,
    }
  }
  if (runtime.platform === 'win32' && runtime.arch === 'x64') {
    return {
      ...shared,
      runtimeFilename: 'dsh-dictate-asr.exe',
      bundledRuntimeSource: fileURLToPath(new URL('../native/win32-x64/dsh-dictate-asr.exe', import.meta.url)),
      runtimeSize: WINDOWS_RUNTIME_SIZE,
      runtimeSha256: WINDOWS_RUNTIME_SHA256,
    }
  }
  return shared
}

export interface LocalServiceInstallerRuntime {
  readonly env: NodeJS.ProcessEnv
  readonly platform: NodeJS.Platform
  readonly arch: string
  fetch(input: string, init: RequestInit): Promise<Response>
  delay(milliseconds: number, signal: AbortSignal): Promise<void>
}

function processRuntime(): LocalServiceInstallerRuntime {
  return {
    env: process.env,
    platform: process.platform,
    arch: process.arch,
    fetch: (input, init) => fetch(input, init),
    delay: (milliseconds, signal) => new Promise((resolveDelay, reject) => {
      if (milliseconds <= 0) { resolveDelay(); return }
      const timer = setTimeout(resolveDelay, milliseconds)
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(signal.reason ?? new Error('installation cancelled'))
      }, { once: true })
    }),
  }
}

interface InstallManifest {
  readonly version: 1
  readonly platform: string
  readonly runtimeSha256: string
  readonly modelSha256: string
  readonly modelSize: number
}

/** Install one pinned native SenseVoice runtime below the current DSH_HOME. */
export class LocalServiceInstaller {
  readonly installRoot: string
  readonly executablePath: string
  readonly modelPath: string
  private readonly runtime: LocalServiceInstallerRuntime
  private readonly artifacts: InstallerArtifacts
  private readonly manifestPath: string
  readonly available: boolean
  private phase: LocalServiceInstallStatus['phase']
  private stage: LocalServiceInstallStatus['stage'] = 'idle'
  private message: string
  private progressPercent: number | null = null
  private completedBytes: number | null = null
  private totalBytes: number | null = null
  private task: Promise<void> | undefined
  private controller: AbortController | undefined
  private verifiedFingerprint: string | undefined

  constructor(
    runtime: LocalServiceInstallerRuntime = processRuntime(),
    artifacts: InstallerArtifacts = defaultArtifacts(runtime),
  ) {
    this.runtime = runtime
    this.artifacts = artifacts
    const dshHome = resolve(runtime.env.DSH_HOME?.trim() || join(homedir(), '.dsh'))
    this.installRoot = join(dshHome, 'runtimes', 'dsh-dictate', 'local-asr')
    const runtimeFilename = artifacts.runtimeFilename
      ?? (runtime.platform === 'win32' ? 'dsh-dictate-asr.exe' : 'dsh-dictate-asr')
    this.executablePath = join(this.installRoot, 'runtime', runtimeFilename)
    this.modelPath = join(this.installRoot, 'models', artifacts.modelFilename)
    this.manifestPath = join(this.installRoot, MANIFEST_FILENAME)
    const supported = (runtime.platform === 'darwin' && runtime.arch === 'arm64')
      || (runtime.platform === 'win32' && runtime.arch === 'x64')
    this.available = supported
    this.phase = supported ? 'not-installed' : 'unsupported'
    this.message = supported
      ? '尚未安装本地 ASR 环境'
      : `当前版本暂不支持 ${runtime.platform}-${runtime.arch}`
  }

  private snapshot(): LocalServiceInstallStatus {
    return {
      available: this.available,
      phase: this.phase,
      stage: this.stage,
      message: this.message,
      progressPercent: this.progressPercent,
      completedBytes: this.completedBytes,
      totalBytes: this.totalBytes,
      platform: `${this.runtime.platform}-${this.runtime.arch}`,
      installPath: this.installRoot,
    }
  }

  async status(): Promise<LocalServiceInstallStatus> {
    if (this.phase === 'unsupported' || this.task !== undefined) return this.snapshot()
    if (await this.validInstall()) {
      this.phase = 'installed'
      this.stage = 'ready'
      this.message = '本地 ASR 已安装并通过校验'
      this.progressPercent = 100
      this.completedBytes = null
      this.totalBytes = null
    } else if (this.phase === 'installed') {
      this.phase = 'error'
      this.stage = 'failed'
      this.message = '本地 ASR 文件缺失或校验信息不一致，请重新安装'
      this.progressPercent = null
    }
    return this.snapshot()
  }

  start(onInstalled: (signal: AbortSignal) => Promise<void>): Promise<LocalServiceInstallStatus> {
    if (this.phase === 'unsupported' || !this.available || this.task !== undefined) {
      return Promise.resolve(this.snapshot())
    }
    const controller = new AbortController()
    this.controller = controller
    this.phase = 'installing'
    this.stage = 'copying-runtime'
    this.message = '正在准备原生 ASR 运行程序'
    this.progressPercent = 0
    this.completedBytes = 0
    this.totalBytes = null
    const task = this.finishStart(controller.signal, onInstalled).catch((error: unknown) => {
      if (controller.signal.aborted) {
        this.phase = 'not-installed'
        this.stage = 'cancelled'
        this.message = '安装已取消，已保留模型下载进度'
      } else {
        this.phase = 'error'
        this.stage = 'failed'
        this.message = error instanceof Error ? error.message : '本地 ASR 安装失败'
      }
      this.progressPercent = null
      this.completedBytes = null
      this.totalBytes = null
    }).finally(() => {
      this.task = undefined
      this.controller = undefined
    })
    this.task = task
    return Promise.resolve(this.snapshot())
  }

  private async finishStart(
    signal: AbortSignal,
    onInstalled: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    if (await this.validInstall()) {
      this.phase = 'installed'
      this.stage = 'ready'
      this.message = '本地 ASR 已安装并通过校验'
      this.progressPercent = 100
      this.completedBytes = null
      this.totalBytes = null
    } else {
      await this.install(signal)
      this.phase = 'installed'
      this.stage = 'ready'
      this.message = '本地 ASR 安装完成，正在启动服务'
      this.progressPercent = 100
      this.completedBytes = null
      this.totalBytes = null
    }
    await this.awaitAbortable(onInstalled(signal), signal)
    this.message = '本地 ASR 已安装并通过校验'
  }

  async cancel(): Promise<LocalServiceInstallStatus> {
    this.controller?.abort(new Error('installation cancelled'))
    await this.task
    return this.snapshot()
  }

  async dispose(): Promise<void> {
    await this.cancel()
  }

  private async install(signal: AbortSignal): Promise<void> {
    const configuredRuntimeSource = this.runtime.env.DSH_DICTATE_NATIVE_RUNTIME_SOURCE?.trim()
    const runtimeSource = configuredRuntimeSource || this.artifacts.bundledRuntimeSource
    if (runtimeSource === undefined || runtimeSource === '' || !isAbsolute(runtimeSource)) {
      throw new Error('当前发行包缺少原生 ASR 运行程序，请重新安装插件')
    }
    const runtimeSize = (await stat(runtimeSource)).size
    this.totalBytes = runtimeSize + this.artifacts.modelSize
    await mkdir(join(this.installRoot, 'runtime'), { recursive: true })
    await mkdir(join(this.installRoot, 'models'), { recursive: true })

    const runtimePartial = `${this.executablePath}.partial`
    const runtimeSha256 = await this.copyLocalArtifact(
      runtimeSource,
      runtimePartial,
      0,
      'copying-runtime',
      '正在安装原生 ASR 运行程序',
      signal,
    )
    if (configuredRuntimeSource === undefined || configuredRuntimeSource === '') {
      if (runtimeSize !== this.artifacts.runtimeSize || runtimeSha256 !== this.artifacts.runtimeSha256) {
        throw new Error('原生 ASR 运行程序完整性校验失败，请重新安装插件')
      }
    }
    if (this.runtime.platform !== 'win32') await chmod(runtimePartial, 0o755)
    await rename(runtimePartial, this.executablePath)

    let modelSha256 = await this.validModelSha256(this.modelPath)
    let modelSize = this.artifacts.modelSize
    if (modelSha256 === undefined) {
      const modelSource = this.runtime.env.DSH_DICTATE_NATIVE_MODEL_SOURCE?.trim()
      if (modelSource !== undefined && modelSource !== '') {
        if (!isAbsolute(modelSource)) throw new Error('本地模型安装源必须是绝对路径')
        await this.copyLocalArtifact(
          modelSource,
          `${this.modelPath}.partial`,
          runtimeSize,
          'copying-model',
          '正在安装 SenseVoice Q8 模型',
          signal,
        )
      } else {
        await this.downloadModel(runtimeSize, signal)
      }
      this.stage = 'verifying'
      this.message = '正在校验 SenseVoice 模型完整性'
      modelSize = (await stat(`${this.modelPath}.partial`)).size
      if (modelSize !== this.artifacts.modelSize) {
        throw new Error(`SenseVoice 模型大小不正确：${modelSize}`)
      }
      modelSha256 = await sha256(`${this.modelPath}.partial`)
      if (modelSha256 !== this.artifacts.modelSha256) {
        throw new Error('SenseVoice 模型完整性校验失败')
      }
      await rename(`${this.modelPath}.partial`, this.modelPath)
    } else {
      this.stage = 'verifying'
      this.message = '已复用通过校验的 SenseVoice 模型'
      this.updateProgress(runtimeSize + modelSize)
    }
    const manifest: InstallManifest = {
      version: 1,
      platform: `${this.runtime.platform}-${this.runtime.arch}`,
      runtimeSha256,
      modelSha256,
      modelSize,
    }
    const manifestPartial = `${this.manifestPath}.partial`
    await writeFile(manifestPartial, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
    await rename(manifestPartial, this.manifestPath)
  }

  private async copyLocalArtifact(
    sourcePath: string,
    partialPath: string,
    baseBytes: number,
    stage: LocalServiceInstallStatus['stage'],
    message: string,
    signal: AbortSignal,
  ): Promise<string> {
    const sourceSize = (await stat(sourcePath)).size
    const source = await open(sourcePath, 'r')
    const destination = await open(partialPath, 'w', 0o600)
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES)
    let copied = 0
    this.stage = stage
    this.message = message
    try {
      while (copied < sourceSize) {
        if (signal.aborted) throw signal.reason
        const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, sourceSize - copied), copied)
        if (bytesRead === 0) break
        const chunk = buffer.subarray(0, bytesRead)
        await destination.write(chunk)
        hash.update(chunk)
        copied += bytesRead
        this.updateProgress(baseBytes + copied)
        const delay = Number(this.runtime.env.DSH_DICTATE_INSTALL_TEST_DELAY_MS ?? 0)
        if (Number.isFinite(delay) && delay > 0) await this.runtime.delay(Math.min(delay, 100), signal)
      }
    } finally {
      await Promise.all([source.close(), destination.close()])
    }
    if (copied !== sourceSize) throw new Error('本地安装源读取不完整')
    return hash.digest('hex')
  }

  private async downloadModel(baseBytes: number, signal: AbortSignal): Promise<void> {
    const partialPath = `${this.modelPath}.partial`
    let offset = await fileSize(partialPath)
    if (offset > this.artifacts.modelSize) offset = 0
    if (offset === this.artifacts.modelSize) {
      if (await sha256(partialPath) === this.artifacts.modelSha256) {
        this.updateProgress(baseBytes + offset)
        return
      }
      offset = 0
    }
    let response = await this.fetchModel(offset, signal)
    if (response.status === 416 && offset > 0) {
      await this.resetPartial(partialPath)
      offset = 0
      response = await this.fetchModel(offset, signal)
    }
    if (!response.ok || response.body === null) {
      throw new Error(`SenseVoice 模型下载失败：HTTP ${response.status}`)
    }
    const append = offset > 0 && response.status === 206
    if (!append) offset = 0
    const destination = await open(partialPath, append ? 'a' : 'w', 0o600)
    const reader = response.body.getReader()
    this.stage = 'downloading-model'
    this.message = '正在下载 SenseVoice Q8 模型'
    try {
      while (true) {
        if (signal.aborted) throw signal.reason
        const { done, value } = await reader.read()
        if (done) break
        await destination.write(value)
        offset += value.byteLength
        this.updateProgress(baseBytes + offset)
      }
    } finally {
      await destination.close()
      reader.releaseLock()
    }
  }

  private fetchModel(offset: number, signal: AbortSignal): Promise<Response> {
    return this.runtime.fetch(this.artifacts.modelUrl, {
      method: 'GET',
      headers: offset === 0 ? {} : { Range: `bytes=${offset}-` },
      redirect: 'follow',
      signal,
    })
  }

  private async resetPartial(path: string): Promise<void> {
    const handle = await open(path, 'w', 0o600)
    await handle.close()
  }

  private async awaitAbortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw signal.reason ?? new Error('installation cancelled')
    let abort!: () => void
    const cancellation = new Promise<never>((_, reject) => {
      abort = () => { reject(signal.reason ?? new Error('installation cancelled')) }
      signal.addEventListener('abort', abort, { once: true })
    })
    try {
      return await Promise.race([operation, cancellation])
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }

  private updateProgress(completedBytes: number): void {
    this.completedBytes = completedBytes
    this.progressPercent = this.totalBytes === null || this.totalBytes === 0
      ? null
      : Math.min(100, Math.floor(completedBytes * 100 / this.totalBytes))
  }

  private async validInstall(): Promise<boolean> {
    try {
      const manifest = JSON.parse(await readFile(this.manifestPath, 'utf8')) as Partial<InstallManifest>
      const [runtimeInfo, modelInfo] = await Promise.all([
        stat(this.executablePath),
        stat(this.modelPath),
      ])
      const manifestValid = manifest.version === 1
        && manifest.platform === `${this.runtime.platform}-${this.runtime.arch}`
        && manifest.modelSha256 === this.artifacts.modelSha256
        && manifest.modelSize === this.artifacts.modelSize
        && typeof manifest.runtimeSha256 === 'string'
        && (this.artifacts.runtimeSha256 === undefined
          || manifest.runtimeSha256 === this.artifacts.runtimeSha256)
        && runtimeInfo.isFile()
        && (this.artifacts.runtimeSize === undefined
          || runtimeInfo.size === this.artifacts.runtimeSize)
        && modelInfo.isFile()
        && modelInfo.size === this.artifacts.modelSize
      if (!manifestValid) return false
      const fingerprint = [
        runtimeInfo.size,
        runtimeInfo.mtimeMs,
        modelInfo.size,
        modelInfo.mtimeMs,
        manifest.runtimeSha256,
        manifest.modelSha256,
      ].join(':')
      if (this.verifiedFingerprint === fingerprint) return true
      const [runtimeSha256, modelSha256] = await Promise.all([
        sha256(this.executablePath),
        sha256(this.modelPath),
      ])
      if (runtimeSha256 !== manifest.runtimeSha256 || modelSha256 !== manifest.modelSha256) return false
      this.verifiedFingerprint = fingerprint
      return true
    } catch {
      return false
    }
  }

  private async validModelSha256(path: string): Promise<string | undefined> {
    try {
      const info = await stat(path)
      if (!info.isFile() || info.size !== this.artifacts.modelSize) return undefined
      const digest = await sha256(path)
      return digest === this.artifacts.modelSha256 ? digest : undefined
    } catch {
      return undefined
    }
  }
}

async function fileSize(path: string): Promise<number> {
  try { return (await stat(path)).size } catch { return 0 }
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
