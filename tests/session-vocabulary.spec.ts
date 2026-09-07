import { beforeEach, describe, expect, it } from 'vitest'
import type { Message } from '@deepseek-ai/dsh-llm'
import { rememberSessionVocabulary, resetSessionVocabulary, sessionVocabulary, SESSION_VOCABULARY_LIMIT } from '../src/session-vocabulary.ts'

function user(text: string): Message {
  return { id: crypto.randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } as Message
}
const words = (terms: ReturnType<typeof sessionVocabulary>) => terms.map(term => term.text)

describe('session vocabulary', () => {
  beforeEach(resetSessionVocabulary)

  it('reconstructs technical words older than the six-message model window, including after reset', () => {
    const messages = [user('项目使用 VoxSpark 和 whisper'), ...Array.from({ length: 12 }, () => user('继续讨论界面和测试'))]
    expect(words(sessionVocabulary('a', messages))).toEqual(expect.arrayContaining(['VoxSpark', 'whisper']))
    resetSessionVocabulary()
    expect(words(sessionVocabulary('a', messages))).toEqual(expect.arrayContaining(['VoxSpark', 'whisper']))
  })

  it('retains model-confirmed lowercase words while their visible source survives', () => {
    rememberSessionVocabulary('a', [{ text: 'sherpa', boost: 5, source: 'session' }])
    const messages = [user('the engine is sherpa'), ...Array.from({ length: 10 }, () => user('继续讨论'))]
    expect(words(sessionVocabulary('a', messages))).toContain('sherpa')
    expect(words(sessionVocabulary('a', messages.slice(1)))).not.toContain('sherpa')
  })

  it('isolates sessions and never retains draft-only terms', () => {
    rememberSessionVocabulary('a', [
      { text: 'DraftOnly', boost: 6, source: 'composer' },
      { text: 'AlphaTerm', boost: 5, source: 'session' },
    ])
    expect(words(sessionVocabulary('a', [user('AlphaTerm')]))).toEqual(['AlphaTerm'])
    expect(words(sessionVocabulary('b', [user('BetaTerm')]))).toEqual(['BetaTerm'])
  })

  it('does not learn or keep vocabulary from hidden tool, plugin or reasoning content', () => {
    rememberSessionVocabulary('a', [{ text: 'HiddenWord', boost: 5, source: 'session' }])
    const hidden = { ...user('HiddenWord'), source: { kind: 'plugin', plugin: 'test' } } as Message
    const reasoning = { ...user(''), content: [{ type: 'reasoning', text: 'HiddenWord' }] } as Message
    expect(sessionVocabulary('a', [hidden, reasoning])).toEqual([])
  })

  it('bounds retained vocabulary and gives the latest occurrences priority', () => {
    const messages = Array.from({ length: 200 }, (_, index) => user(`Term${index}`))
    const terms = sessionVocabulary('a', messages)
    expect(terms).toHaveLength(SESSION_VOCABULARY_LIMIT)
    expect(words(terms)[0]).toBe('Term199')
    expect(words(terms)).not.toContain('Term0')
  })
})
