#!/usr/bin/env node

import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { scrubCanaryEnvironment } from './canary-environment.mjs'
import { runBoundedCommand } from './bounded-command.mjs'

const JSON_SCHEMA_VERSION = 1
const UNDECLARED_CANARY_MODE = '1'
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const COMPATIBILITY_FILE = resolve(REPO_ROOT, 'compatibility.json')
const COMMAND_TIMEOUT_MS = 20 * 60 * 1000

export class InfrastructureCheckError extends Error {}
export class CompatibilityCheckError extends Error {}

function commandName(name) {
  return process.platform === 'win32' && (name === 'npm' || name === 'pnpm') ? `${name}.cmd` : name
}

async function runCommand(command, args, options) {
  const result = await runBoundedCommand(commandName(command), args, {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: COMMAND_TIMEOUT_MS,
  })
  if (result.error !== undefined) {
    const cleanupDetail = result.cleanupError === undefined ? '' : `; process-tree cleanup failed: ${result.cleanupError.message}`
    throw new InfrastructureCheckError(`${command} ${args.join(' ')} failed: ${result.error.message}${cleanupDetail}`)
  }
  return {
    status: result.status ?? 2,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

function isInfrastructureFailure(value) {
  const text = value.toLowerCase()
  return /\b(?:e401|e403|e404|eai_again|econnreset|enotfound|etimedout|err_socket_timeout)\b/u.test(text)
    || text.includes('err_pnpm_fetch')
    || text.includes('err_pnpm_meta_fetch_fail')
    || text.includes('network request failed')
    || text.includes('fetch failed')
}

export function commandFailureClassification(result, requestedClassification = 'infrastructure') {
  const detail = [result.stderr, result.stdout].filter(value => value.trim() !== '').join('\n')
  return requestedClassification === 'compatibility' && !isInfrastructureFailure(detail)
    ? 'compatibility'
    : 'infrastructure'
}

function requireSuccess(label, result, classification = 'infrastructure') {
  if (result.status === 0) return
  const rawDetail = [result.stderr, result.stdout].filter(value => value.trim() !== '').join('\n')
  const detail = rawDetail.trim().split(/\r?\n/u).slice(-12).join('\n')
  const message = `${label} failed with exit ${String(result.status)}${detail === '' ? '' : `:\n${detail}`}`
  if (commandFailureClassification(result, classification) === 'compatibility') {
    throw new CompatibilityCheckError(message)
  }
  throw new InfrastructureCheckError(message)
}

export function installCheckExitCode(error) {
  return error instanceof CompatibilityCheckError ? 1 : 2
}

/** Build the environment used by an isolated DSH profile installation. */
export function installCheckEnvironment(environment, allowUndeclaredCanaryVersion) {
  return {
    ...(allowUndeclaredCanaryVersion ? scrubCanaryEnvironment(environment) : environment),
    // DSH profiles are pnpm workspace projects. The isolated check intentionally
    // installs the plugin at that workspace root, so make the consent explicit.
    npm_config_ignore_workspace_root_check: 'true',
    ...(allowUndeclaredCanaryVersion
      ? {
          // DSH forwards profile plugin operations to `pnpm`. Do not let pnpm
          // switch back to the repository's pnpm 9 packageManager declaration
          // when this canary provisions pnpm 10 explicitly.
          npm_config_manage_package_manager_versions: 'false',
        }
      : {}),
  }
}

function configBlock(dump, id, classification = 'infrastructure') {
  const lines = dump.split(/\r?\n/u)
  const start = lines.findIndex(line => line === `- id: ${id}`)
  if (start < 0) {
    const ErrorType = classification === 'compatibility' ? CompatibilityCheckError : InfrastructureCheckError
    throw new ErrorType(`dump-config is missing the ${id} block`)
  }
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^(?:- id: |# ==)/u.test(lines[index] ?? '')) {
      end = index
      break
    }
  }
  while (end > start && lines[end - 1] === '') end -= 1
  return lines.slice(start, end).join('\n')
}

function parseOneLineJson(output, label) {
  const text = output.trim()
  if (text === '' || /\r?\n/u.test(text)) throw new CompatibilityCheckError(`${label} did not emit exactly one JSON line`)
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new CompatibilityCheckError(`${label} emitted invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assertHostExports(value) {
  const exports = Object.keys(value).sort()
  if (JSON.stringify(exports) !== JSON.stringify(['Config', 'apply', 'inject', 'name'])) {
    throw new CompatibilityCheckError(`host exports changed: ${exports.join(', ')}`)
  }
  if (value.name !== 'dsh-dictate' || typeof value.apply !== 'function' || !Array.isArray(value.inject)) {
    throw new CompatibilityCheckError('host module did not expose the dsh-dictate plugin contract')
  }
}

async function main() {
  const compatibility = JSON.parse(await readFile(COMPATIBILITY_FILE, 'utf8'))
  const supportedVersion = compatibility?.dshPluginApi?.version
  if (typeof supportedVersion !== 'string' || supportedVersion.length === 0) {
    throw new InfrastructureCheckError('compatibility.json has no declared DSH plugin API version')
  }
  const requestedDshVersion = process.env.DSH_VERSION
  const allowUndeclaredCanaryVersion = process.env.DSH_UNDECLARED_CANARY_VERSION === UNDECLARED_CANARY_MODE
  if (requestedDshVersion !== undefined
    && requestedDshVersion !== ''
    && requestedDshVersion !== supportedVersion
    && !allowUndeclaredCanaryVersion) {
    throw new InfrastructureCheckError(`check-dsh-install only verifies the declared DSH version ${supportedVersion}`)
  }
  const dshVersion = requestedDshVersion === undefined || requestedDshVersion === ''
    ? supportedVersion
    : requestedDshVersion
  const inheritedEnvironment = installCheckEnvironment(process.env, allowUndeclaredCanaryVersion)
  const build = await runCommand('pnpm', ['run', 'build'], { cwd: REPO_ROOT, env: inheritedEnvironment })
  requireSuccess('local build', build)

  const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-dictate-install-'))
  const dshHome = join(tempRoot, 'dsh-home')
  const installRoot = join(tempRoot, 'dsh-install')
  const workspace = join(tempRoot, 'workspace')
  await mkdir(workspace, { recursive: true })
  const env = {
    ...inheritedEnvironment,
    DSH_HOME: dshHome,
    DSH_TELEMETRY_MODE: 'DISABLED',
  }

  try {
    const pack = await runCommand('npm', [
      'pack',
      '--json',
      '--ignore-scripts',
      '--pack-destination', tempRoot,
    ], { cwd: REPO_ROOT, env })
    requireSuccess('npm pack', pack)
    const [manifest] = JSON.parse(pack.stdout)
    if (typeof manifest?.filename !== 'string'
      || manifest.filename.length === 0
      || basename(manifest.filename) !== manifest.filename) {
      throw new InfrastructureCheckError('npm pack did not report one package filename')
    }
    const pluginTarball = join(tempRoot, manifest.filename)
    await access(pluginTarball)

    const install = await runCommand('npm', [
      'install',
      '--prefix', installRoot,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      `@deepseek-ai/dsh@${dshVersion}`,
    ], { cwd: workspace, env })
    requireSuccess('dsh install', install)

    const dshBinary = join(installRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
    const versionResult = await runCommand(dshBinary, ['--version'], { cwd: workspace, env })
    requireSuccess('dsh --version', versionResult)
    const actualDshVersion = versionResult.stdout.trim()
    if (actualDshVersion !== dshVersion) {
      throw new CompatibilityCheckError(`dsh version mismatch: expected ${dshVersion}, got ${actualDshVersion}`)
    }

    const beforeDump = await runCommand(dshBinary, ['--profile', 'web', '--dump-config'], { cwd: workspace, env })
    requireSuccess('pre-install dump-config', beforeDump)
    const beforeWeb = configBlock(beforeDump.stdout, 'web')

    const add = await runCommand(dshBinary, [
      'plugin', '--profile', 'web', 'add', `file:${pluginTarball}`,
    ], { cwd: workspace, env })
    requireSuccess('local plugin install', add, 'compatibility')

    const afterDump = await runCommand(dshBinary, ['--profile', 'web', '--dump-config'], { cwd: workspace, env })
    requireSuccess('post-install dump-config', afterDump, 'compatibility')
    if (configBlock(afterDump.stdout, 'web', 'compatibility') !== beforeWeb) {
      throw new CompatibilityCheckError('web configuration changed after dsh-dictate installation')
    }
    const pluginBlock = configBlock(afterDump.stdout, 'dsh-dictate', 'compatibility')
    if (!/^  name: dsh-dictate$/mu.test(pluginBlock)) {
      throw new CompatibilityCheckError('dsh-dictate was not registered in the DSH profile')
    }

    // Config dumps intentionally avoid runtime setup. Boot the profile's help
    // path so the official launcher prepares its module fallback without
    // opening a port, model provider, browser, or microphone.
    const profileProbe = await runCommand(dshBinary, [
      '--profile', 'web', '--help',
    ], { cwd: workspace, env })
    requireSuccess('web profile compatibility probe', profileProbe, 'compatibility')
    if (!profileProbe.stdout.includes('Usage: dsh --profile web')
      || profileProbe.stdout.includes('dsh web: http://')
      || profileProbe.stderr.trim() !== '') {
      throw new CompatibilityCheckError('web profile compatibility probe did not remain on the help-only path')
    }

    const hostImport = await runCommand(process.execPath, [
      '--input-type=module',
      '-e',
      "const plugin = await import('dsh-dictate'); const exports = Object.keys(plugin).sort(); if (JSON.stringify(exports) !== JSON.stringify(['Config','apply','inject','name']) || plugin.name !== 'dsh-dictate' || typeof plugin.apply !== 'function') process.exit(1); process.stdout.write(JSON.stringify({hostExports: exports, name: plugin.name}) + '\\n')",
    ], { cwd: join(dshHome, 'profiles', 'web'), env })
    requireSuccess('dsh-dictate host import', hostImport, 'compatibility')
    const hostReport = parseOneLineJson(hostImport.stdout, 'dsh-dictate host import')
    if (hostReport.name !== 'dsh-dictate') throw new CompatibilityCheckError('host import returned the wrong plugin name')

    const packedClient = await readFile(join(REPO_ROOT, 'lib', 'client.js'), 'utf8')
    if (!packedClient.includes('window.__ModuleLoader__.load({') || !packedClient.includes('id: "dsh-dictate"')) {
      throw new CompatibilityCheckError('packed client entry is missing the DSH module-loader wrapper')
    }

    process.stdout.write(`${JSON.stringify({
      schemaVersion: JSON_SCHEMA_VERSION,
      dshVersion: actualDshVersion,
      nodeVersion: process.version,
      plugin: 'dsh-dictate',
      profileRegistered: true,
      profilePrepared: true,
      hostExports: hostReport.hostExports,
      clientWrapper: true,
      localAsr: 'excluded-from-upstream-canary',
    })}\n`)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    await main()
  } catch (error) {
    process.stderr.write(`check-dsh-install: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = installCheckExitCode(error)
  }
}
