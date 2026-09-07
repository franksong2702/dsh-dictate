import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PROGRESSIVE_PAUSE_MS, ProgressivePolish } from '../src/client/progressivePolish.ts'

const raw = '第一修改登录页面第二补充测试'
const cleaned = '1. 修改登录页面。\n2. 补充测试。'
const join = (parts: readonly string[]): string => parts.join('')
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('progressive transcript polish', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('starts during a pause, previews the result, and reuses the completed whole transcript at stop', async () => {
    const preview = vi.fn()
    const polish = vi.fn(async () => cleaned)
    const run = new ProgressivePolish({ polish, preview, join })
    run.update(raw, '')
    await vi.advanceTimersByTimeAsync(DEFAULT_PROGRESSIVE_PAUSE_MS - 1)
    expect(polish).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(preview).toHaveBeenLastCalledWith(cleaned)
    expect(await run.finish(raw)).toBe(cleaned)
    expect(polish).toHaveBeenCalledTimes(1)
    expect(run.metrics.reused).toBe('completed')
  })

  it('waits for an exact in-flight result without starting a duplicate final request', async () => {
    const response = deferred<string>()
    const polish = vi.fn(() => response.promise)
    const run = new ProgressivePolish({ polish, preview: vi.fn(), join })
    run.update(raw, '')
    await vi.advanceTimersByTimeAsync(DEFAULT_PROGRESSIVE_PAUSE_MS)
    const result = run.finish(raw)
    response.resolve(cleaned)
    expect(await result).toBe(cleaned)
    expect(polish).toHaveBeenCalledTimes(1)
    expect(run.metrics.reused).toBe('in-flight')
  })

  it('starts polishing an unchanged full interim snapshot before recognition marks it final', async () => {
    const polish = vi.fn(async () => cleaned)
    const run = new ProgressivePolish({ polish, preview: vi.fn(), join })
    // Web Speech can leave the whole utterance interim until stop/onend.
    run.update('', raw)
    await vi.advanceTimersByTimeAsync(DEFAULT_PROGRESSIVE_PAUSE_MS)
    expect(polish).toHaveBeenCalledWith(raw, expect.any(AbortSignal))
    expect(await run.finish(raw)).toBe(cleaned)
    expect(polish).toHaveBeenCalledTimes(1)
  })

  it('overlaps immediate stop recognition drain with one full-snapshot model request', async () => {
    vi.setSystemTime(0)
    const polish = vi.fn((text: string) => new Promise<string>(resolve => setTimeout(() => resolve(text), 800)))
    const run = new ProgressivePolish({ polish, preview: vi.fn(), join })
    run.update('', raw)
    run.prepareToStop()
    run.prepareToStop()
    await vi.advanceTimersByTimeAsync(500) // recognition stop -> final result/onend
    run.update(raw, '')
    let done = -1
    const result = run.finish(raw).then(text => { done = Date.now(); return text })
    await vi.advanceTimersByTimeAsync(300)
    expect(await result).toBe(raw)
    expect(done).toBe(800) // old serial path: 500 + 800 = 1300
    expect(polish).toHaveBeenCalledTimes(1)
    expect(run.metrics.stopCalls).toBe(1)
    expect(run.metrics.reused).toBe('in-flight')
  })

  it('never commits a speculative interim spelling when final recognition corrects it', async () => {
    const polish = vi.fn(async (text: string) => text)
    const run = new ProgressivePolish({ polish, preview: vi.fn(), join })
    run.update('', '预算二十万周四开会')
    await vi.advanceTimersByTimeAsync(DEFAULT_PROGRESSIVE_PAUSE_MS)
    run.prepareToStop()
    expect(await run.finish('预算十八万周五开会')).toBe('预算十八万周五开会')
    expect(polish.mock.calls.map(call => call[0])).toEqual(['预算二十万周四开会', '预算十八万周五开会'])
    expect(run.metrics.reused).toBe('none')
  })

  it('does not restart the debounce when identical interim words become recognition-final', async () => {
    const polish = vi.fn(async (text: string) => text)
    const run = new ProgressivePolish({ polish, preview: vi.fn(), join })
    run.update('', raw)
    await vi.advanceTimersByTimeAsync(DEFAULT_PROGRESSIVE_PAUSE_MS - 100)
    run.update(raw, '')
    await vi.advanceTimersByTimeAsync(100)
    expect(polish).toHaveBeenCalledTimes(1)
    run.cancel()
  })

  it('keeps stop speculation within its budget while allowing the mandatory final pass', async () => {
    const polish = vi.fn(async (text: string) => text)
    const run = new ProgressivePolish({ polish, preview: vi.fn(), join, maxBackgroundCalls: 0 })
    run.update('', raw)
    run.prepareToStop()
    expect(polish).not.toHaveBeenCalled()
    expect(await run.finish(raw)).toBe(raw)
    expect(run.metrics.finalCalls).toBe(1)
  })

  it('replaces a stale pending snapshot once at stop and ignores its late completion', async () => {
    const old = deferred<string>()
    const current = deferred<string>()
    const polish = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const run = new ProgressivePolish({ polish, preview: vi.fn(), join })
    run.update('', raw)
    await vi.advanceTimersByTimeAsync(DEFAULT_PROGRESSIVE_PAUSE_MS)
    run.update('', `${raw}第三条补充文档`)
    run.prepareToStop()
    expect(polish.mock.calls[0]?.[1].aborted).toBe(true)
    const result = run.finish(`${raw}第三条补充文档`)
    old.resolve('迟到的旧版本')
    current.resolve('修复登录，补测试和文档。')
    expect(await result).toBe('修复登录，补测试和文档。')
    expect(polish).toHaveBeenCalledTimes(2)
    expect(run.metrics.abortSignals).toBe(1)
    expect(run.metrics.finalCalls).toBe(0)
  })

  it('uses the original full words for late corrections, never the earlier polished text', async () => {
    const polish = vi.fn(async (text: string) => text === raw ? cleaned : '只修改登录页面，不补测试。')
    const run = new ProgressivePolish({ polish, preview: vi.fn(), join })
    run.update(raw, '')
    await vi.advanceTimersByTimeAsync(DEFAULT_PROGRESSIVE_PAUSE_MS)
    const corrected = `${raw}不对第二条取消`
    run.update(corrected, '')
    expect(await run.finish(corrected)).toBe('只修改登录页面，不补测试。')
    expect(polish.mock.calls.map(call => call[0])).toEqual([raw, corrected])
    expect(run.metrics.finalCalls).toBe(1)
  })

  it('keeps trailing interim words raw and replaces a revised prefix without duplicate text', async () => {
    const preview = vi.fn()
    const run = new ProgressivePolish({ polish: async () => cleaned, preview, join })
    run.update(raw, '')
    await vi.advanceTimersByTimeAsync(DEFAULT_PROGRESSIVE_PAUSE_MS)
    run.update(raw, '还有')
    expect(preview).toHaveBeenLastCalledWith(`${cleaned}还有`)
    run.update('首先修复退出页面', '还有')
    expect(preview).toHaveBeenLastCalledWith('首先修复退出页面还有')
    run.cancel()
  })

  it('cancels stale in-flight work when the final raw snapshot differs', async () => {
    const earlier = deferred<string>()
    const preview = vi.fn()
    const polish = vi.fn((text: string) => text === raw ? earlier.promise : Promise.resolve('最终版本'))
    const run = new ProgressivePolish({ polish, preview, join })
    run.update(raw, '')
    await vi.advanceTimersByTimeAsync(DEFAULT_PROGRESSIVE_PAUSE_MS)
    const result = run.finish(`${raw}第三补充文档`)
    expect(await result).toBe('最终版本')
    earlier.resolve('迟到的旧结果')
    await vi.advanceTimersByTimeAsync(0)
    expect(preview).not.toHaveBeenCalledWith('迟到的旧结果')
  })

  it('does not call the model on every recognition event and keeps at most one background request running', async () => {
    const pending = deferred<string>()
    const polish = vi.fn(() => pending.promise)
    const run = new ProgressivePolish({ polish, preview: vi.fn(), join })
    for (let i = 0; i < 10; i++) {
      run.update(raw, String(i))
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(polish).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(DEFAULT_PROGRESSIVE_PAUSE_MS)
    expect(polish).toHaveBeenCalledTimes(1)
    run.update(`${raw}第三补充文档`, '')
    await vi.advanceTimersByTimeAsync(6000)
    expect(polish).toHaveBeenCalledTimes(1)
    run.cancel()
    pending.resolve(cleaned)
    await vi.advanceTimersByTimeAsync(0)
  })

  it('bounds speculative calls and input size while always allowing finalization', async () => {
    const polish = vi.fn(async (text: string) => text)
    const run = new ProgressivePolish({ polish, preview: vi.fn(), join, maxBackgroundCalls: 1 })
    run.update(raw, '')
    await vi.advanceTimersByTimeAsync(1000)
    run.update(`${raw}增加内容`, '')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(polish).toHaveBeenCalledTimes(1)
    expect(await run.finish(`${raw}增加内容`)).toBe(`${raw}增加内容`)
    expect(polish).toHaveBeenCalledTimes(2)
    const large = new ProgressivePolish({ polish, preview: vi.fn(), join, maxBackgroundCharacters: 2 })
    large.update(raw, '')
    await vi.advanceTimersByTimeAsync(2000)
    expect(large.metrics.backgroundCalls).toBe(0)
    large.cancel()
  })

  it('retries an exact failed speculative request once at finalization', async () => {
    const pending = deferred<string>()
    const polish = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(cleaned)
    const run = new ProgressivePolish({ polish, preview: vi.fn(), join })
    run.update(raw, '')
    await vi.advanceTimersByTimeAsync(DEFAULT_PROGRESSIVE_PAUSE_MS)
    const result = run.finish(raw)
    pending.reject(new Error('temporary failure'))
    expect(await result).toBe(cleaned)
    expect(polish).toHaveBeenCalledTimes(2)
  })

  it('invalidates late responses and timers after cancellation', async () => {
    const pending = deferred<string>()
    const preview = vi.fn()
    const polish = vi.fn(() => pending.promise)
    const run = new ProgressivePolish({ polish, preview, join })
    run.update(raw, '')
    await vi.advanceTimersByTimeAsync(DEFAULT_PROGRESSIVE_PAUSE_MS)
    run.cancel()
    expect(run.metrics.abortSignals).toBe(1)
    pending.resolve(cleaned)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(preview).not.toHaveBeenCalledWith(cleaned)
    await expect(run.finish(raw)).rejects.toThrow('cancelled')
    expect(polish).toHaveBeenCalledTimes(1)
  })

  it('skips speculative work for short utterances but still polishes on stop', async () => {
    const polish = vi.fn(async () => '你好。')
    const run = new ProgressivePolish({ polish, preview: vi.fn(), join })
    run.update('你好', '')
    await vi.advanceTimersByTimeAsync(5000)
    expect(polish).not.toHaveBeenCalled()
    expect(await run.finish('你好')).toBe('你好。')
  })

  it.each([
    { scenario: 'completed', stopAt: 2000, tail: false, expected: 0, calls: 1 },
    { scenario: 'in-flight', stopAt: 650, tail: false, expected: 500, calls: 1 },
    { scenario: 'changed-at-stop', stopAt: 2000, tail: true, expected: 800, calls: 2 },
    { scenario: 'no-pause', stopAt: 300, tail: false, expected: 800, calls: 1 },
  ])('controlled replay: $scenario', async ({ scenario, stopAt, tail, expected, calls }) => {
    // Scheduling evidence only: 800 ms simulated model, fixed synthetic input, no real inference.
    vi.setSystemTime(0)
    const polish = vi.fn((text: string) => new Promise<string>(resolve => setTimeout(() => resolve(text), 800)))
    const run = new ProgressivePolish({ polish, preview: vi.fn(), join })
    run.update(raw, '')
    await vi.advanceTimersByTimeAsync(stopAt)
    const stopped = Date.now()
    let finished = -1
    const finalRaw = tail ? `${raw}第二条取消` : raw
    const result = run.finish(finalRaw).then(text => { finished = Date.now(); return text })
    await vi.advanceTimersByTimeAsync(800)
    expect(await result).toBe(finalRaw)
    expect(finished - stopped).toBe(expected)
    expect(polish).toHaveBeenCalledTimes(calls)
    const baselineStart = Date.now()
    let baselineEnd = -1
    const baseline = polish(finalRaw).then(() => { baselineEnd = Date.now() })
    await vi.advanceTimersByTimeAsync(800)
    await baseline
    expect(baselineEnd - baselineStart).toBe(800)
    console.info(JSON.stringify({ scenario, simulatedModelMs: 800, baselineStopToFinalMs: 800,
      progressiveStopToFinalMs: finished - stopped, baselineCalls: 1,
      progressiveCalls: calls, baselineInputCharacters: finalRaw.length, ...run.metrics }))
  })
})
