import { useSyncExternalStore, type ReactNode } from 'react'
import { LANGUAGE_OPTIONS, loadPrefs, subscribePrefs, updatePrefs } from './prefs.ts'

/** Render the browser-local Voice Input settings page. */
export function SettingsPanel(): ReactNode {
  const prefs = useSyncExternalStore(subscribePrefs, loadPrefs, () => loadPrefs())

  return (
    <section style={{ maxWidth: 680, padding: '8px 4px' }}>
      <p style={{ margin: '0 0 22px', color: 'var(--color-text-secondary, #9ca3af)', fontSize: 13 }}>
        选择浏览器语音识别使用的语言。此设置保存在当前浏览器中。
      </p>
      <label
        htmlFor="voice-input-language"
        style={{ display: 'grid', gap: 8, maxWidth: 360, fontSize: 14 }}
      >
        <span>识别语言</span>
        <select
          id="voice-input-language"
          value={prefs.lang}
          onChange={event => { updatePrefs({ lang: event.currentTarget.value }) }}
          style={{
            width: '100%',
            minHeight: 36,
            border: '1px solid var(--color-border, #4b5563)',
            borderRadius: 8,
            padding: '0 10px',
            background: 'var(--color-background, #202124)',
            color: 'inherit',
          }}
        >
          {LANGUAGE_OPTIONS.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
    </section>
  )
}
