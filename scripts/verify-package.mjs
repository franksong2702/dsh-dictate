import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdtemp, mkdir, readFile, rm, stat, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const work = await mkdtemp(join(tmpdir(), 'dsh-dictate-package-'))
const packedNodeModules = join(work, 'unpack', 'package', 'node_modules')
const requiredKeywords = ['deepseek-harness', 'voice-input', 'speech-to-text', 'sensevoice']
const nativeRuntimes = [
  {
    platform: 'darwin-arm64',
    path: 'native/darwin-arm64/dsh-dictate-asr',
    sha256: 'dab83ea0c5bfa95b8e9c94f804da7d88c9fc5657ac5ac8503554ec338d5db52f',
  },
  {
    platform: 'win32-x64',
    path: 'native/win32-x64/dsh-dictate-asr.exe',
    sha256: '31aa161a992f396ec12712a68fd881f3778d32b173c2b795918ffcc80d38a29f',
  },
]

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`)
  }
  return result.stdout.trim()
}

try {
  if (typeof manifest.description !== 'string'
    || !/DeepSeek Harness/i.test(manifest.description)
    || !/voice input/i.test(manifest.description)) {
    throw new Error('package description must expose DeepSeek Harness voice-input search terms')
  }
  for (const keyword of requiredKeywords) {
    if (!Array.isArray(manifest.keywords) || !manifest.keywords.includes(keyword)) {
      throw new Error(`package keywords are missing ${keyword}`)
    }
  }

  run('pnpm', ['--config.ignore-scripts=true', 'pack', '--pack-destination', work])
  const tarball = join(work, `${manifest.name}-${manifest.version}.tgz`)
  await access(tarball)

  const entries = run('tar', ['-tzf', tarball]).split('\n').filter(Boolean)
  const required = [
    'package/package.json',
    'package/cordis.patch.yml',
    'package/lib/index.js',
    'package/lib/client.js',
    'package/lib/types/index.d.ts',
    'package/THIRD_PARTY_NOTICES.md',
    ...nativeRuntimes.map(runtime => `package/${runtime.path}`),
    'package/docs/images/voice-input-hero.jpg',
    'package/docs/images/composer-voice-entry.jpg',
    'package/docs/images/voice-input-settings.jpg',
  ]
  for (const entry of required) {
    if (!entries.includes(entry)) throw new Error(`packed artifact is missing ${entry}`)
  }
  const forbidden = entries.find(entry => /\/(?:src|tests|node_modules|\.git)(?:\/|$)|\/(?:\.env)(?:\.|$)/.test(entry))
  if (forbidden !== undefined) throw new Error(`packed artifact contains forbidden path ${forbidden}`)

  const unpack = join(work, 'unpack')
  await mkdir(unpack)
  run('tar', ['-xzf', tarball, '-C', unpack])
  const packedRoot = join(unpack, 'package')
  const verifiedNativeRuntimes = []
  for (const nativeRuntime of nativeRuntimes) {
    const packedRuntime = join(packedRoot, nativeRuntime.path)
    const runtimeInfo = await stat(packedRuntime)
    if (!runtimeInfo.isFile()) throw new Error(`packed native ASR runtime must be a file: ${nativeRuntime.path}`)
    const runtimeDigest = createHash('sha256').update(await readFile(packedRuntime)).digest('hex')
    if (runtimeDigest !== nativeRuntime.sha256) {
      throw new Error(`packed native ASR runtime SHA-256 mismatch for ${nativeRuntime.platform}: ${runtimeDigest}`)
    }
    verifiedNativeRuntimes.push({ platform: nativeRuntime.platform, sha256: runtimeDigest })
  }
  await symlink(join(root, 'node_modules'), packedNodeModules, process.platform === 'win32' ? 'junction' : 'dir')
  const plugin = await import(`${pathToFileURL(join(packedRoot, 'lib/index.js')).href}?verify=${Date.now()}`)
  const exports = Object.keys(plugin).sort()
  if (JSON.stringify(exports) !== JSON.stringify(['Config', 'apply', 'inject', 'name'])) {
    throw new Error(`unexpected host exports: ${exports.join(', ')}`)
  }
  if ('default' in plugin) throw new Error('packed host entry must not have a default export')

  const client = await readFile(join(packedRoot, 'lib/client.js'), 'utf8')
  if (!client.includes('window.__ModuleLoader__.load({') || !client.includes('id: "dsh-dictate"')) {
    throw new Error('packed client entry is missing the DSH module-loader wrapper')
  }

  console.log(JSON.stringify({
    package: `${manifest.name}@${manifest.version}`,
    entryCount: entries.length,
    hostExports: exports,
    clientWrapper: true,
    nativeRuntimes: verifiedNativeRuntimes,
    discoveryKeywords: requiredKeywords,
  }))
} finally {
  try {
    await unlink(packedNodeModules)
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
  }
  await rm(work, { recursive: true, force: true })
}
