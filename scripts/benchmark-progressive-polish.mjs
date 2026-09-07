// Deterministic scheduling comparison. No microphone, provider, or private data.
// Run: node scripts/benchmark-progressive-polish.mjs [baseline git commit]
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { runInNewContext } from 'node:vm'
import assert from 'node:assert/strict'

const baseline = process.argv[2] ?? '74ef255b79203f516954419262fadb5f764c19df'
if (!/^[a-f0-9]{7,40}$/u.test(baseline)) throw new Error('Pass an immutable commit hash')
const sourcePath = 'src/client/progressivePolish.ts'
const sources = {
  baseline: execFileSync('git', ['show', `${baseline}:${sourcePath}`], { encoding: 'utf8' }),
  candidate: readFileSync(new URL(`../${sourcePath}`, import.meta.url), 'utf8'),
}

async function replay(source, scenario, options = {}) {
  let now = 0
  let serial = 0
  const timers = new Map()
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
  const timer = (fn, delay = 0) => { const id = ++serial; timers.set(id, { at: now + Math.max(0, delay), fn }); return id }
  async function advance(target) {
    await flush()
    for (;;) {
      const next = [...timers].filter(([, item]) => item.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (!next) break
      timers.delete(next[0]); now = next[1].at; next[1].fn(); await flush()
    }
    now = target; await flush()
  }
  const code = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022,
  } }).outputText.replace(/export /gu, '')
  const Scheduler = runInNewContext(`${code}\nProgressivePolish`, {
    Date: { now: () => now }, setTimeout: timer, clearTimeout: id => timers.delete(id), AbortController,
  })
  const starts = []
  const run = new Scheduler({
    polish: (text, signal) => new Promise((resolve, reject) => {
      starts.push(now)
      const id = timer(() => resolve(text), scenario.modelMs)
      signal.addEventListener('abort', () => { timers.delete(id); reject(new Error('cancelled')) }, { once: true })
    }),
    join: parts => parts.join(''), preview: () => {}, ...options,
  })
  let finalRaw = ''
  for (const [at, text] of scenario.updates) {
    await advance(at); finalRaw = text; run.update('', text)
  }
  await advance(scenario.stopAt)
  run.prepareToStop()
  await advance(scenario.stopAt + 100) // Same synthetic recognition drain for all variants.
  run.update(finalRaw, '')
  let finished
  const result = run.finish(finalRaw).then(text => { finished = now; return text })
  await advance(now + scenario.modelMs + 1)
  assert.equal(await result, finalRaw)
  assert.equal(typeof finished, 'number')
  return { stopToFinalMs: finished - scenario.stopAt, requestStartsMs: starts, ...run.metrics }
}

const first = '第一修改登录页面第二补充测试'
const scenarios = [
  { name: 'last-sentence-before-spacing', modelMs: 800, updates: [[0, first], [1500, `${first}不对第二条取消`]], stopAt: 3200 },
  { name: 'stable-tail-behind-slow-model', modelMs: 5000, updates: [[0, first], [1000, `${first}最后预算改十八万`]], stopAt: 6500 },
  { name: 'continuous-enumeration-cost', modelMs: 800, updates: Array.from({ length: 9 }, (_, i) => [i * 2500, `${first}${'补充文档'.repeat(i)}`]), stopAt: 22000 },
]
for (const scenario of scenarios) {
  const before = await replay(sources.baseline, scenario)
  const fixedFourSeconds = await replay(sources.candidate, scenario, { intervalMs: 4000 })
  const after = await replay(sources.candidate, scenario)
  console.log(JSON.stringify({ scenario: scenario.name, baseline, simulatedModelMs: scenario.modelMs,
    simulatedRecognitionDrainMs: 100, before, fixedFourSeconds, after }))
}
