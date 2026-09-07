import type { Message } from '@deepseek-ai/dsh-llm'
import { extractContextTerms, type ContextTerm } from './terms.ts'

/** Process-local, session-scoped vocabulary; never saved to a separate file. */
export const SESSION_VOCABULARY_LIMIT = 128
const SESSION_LIMIT = 32
/** Bound reconstruction work independently of the model's short context window. */
const HISTORY_CHARACTER_LIMIT = 128_000
const vocabularies = new Map<string, readonly ContextTerm[]>()

export function resetSessionVocabulary(): void { vocabularies.clear() }

function visibleText(message: Message): string {
  if (!(message.role === 'user' && message.source.kind === 'user')
    && !(message.role === 'assistant' && message.source.kind === 'model')) return ''
  return message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

/** Rebuild rule terms from history and retain previously model-confirmed terms
 * only while their exact spelling still occurs in visible session text.
 * Draft-only terms are deliberately not promoted to session memory.
 */
export function sessionVocabulary(sessionId: string, messages: readonly Message[]): readonly ContextTerm[] {
  const previous = vocabularies.get(sessionId) ?? []
  const present = new Set<string>()
  const collected = new Map<string, ContextTerm>()
  let remaining = HISTORY_CHARACTER_LIMIT
  for (let index = messages.length - 1; index >= 0; index--) {
    const text = visibleText(messages[index]!)
    if (!text) continue
    const normalized = text.toLocaleLowerCase('en-US')
    for (const term of previous) {
      if (normalized.includes(term.text.toLocaleLowerCase('en-US'))) present.add(term.text.toLocaleLowerCase('en-US'))
    }
    if (remaining <= 0 || collected.size >= SESSION_VOCABULARY_LIMIT) continue
    const excerpt = text.slice(-remaining)
    remaining -= excerpt.length
    for (const term of extractContextTerms([{ text: excerpt, source: 'session' }])) {
      const key = term.text.toLocaleLowerCase('en-US')
      if (!collected.has(key)) collected.set(key, term)
      if (collected.size >= SESSION_VOCABULARY_LIMIT) break
    }
  }
  // Remembered terms need not fit in the reconstruction excerpt; deleted source
  // text, hidden tool output and discarded Composer drafts cannot keep them alive.
  for (const term of previous) {
    const key = term.text.toLocaleLowerCase('en-US')
    if (present.has(key) && !collected.has(key)) collected.set(key, term)
  }
  return rememberSessionVocabulary(sessionId, [...collected.values()])
}

export function rememberSessionVocabulary(sessionId: string, terms: readonly ContextTerm[]): readonly ContextTerm[] {
  const unique = new Map<string, ContextTerm>()
  for (const term of terms) {
    if (term.source !== 'session') continue
    const key = term.text.toLocaleLowerCase('en-US')
    if (!unique.has(key)) unique.set(key, { ...term })
    if (unique.size >= SESSION_VOCABULARY_LIMIT) break
  }
  const result = [...unique.values()]
  vocabularies.delete(sessionId)
  vocabularies.set(sessionId, result)
  while (vocabularies.size > SESSION_LIMIT) vocabularies.delete(vocabularies.keys().next().value!)
  return result
}
