#!/usr/bin/env node

// Source-only candidate gate. Never installs into the user's DSH profile.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { values } = parseArgs({ options: { source: { type: 'string' }, tools: { type: 'string' }, 'report-dir': { type: 'string' } } })
assert(values.source, 'Usage: check-dsh-source --source <built-upstream-checkout> [--tools <node_modules>] [--report-dir <directory>]')
const source = realpathSync(values.source)
const tools = realpathSync(values.tools ?? join(root, 'node_modules'))
const compatibility = JSON.parse(readFileSync(join(root, 'compatibility.json'), 'utf8'))
const expectedSha = compatibility.sourceCandidate?.commit
assert.match(expectedSha ?? '', /^[a-f0-9]{40}$/)
function git(args) {
  const result = spawnSync('git', args, { cwd: source, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
assert.equal(git(['rev-parse', 'HEAD']), expectedSha, 'Wrong upstream commit')
assert.equal(git(['status', '--porcelain', '--untracked-files=no']), '', 'Upstream tracked files changed')
const work = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-dictate-source-')))
const evidence = values['report-dir'] ? resolve(values['report-dir']) : work
mkdirSync(evidence, { recursive: true })
const fixture = join(work, 'plugin')
mkdirSync(fixture)
for (const entry of ['src', 'tests', 'scripts', 'native', 'docs', '.github', 'package.json', 'compatibility.json', 'tsconfig.json', 'tsdown.config.ts', 'cordis.patch.yml', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
  cpSync(join(root, entry), join(fixture, entry), { recursive: true, filter: path => !path.includes('/target/') && !path.endsWith('/target') })
}
const modules = join(fixture, 'node_modules')
mkdirSync(join(modules, '@deepseek-ai'), { recursive: true })
// Test/build tools may come from the locked prior baseline, but no DSH package
// may fall back to that graph. Every DSH name resolves into the source checkout.
for (const entry of readdirSync(tools)) {
  if (entry === '@deepseek-ai' || entry === '.pnpm') continue
  symlinkSync(join(tools, entry), join(modules, entry), 'dir')
}
const packages = new Map()
function scan(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || ['node_modules', '.git', 'lib', 'dist', 'target'].includes(entry.name)) continue
    const path = join(directory, entry.name)
    const manifest = join(path, 'package.json')
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
      if (pkg.name?.startsWith('@deepseek-ai/')) {
        assert(!packages.has(pkg.name), `Duplicate upstream package ${pkg.name}`)
        packages.set(pkg.name, { path, pkg })
      }
    }
    scan(path)
  }
}
for (const directory of ['packages', 'vendor', 'native', 'apps']) scan(join(source, directory))
for (const [name, { path }] of packages) symlinkSync(path, join(modules, name), 'dir')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
for (const name of Object.keys(manifest.devDependencies).filter(name => name.startsWith('@deepseek-ai/dsh-'))) {
  const entry = packages.get(name)
  assert(entry, `Dependency absent from source: ${name}`)
  assert.equal(entry.pkg.version, compatibility.dshPluginApi.version, `Mixed source version: ${name}`)
  assert.equal(realpathSync(join(modules, name)), entry.path)
  assert(existsSync(join(entry.path, entry.pkg.types ?? 'lib/types/index.d.ts')), `Build upstream declarations first: ${name}`)
}
for (const name of manifest.dsh.client.inject) {
  const entry = packages.get(name)
  assert(entry?.pkg.dsh?.client, `Missing client loader dependency: ${name}`)
  assert(existsSync(join(entry.path, 'lib/client.js')), `Missing built client: ${name}`)
}
assert(!existsSync(join(modules, '@deepseek-ai/dsh-client-runtime')))
assert(!existsSync(join(modules, '@deepseek-ai/dsh-host-apiproxy')))

const pluginGit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
const report = { upstreamCommit: expectedSha, pluginCommit: pluginGit.status === 0 ? pluginGit.stdout.trim() : null, nodeVersion: process.version, dshVersion: compatibility.dshPluginApi.version, fixture, linkedPackages: packages.size, status: 'running', steps: [], npmArtifactsVerified: false, realMicrophoneVerified: false }
const saveReport = () => writeFileSync(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n')
saveReport()
function run(stage, command, args) {
  const result = spawnSync(command, args, { cwd: fixture, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, DSH_HOME: join(work, 'dsh-home'), DSH_TELEMETRY_MODE: 'DISABLED' } })
  const log = join(evidence, `${stage}.log`)
  writeFileSync(log, (result.stdout ?? '') + (result.stderr ?? '') + (result.error?.message ?? ''))
  report.steps.push({ stage, command: [command, ...args], exitCode: result.status, log })
  if (result.status !== 0) report.status = 'failed'
  saveReport()
  console.log(`${stage}: exit ${result.status}; ${log}`)
  assert.equal(result.status, 0, `Failed ${stage}:\n${result.stdout}\n${result.stderr}\n${result.error ?? ''}`)
}
console.log(`Source fixture: ${fixture}`)
run('typecheck', join(tools, '.bin/tsc'), ['-p', 'tsconfig.json', '--noEmit'])
run('tests', join(tools, '.bin/vitest'), ['run'])
run('declarations', join(tools, '.bin/tsc'), ['-p', 'tsconfig.json'])
run('client-build', join(tools, '.bin/tsdown'), [])
run('package', process.execPath, ['scripts/verify-package.mjs'])
run('source-smoke', process.execPath, ['scripts/smoke-dsh-source.mjs', source])
run('canary-contract', process.execPath, ['scripts/check-dsh-next-contract.mjs'])
run('canary-workflow', process.execPath, ['scripts/check-canary-workflow.mjs'])
run('source-workflow', process.execPath, ['scripts/check-source-workflow.mjs'])
report.status = 'passed'
saveReport()
console.log(`Source-only verification passed: ${join(evidence, 'report.json')}`)
