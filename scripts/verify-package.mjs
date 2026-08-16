import { spawnSync } from 'node:child_process'
import { access, mkdtemp, mkdir, readFile, rm, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const work = await mkdtemp(join(tmpdir(), 'dsh-voice-input-package-'))
const packedNodeModules = join(work, 'unpack', 'package', 'node_modules')

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`)
  }
  return result.stdout.trim()
}

try {
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
  await symlink(join(root, 'node_modules'), packedNodeModules, process.platform === 'win32' ? 'junction' : 'dir')
  const plugin = await import(`${pathToFileURL(join(packedRoot, 'lib/index.js')).href}?verify=${Date.now()}`)
  const exports = Object.keys(plugin).sort()
  if (JSON.stringify(exports) !== JSON.stringify(['apply', 'inject', 'name'])) {
    throw new Error(`unexpected host exports: ${exports.join(', ')}`)
  }
  if ('default' in plugin) throw new Error('packed host entry must not have a default export')

  const client = await readFile(join(packedRoot, 'lib/client.js'), 'utf8')
  if (!client.includes('window.__ModuleLoader__.load({') || !client.includes('id: "dsh-voice-input"')) {
    throw new Error('packed client entry is missing the DSH module-loader wrapper')
  }

  console.log(JSON.stringify({
    package: `${manifest.name}@${manifest.version}`,
    entryCount: entries.length,
    hostExports: exports,
    clientWrapper: true,
  }))
} finally {
  try {
    await unlink(packedNodeModules)
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
  }
  await rm(work, { recursive: true, force: true })
}
