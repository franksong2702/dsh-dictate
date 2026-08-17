/** One selectable browser speech-recognition language. */
export interface LanguageOption {
  readonly value: string
  readonly label: string
}

/** Languages exposed by the Voice Input settings page. */
export const LANGUAGE_OPTIONS: readonly LanguageOption[] = [
  { value: 'zh-CN', label: '中文（普通话）' },
  { value: 'zh-HK', label: '中文（粤语）' },
  { value: 'zh-TW', label: '中文（繁体）' },
  { value: 'en-US', label: 'English (US)' },
  { value: 'ja-JP', label: '日本語' },
  { value: 'ko-KR', label: '한국어' },
  { value: 'fr-FR', label: 'Français' },
  { value: 'de-DE', label: 'Deutsch' },
  { value: 'es-ES', label: 'Español' },
  { value: 'ru-RU', label: 'Русский' },
]

/** Browser-local Voice Input preferences. */
export interface VoiceInputPrefs {
  readonly lang: string
  readonly mixedLanguageOptimizationEnabled: boolean
  readonly composerShortcutEnabled: boolean
  readonly modelPolishEnabled: boolean
  readonly selectedModel: string
  readonly autoSendEnabled: boolean
}

export const DEFAULT_PREFS: VoiceInputPrefs = {
  lang: 'zh-CN',
  mixedLanguageOptimizationEnabled: false,
  composerShortcutEnabled: false,
  modelPolishEnabled: false,
  selectedModel: '',
  autoSendEnabled: false,
}
export const PREFS_KEY = 'dsh-voice-input.prefs.v1'

const languageValues = new Set(LANGUAGE_OPTIONS.map(option => option.value))
const listeners = new Set<() => void>()
let currentPrefs: VoiceInputPrefs | undefined

function browserStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    // Browser privacy settings may deny localStorage; in-memory preferences remain usable.
    return undefined
  }
}

/** Normalize persisted or partially updated browser preferences. */
export function normalizePrefs(raw: unknown): VoiceInputPrefs {
  if (typeof raw !== 'object' || raw === null || !('lang' in raw)) return DEFAULT_PREFS
  const candidate = raw as {
    lang?: unknown
    mixedLanguageOptimizationEnabled?: unknown
    composerShortcutEnabled?: unknown
    modelPolishEnabled?: unknown
    selectedModel?: unknown
    autoSendEnabled?: unknown
  }
  if (typeof candidate.lang !== 'string' || !languageValues.has(candidate.lang)) return DEFAULT_PREFS
  return {
    lang: candidate.lang,
    mixedLanguageOptimizationEnabled: typeof candidate.mixedLanguageOptimizationEnabled === 'boolean'
      ? candidate.mixedLanguageOptimizationEnabled
      : DEFAULT_PREFS.mixedLanguageOptimizationEnabled,
    composerShortcutEnabled: typeof candidate.composerShortcutEnabled === 'boolean'
      ? candidate.composerShortcutEnabled
      : DEFAULT_PREFS.composerShortcutEnabled,
    modelPolishEnabled: typeof candidate.modelPolishEnabled === 'boolean'
      ? candidate.modelPolishEnabled
      : DEFAULT_PREFS.modelPolishEnabled,
    selectedModel: typeof candidate.selectedModel === 'string'
      ? candidate.selectedModel
      : DEFAULT_PREFS.selectedModel,
    autoSendEnabled: typeof candidate.autoSendEnabled === 'boolean'
      ? candidate.autoSendEnabled
      : DEFAULT_PREFS.autoSendEnabled,
  }
}

/** Read the stable preferences snapshot used by React subscriptions. */
export function loadPrefs(): VoiceInputPrefs {
  if (currentPrefs !== undefined) return currentPrefs
  const storage = browserStorage()
  if (storage !== undefined) {
    try {
      const saved = storage.getItem(PREFS_KEY)
      if (saved !== null) currentPrefs = normalizePrefs(JSON.parse(saved) as unknown)
    } catch {
      // Malformed or unavailable storage falls back to the documented default.
    }
  }
  currentPrefs ??= DEFAULT_PREFS
  return currentPrefs
}

/** Persist browser-local Voice Input preferences and notify mounted surfaces. */
export function updatePrefs(patch: Partial<VoiceInputPrefs>): VoiceInputPrefs {
  const next = normalizePrefs({ ...loadPrefs(), ...patch })
  currentPrefs = next
  const storage = browserStorage()
  if (storage !== undefined) {
    try {
      storage.setItem(PREFS_KEY, JSON.stringify(next))
    } catch {
      // Browser storage failure leaves the in-memory preference active for this tab.
    }
  }
  for (const listener of [...listeners]) listener()
  return next
}

/** Subscribe a settings or composer surface to preference changes. */
export function subscribePrefs(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
