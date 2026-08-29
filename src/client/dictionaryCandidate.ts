import { normalizeDictionaryTerm } from './dictionaryStore.ts'

export const DICTIONARY_EDIT_WINDOW_MS = 5 * 60 * 1_000
export const DICTIONARY_EDIT_DEBOUNCE_MS = 800

function trimCandidate(value: string): string {
  return value
    .replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, '')
    .trim()
}

function looksLikeTechnicalTerm(value: string): boolean {
  if (!/^[A-Za-z0-9._+#/-]+(?:\s+[A-Za-z0-9._+#/-]+){0,3}$/.test(value)) return false
  const tokens = value.split(/\s+/)
  return tokens.some(token =>
    /[A-Z]/.test(token)
    || /[0-9._+#/-]/.test(token)
    || /[a-z][A-Z]/.test(token))
}

/**
 * Return one conservative dictionary candidate from a single Composer replacement.
 * Additions, deletions, prose-only edits, and large rewrites intentionally return undefined.
 */
export function detectDictionaryCandidate(
  originalTranscript: string,
  editedTranscript: string,
): string | undefined {
  if (originalTranscript === editedTranscript) return undefined
  const before = Array.from(originalTranscript)
  const after = Array.from(editedTranscript)
  let prefixLength = 0
  while (prefixLength < before.length && prefixLength < after.length
    && before[prefixLength] === after[prefixLength]) prefixLength += 1

  let suffixLength = 0
  while (suffixLength < before.length - prefixLength && suffixLength < after.length - prefixLength
    && before[before.length - 1 - suffixLength] === after[after.length - 1 - suffixLength]) {
    suffixLength += 1
  }

  const removed = before.slice(prefixLength, before.length - suffixLength).join('').trim()
  const inserted = trimCandidate(after.slice(prefixLength, after.length - suffixLength).join(''))
  if (removed === '' || inserted === '') return undefined
  if (Array.from(removed).length > 64 || Array.from(inserted).length > 64) return undefined
  if (!looksLikeTechnicalTerm(inserted)) return undefined
  return normalizeDictionaryTerm(inserted)
}
