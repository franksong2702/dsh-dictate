import type { ContextTerm, ContextTermsRequest } from '../terms.ts'

export type ContextTermsLoader = (
  request: ContextTermsRequest,
  signal: AbortSignal,
  onRules?: (terms: readonly ContextTerm[]) => void,
) => Promise<readonly ContextTerm[]>

/** Release deterministic/history terms before waiting for optional model enrichment. */
export function progressiveContextTermsLoader(load: ContextTermsLoader): ContextTermsLoader {
  return async (request, signal, onRules) => {
    if (signal.aborted) throw new Error('term extraction was cancelled')
    const { model: _model, ...ruleRequest } = request
    const rules = await load(ruleRequest, signal)
    if (signal.aborted) throw new Error('term extraction was cancelled')
    onRules?.(rules)
    if (signal.aborted) throw new Error('term extraction was cancelled')
    if (request.model === undefined) return rules
    try {
      const terms = await load(request, signal)
      if (signal.aborted) throw new Error('term extraction was cancelled')
      return terms
    } catch (error) {
      if (signal.aborted) throw error
      return rules
    }
  }
}
