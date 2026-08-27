#!/usr/bin/env node

// Run only inside the isolated fixture created by check-dsh-source.mjs.
// Real Cordis, Connection, auth, settings, module loader and slot registry;
// synthetic HTTP streams and deterministic LLM/session data. No live server.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'
import * as cordis from '@deepseek-ai/cordis'
import * as connectionPlugin from '@deepseek-ai/dsh-client-connection'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import * as slotsModule from '@deepseek-ai/dsh-client-ui-slots'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import * as plugin from '../lib/index.js'

const source = realpathSync(process.argv[2])
const root = process.cwd()
assert.equal(resolve(process.env.DSH_HOME ?? ''), join(resolve(root, '..'), 'dsh-home'), 'Use check-dsh-source to isolate DSH_HOME')
const upstreamImport = path => import(pathToFileURL(join(source, path)).href)
const checks = []
const fibers = []
function response() {
  const chunks = []
  return Object.assign(new EventEmitter(), {
    status: 0, headers: {}, body: '', writableEnded: false,
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; return this },
    write(value) { chunks.push(Buffer.from(value)); return true },
    end(value) {
      if (value) chunks.push(Buffer.from(value))
      this.body = Buffer.concat(chunks).toString()
      this.writableEnded = true
      return this
    },
  })
}
async function mount(ctx, target, config) {
  const fiber = ctx.plugin(target, config)
  fibers.push(fiber)
  await fiber
  return fiber
}

try {
  const ctx = new cordis.Context()
  const routes = []
  let authRecord
  ctx.provide('credentials', {
    async modifyRecord(_key, mutate) {
      authRecord = await mutate(authRecord) ?? authRecord
      return authRecord
    },
  })
  ctx.provide('webServer', {
    register(route) { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1) } },
  })
  ctx.provide('sessions', { get: () => ({ deriveMessages: () => [] }) })
  ctx.provide('llm', {
    async *stream() {
      yield { type: 'text-delta', index: 0, text: '润色结果' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  await mount(ctx, FileSettingsProvider, { path: join(process.env.DSH_HOME, 'settings.yaml'), watch: false })
  await mount(ctx, connectionPlugin)
  const hostFiber = await mount(ctx, plugin)
  const route = routes.find(row => row.path === '/dictate')
  assert(route, 'Plugin did not register its real Connection route')
  const origin = 'http://127.0.0.1:43987'
  const launch = new URL(ctx.connection.authenticatedUrl(origin))
  const login = response()
  assert.equal(ctx.connection.authorizeIndex({ method: 'GET', url: launch.pathname + launch.search, headers: { host: launch.host } }, login), false)
  assert.equal(login.status, 303)
  const cookie = login.headers['set-cookie'].split(';', 1)[0]
  assert(cookie)
  async function rpc(method, payload = {}, headers = {}) {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ type: 'client-request', rpcId: 'source-smoke', method, payload }))]), {
      method: 'POST', url: `/dictate/${method}`,
      headers: { host: launch.host, origin, 'content-type': 'application/json', ...headers },
    })
    const res = response()
    await route.handler(req, res)
    return res
  }
  assert.equal((await rpc('local-service-autostart-status')).status, 401)
  assert.equal((await rpc('local-service-autostart-status', {}, { cookie, origin: 'https://untrusted.invalid' })).status, 403)
  assert.equal((await rpc('local-service-autostart-status', {}, { cookie, host: 'untrusted.invalid' })).status, 403)
  checks.push('real Connection: token exchange 303, anonymous 401, untrusted Origin/Host 403')
  async function authenticated(method, payload) {
    const res = await rpc(method, payload, { cookie })
    assert.equal(res.status, 200, res.body)
    const message = JSON.parse(res.body)
    assert.equal(message.rpcId, 'source-smoke')
    return message.result
  }
  assert.deepEqual(await authenticated('polish', { sessionId: 'smoke', provider: 'fixture', model: 'fixture', transcript: '原始转写', terms: [] }), { ok: true, value: { text: '润色结果' } })
  assert.equal((await authenticated('polish', {})).ok, false)
  assert.deepEqual(await authenticated('terms', { sessionId: 'smoke', draft: '在 `Codex` 中输入', includeInferred: false }), { ok: true, value: { terms: [{ text: 'Codex', boost: 5, source: 'composer' }] } })
  assert.deepEqual(await authenticated('local-service-autostart-status', {}), { ok: true, value: { enabled: false, origin: '' } })
  assert.deepEqual(await authenticated('local-service-autostart-set', { enabled: false, origin }), { ok: true, value: { enabled: false, origin } })
  assert.match(readFileSync(join(process.env.DSH_HOME, 'settings.yaml'), 'utf8'), /localServiceAutoStart: false/)
  checks.push('authenticated polish/terms, invalid input, isolated settings persistence; LLM/session fixtures only')
  await hostFiber.dispose()
  assert(!routes.some(row => row.path === '/dictate'))
  checks.push('host plugin unload removes RPC route')

  const { ClientModuleSystem } = await upstreamImport('packages/client/modules/lib/types/client/system.js')
  const { SlotRegistry } = await upstreamImport('packages/client/ui-renderer/lib/types/client/registry.js')
  // This plugin only imports the icon subset of the platform's UI primitives.
  const icons = await upstreamImport('packages/client/ui-primitives/lib/types/icons/index.js')
  const facade = { mode: 'queue', pendingQueue: [], load() {} }
  const sandbox = { window: { __ModuleLoader__: facade }, console, setTimeout, clearTimeout, AbortController, TextEncoder }
  const loader = new ClientModuleSystem({
    manifest: { modules: [{ id: 'dsh-dictate', inject: [], external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'], initialUrl: '/source-fixture.js?rev=source', url: '/source-fixture.js?rev=source', rev: 'source' }] },
    bootstrapModule: { id: '@deepseek-ai/dsh-client-modules', exports: { ClientModuleSystem } },
    staticModules: { react: React, 'react/jsx-runtime': jsxRuntime, '@deepseek-ai/cordis': cordis, '@deepseek-ai/dsh-client-ui-slots': slotsModule, '@deepseek-ai/dsh-client-ui-primitives': icons },
    registrationTarget: facade,
    loadBundle: async () => { vm.runInNewContext(readFileSync(join(root, 'lib/client.js'), 'utf8'), sandbox) },
  })
  const client = await loader.import('dsh-dictate')
  assert.deepEqual(Array.from(client.inject), ['connection', 'slots', 'remote.session'])
  const clientCtx = new cordis.Context()
  await mount(clientCtx, SlotRegistry)
  clientCtx.provide('connection', { rpc: { call() { throw new Error('No network calls expected during registration') } } })
  clientCtx.provide('remote.session', { modelCatalog() { throw new Error('No model query expected before settings render') } })
  const seats = ['conversation.input.right', 'conversation.input.overlay', 'settings.plugin.item']
  clientCtx.slots.register({ name: 'root', children: {
    'conversation.input.right': { kind: 'list', scope: 'session' },
    'conversation.input.overlay': { kind: 'list', scope: 'session' },
    'settings.plugin.item': { kind: 'map', scope: 'root' },
  } }, () => null)
  const clientFiber = await mount(clientCtx, client)
  for (const seat of seats) assert.equal(clientCtx.slots.entries(seat).length, 1, `Missing plugin slot: ${seat}`)
  await clientFiber.dispose()
  for (const seat of seats) assert.equal(clientCtx.slots.entries(seat).length, 0, `Leaked plugin slot: ${seat}`)
  checks.push('real upstream module loader + Cordis + SlotRegistry: built client materialized, 3 slots registered and unloaded')
  console.log(JSON.stringify({ checks, liveServerStarted: false, realMicrophoneVerified: false, visualLayoutVerified: false }, null, 2))
} finally {
  for (const fiber of fibers.reverse()) await fiber.dispose()
}
