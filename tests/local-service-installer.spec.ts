import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LocalServiceInstaller,
  type InstallerArtifacts,
  type LocalServiceInstallerRuntime,
} from '../src/local-service-installer.ts'
import { parseLocalServiceInstallStatus } from '../src/local-service-contract.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function digest(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

async function waitForInstall(installer: LocalServiceInstaller): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await installer.status()
    if (status.phase !== 'installing') return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error('installer did not finish in test time')
}

describe('native local ASR installer', () => {
  it('copies and verifies isolated runtime/model artifacts before starting the service', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-dictate-installer-'))
    roots.push(root)
    const runtimeSource = join(root, 'runtime-source')
    const modelSource = join(root, 'model-source')
    const runtimeBytes = Buffer.from('native-runtime')
    const modelBytes = Buffer.from('sensevoice-model')
    await Promise.all([
      writeFile(runtimeSource, runtimeBytes),
      writeFile(modelSource, modelBytes),
    ])
    const artifacts: InstallerArtifacts = {
      modelFilename: 'model.gguf',
      modelSize: modelBytes.length,
      modelSha256: digest(modelBytes),
      modelUrl: 'https://example.invalid/model.gguf',
    }
    const runtime: LocalServiceInstallerRuntime = {
      env: {
        DSH_HOME: join(root, 'dsh-home'),
        DSH_DICTATE_NATIVE_RUNTIME_SOURCE: runtimeSource,
        DSH_DICTATE_NATIVE_MODEL_SOURCE: modelSource,
      },
      platform: 'darwin',
      arch: 'arm64',
      fetch: vi.fn(),
      delay: vi.fn(async () => {}),
    }
    const installer = new LocalServiceInstaller(runtime, artifacts)
    const onInstalled = vi.fn(async () => {})

    await expect(installer.status()).resolves.toMatchObject({ phase: 'not-installed' })
    await expect(installer.start(onInstalled)).resolves.toMatchObject({ phase: 'installing' })
    let status = await installer.status()
    for (let attempt = 0; attempt < 20 && status.phase === 'installing'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5))
      status = await installer.status()
    }

    expect(status).toMatchObject({
      phase: 'installed',
      stage: 'ready',
      progressPercent: 100,
      platform: 'darwin-arm64',
    })
    expect(onInstalled).toHaveBeenCalledOnce()
    expect(runtime.fetch).not.toHaveBeenCalled()
    await expect(readFile(installer.executablePath)).resolves.toEqual(runtimeBytes)
    await expect(readFile(installer.modelPath)).resolves.toEqual(modelBytes)
    expect(parseLocalServiceInstallStatus(status)).toEqual(status)

    const refreshedInstaller = new LocalServiceInstaller(runtime, artifacts)
    await expect(refreshedInstaller.status()).resolves.toMatchObject({
      phase: 'installed',
      stage: 'ready',
      progressPercent: 100,
    })
  })

  it('reports unsupported platforms without touching an install source', async () => {
    const runtime: LocalServiceInstallerRuntime = {
      env: {},
      platform: 'win32',
      arch: 'x64',
      fetch: vi.fn(),
      delay: vi.fn(async () => {}),
    }
    const installer = new LocalServiceInstaller(runtime)
    await expect(installer.status()).resolves.toMatchObject({
      phase: 'unsupported',
      platform: 'win32-x64',
    })
    await expect(installer.start(vi.fn())).resolves.toMatchObject({ phase: 'unsupported' })
  })

  it('reuses a complete verified model partial without issuing a range request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-dictate-installer-'))
    roots.push(root)
    const runtimeSource = join(root, 'runtime-source')
    const modelBytes = Buffer.from('sensevoice-model')
    await writeFile(runtimeSource, Buffer.from('native-runtime'))
    const artifacts: InstallerArtifacts = {
      modelFilename: 'model.gguf',
      modelSize: modelBytes.length,
      modelSha256: digest(modelBytes),
      modelUrl: 'https://example.invalid/model.gguf',
    }
    const runtime: LocalServiceInstallerRuntime = {
      env: {
        DSH_HOME: join(root, 'dsh-home'),
        DSH_DICTATE_NATIVE_RUNTIME_SOURCE: runtimeSource,
      },
      platform: 'darwin',
      arch: 'arm64',
      fetch: vi.fn(),
      delay: vi.fn(async () => {}),
    }
    const installer = new LocalServiceInstaller(runtime, artifacts)
    await mkdir(join(installer.installRoot, 'models'), { recursive: true })
    await writeFile(`${installer.modelPath}.partial`, modelBytes)

    await expect(installer.start(async () => {})).resolves.toMatchObject({ phase: 'installing' })
    await waitForInstall(installer)

    expect(runtime.fetch).not.toHaveBeenCalled()
    await expect(installer.status()).resolves.toMatchObject({ phase: 'installed' })
  })

  it('restarts a stale partial download after HTTP 416', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-dictate-installer-'))
    roots.push(root)
    const runtimeSource = join(root, 'runtime-source')
    const modelBytes = Buffer.from('sensevoice-model')
    await writeFile(runtimeSource, Buffer.from('native-runtime'))
    const artifacts: InstallerArtifacts = {
      modelFilename: 'model.gguf',
      modelSize: modelBytes.length,
      modelSha256: digest(modelBytes),
      modelUrl: 'https://example.invalid/model.gguf',
    }
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 416 }))
      .mockResolvedValueOnce(new Response(modelBytes, { status: 200 }))
    const runtime: LocalServiceInstallerRuntime = {
      env: {
        DSH_HOME: join(root, 'dsh-home'),
        DSH_DICTATE_NATIVE_RUNTIME_SOURCE: runtimeSource,
      },
      platform: 'darwin',
      arch: 'arm64',
      fetch,
      delay: vi.fn(async () => {}),
    }
    const installer = new LocalServiceInstaller(runtime, artifacts)
    await mkdir(join(installer.installRoot, 'models'), { recursive: true })
    await writeFile(`${installer.modelPath}.partial`, modelBytes.subarray(0, 2))

    await expect(installer.start(async () => {})).resolves.toMatchObject({ phase: 'installing' })
    await waitForInstall(installer)

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ headers: { Range: 'bytes=2-' } })
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ headers: {} })
    await expect(readFile(installer.modelPath)).resolves.toEqual(modelBytes)
  })

  it('does not wait forever for an installed callback during disposal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-dictate-installer-'))
    roots.push(root)
    const runtimeSource = join(root, 'runtime-source')
    const modelSource = join(root, 'model-source')
    const modelBytes = Buffer.from('sensevoice-model')
    await Promise.all([
      writeFile(runtimeSource, Buffer.from('native-runtime')),
      writeFile(modelSource, modelBytes),
    ])
    const runtime: LocalServiceInstallerRuntime = {
      env: {
        DSH_HOME: join(root, 'dsh-home'),
        DSH_DICTATE_NATIVE_RUNTIME_SOURCE: runtimeSource,
        DSH_DICTATE_NATIVE_MODEL_SOURCE: modelSource,
      },
      platform: 'darwin',
      arch: 'arm64',
      fetch: vi.fn(),
      delay: vi.fn(async () => {}),
    }
    const installer = new LocalServiceInstaller(runtime, {
      modelFilename: 'model.gguf',
      modelSize: modelBytes.length,
      modelSha256: digest(modelBytes),
      modelUrl: 'https://example.invalid/model.gguf',
    })
    let callbackStarted!: () => void
    const callbackReady = new Promise<void>(resolve => { callbackStarted = resolve })
    const callback = vi.fn(async () => {
      callbackStarted()
      await new Promise<void>(() => {})
    })

    await expect(installer.start(callback)).resolves.toMatchObject({ phase: 'installing' })
    await callbackReady
    await expect(installer.dispose()).resolves.toBeUndefined()
    expect(callback).toHaveBeenCalledOnce()
  })
})
