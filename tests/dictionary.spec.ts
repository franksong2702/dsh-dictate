// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import { detectDictionaryCandidate } from '../src/client/dictionaryCandidate.ts'
import {
  DICTIONARY_KEY,
  addDictionaryTerm,
  dictionaryContextTerms,
  loadDictionary,
  removeDictionaryTerm,
  resetDictionaryStoreForTests,
} from '../src/client/dictionaryStore.ts'

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()
  get length(): number { return this.values.size }
  clear(): void { this.values.clear() }
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null }
  removeItem(key: string): void { this.values.delete(key) }
  setItem(key: string, value: string): void { this.values.set(key, value) }
}

describe('dictionary candidates', () => {
  it('extracts one short technical replacement from an otherwise stable transcript', () => {
    expect(detectDictionaryCandidate(
      '帮我检查扣代克斯康耐克特的 canary',
      '帮我检查Codex Connect的 canary',
    )).toBe('Codex Connect')
  })

  it('ignores additions, ordinary prose edits, and large semantic rewrites', () => {
    expect(detectDictionaryCandidate('帮我检查版本', '帮我检查版本并发布')).toBeUndefined()
    expect(detectDictionaryCandidate('please make it good', 'please make it better')).toBeUndefined()
    expect(detectDictionaryCandidate('把这个版本发布出去', '这个版本先不要发布 Codex')).toBeUndefined()
  })
})

describe('browser-local dictionary', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'localStorage', { configurable: true, value: new MemoryStorage() })
    resetDictionaryStoreForTests()
  })

  it('persists explicit additions, deduplicates case-insensitively, and removes visibly', () => {
    addDictionaryTerm('Codex Connect')
    addDictionaryTerm('codex connect')
    addDictionaryTerm('DSH')

    expect(loadDictionary().terms).toEqual(['DSH', 'codex connect'])
    expect(window.localStorage.getItem(DICTIONARY_KEY)).toBe('["DSH","codex connect"]')
    expect(dictionaryContextTerms()).toEqual([
      { text: 'DSH', boost: 6, source: 'composer' },
      { text: 'codex connect', boost: 6, source: 'composer' },
    ])

    removeDictionaryTerm('CODEX CONNECT')
    expect(loadDictionary().terms).toEqual(['DSH'])
  })

  it('ignores invalid entries without replacing a valid snapshot', () => {
    const first = addDictionaryTerm('SenseVoice Q8')
    expect(addDictionaryTerm(' ').terms).toBe(first.terms)
    expect(addDictionaryTerm('1').terms).toBe(first.terms)
  })
})
