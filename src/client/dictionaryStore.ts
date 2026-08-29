import {
  CONTEXT_TERM_CODE_POINT_LIMIT,
  CONTEXT_TERM_LIMIT,
  CONTEXT_TERM_MAX_BOOST,
  type ContextTerm,
} from '../terms.ts'

/** Browser-local dictionary used by recognition biasing and model polishing. */
export interface DictionarySnapshot {
  readonly terms: readonly string[]
}

export const DICTIONARY_KEY = 'dsh-dictate.dictionary.v1'
export const DICTIONARY_TERM_LIMIT = CONTEXT_TERM_LIMIT

const EMPTY_DICTIONARY: DictionarySnapshot = Object.freeze({ terms: Object.freeze([]) })
const listeners = new Set<() => void>()
let currentSnapshot: DictionarySnapshot | undefined

function browserStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

/** Normalize one user-confirmed term without guessing or rewriting it. */
export function normalizeDictionaryTerm(value: string): string | undefined {
  const term = value.trim().replace(/\s+/g, ' ')
  const length = Array.from(term).length
  if (length < 2 || length > CONTEXT_TERM_CODE_POINT_LIMIT || /^\p{Number}+$/u.test(term)) return undefined
  return term
}

function normalizeTerms(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return EMPTY_DICTIONARY.terms
  const terms: string[] = []
  const seen = new Set<string>()
  for (const candidate of value) {
    if (typeof candidate !== 'string') continue
    const term = normalizeDictionaryTerm(candidate)
    if (term === undefined) continue
    const key = term.toLocaleLowerCase('en-US')
    if (seen.has(key)) continue
    seen.add(key)
    terms.push(term)
    if (terms.length >= DICTIONARY_TERM_LIMIT) break
  }
  return Object.freeze(terms)
}

function persist(snapshot: DictionarySnapshot): void {
  const storage = browserStorage()
  if (storage === undefined) return
  try {
    storage.setItem(DICTIONARY_KEY, JSON.stringify(snapshot.terms))
  } catch {
    // Storage denial keeps the in-memory dictionary usable for this tab.
  }
}

function publish(terms: readonly string[]): DictionarySnapshot {
  const snapshot = Object.freeze({ terms: normalizeTerms(terms) })
  currentSnapshot = snapshot
  persist(snapshot)
  for (const listener of [...listeners]) listener()
  return snapshot
}

/** Read the stable browser-local dictionary snapshot. */
export function loadDictionary(): DictionarySnapshot {
  if (currentSnapshot !== undefined) return currentSnapshot
  const storage = browserStorage()
  if (storage !== undefined) {
    try {
      const saved = storage.getItem(DICTIONARY_KEY)
      if (saved !== null) {
        currentSnapshot = Object.freeze({ terms: normalizeTerms(JSON.parse(saved) as unknown) })
      }
    } catch {
      // Malformed or unavailable storage falls back to an empty dictionary.
    }
  }
  currentSnapshot ??= EMPTY_DICTIONARY
  return currentSnapshot
}

/** Add one explicitly confirmed term, keeping newest entries first. */
export function addDictionaryTerm(value: string): DictionarySnapshot {
  const term = normalizeDictionaryTerm(value)
  if (term === undefined) return loadDictionary()
  const key = term.toLocaleLowerCase('en-US')
  const retained = loadDictionary().terms.filter(candidate => candidate.toLocaleLowerCase('en-US') !== key)
  return publish([term, ...retained])
}

/** Remove one visible term by its case-insensitive canonical value. */
export function removeDictionaryTerm(value: string): DictionarySnapshot {
  const key = value.toLocaleLowerCase('en-US')
  return publish(loadDictionary().terms.filter(term => term.toLocaleLowerCase('en-US') !== key))
}

/** Subscribe settings surfaces to dictionary changes. */
export function subscribeDictionary(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Convert confirmed terms into the existing bounded context-term contract. */
export function dictionaryContextTerms(): readonly ContextTerm[] {
  return loadDictionary().terms.slice(0, CONTEXT_TERM_LIMIT).map(text => ({
    text,
    boost: CONTEXT_TERM_MAX_BOOST,
    source: 'composer',
  }))
}

/** Reset module state for deterministic browser-storage tests. */
export function resetDictionaryStoreForTests(): void {
  currentSnapshot = undefined
  listeners.clear()
}
