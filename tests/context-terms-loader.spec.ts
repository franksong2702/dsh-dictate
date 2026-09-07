import { describe, expect, it, vi } from 'vitest'
import { progressiveContextTermsLoader } from '../src/client/contextTermsLoader.ts'
import type { ContextTerm, ContextTermsRequest } from '../src/terms.ts'

const request: ContextTermsRequest = { sessionId: 'a', draft: '', includeInferred: true, model: { provider: 'p', model: 'm' } }
const rules: readonly ContextTerm[] = [{ text: 'VoxSpark', source: 'session', boost: 5 }]

describe('progressive context terms', () => {
  it('delivers rules before model enrichment resolves, using one no-model request first', async () => {
    let resolve!: (terms: readonly ContextTerm[]) => void
    const model = new Promise<readonly ContextTerm[]>(yes => { resolve = yes })
    const load = vi.fn().mockResolvedValueOnce(rules).mockReturnValueOnce(model)
    const partial = vi.fn()
    const result = progressiveContextTermsLoader(load)(request, new AbortController().signal, partial)
    await Promise.resolve()
    expect(partial).toHaveBeenCalledWith(rules)
    expect(load.mock.calls[0]?.[0]).not.toHaveProperty('model')
    expect(load.mock.calls[1]?.[0]).toEqual(request)
    resolve([...rules, { text: 'sherpa', source: 'session', boost: 5 }])
    expect(await result).toHaveLength(2)
  })

  it('keeps usable rules when optional model enrichment fails', async () => {
    const load = vi.fn().mockResolvedValueOnce(rules).mockRejectedValueOnce(new Error('model offline'))
    expect(await progressiveContextTermsLoader(load)(request, new AbortController().signal)).toEqual(rules)
  })

  it('does not launch or publish more work after cancellation', async () => {
    const controller = new AbortController()
    const load = vi.fn().mockResolvedValue(rules)
    const partial = vi.fn(() => controller.abort())
    const result = progressiveContextTermsLoader(load)(request, controller.signal, partial)
    await expect(result).rejects.toThrow('cancelled')
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('only makes one request when no model is configured', async () => {
    const load = vi.fn().mockResolvedValue(rules)
    const { model: _, ...withoutModel } = request
    expect(await progressiveContextTermsLoader(load)(withoutModel, new AbortController().signal)).toEqual(rules)
    expect(load).toHaveBeenCalledTimes(1)
  })
})
