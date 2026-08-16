import { useState, useSyncExternalStore, type ReactNode } from 'react'
import { LANGUAGE_OPTIONS, loadPrefs, subscribePrefs, updatePrefs } from './prefs.ts'

/** Render the browser-local Voice Input card inside Plugin configuration. */
export function SettingsPanel(): ReactNode {
  const prefs = useSyncExternalStore(subscribePrefs, loadPrefs, () => loadPrefs())
  const [open, setOpen] = useState(false)

  return (
    <li
      style={{
        listStyle: 'none',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 12,
        background: open ? 'var(--dsw-alias-bg-layer-2)' : 'var(--dsw-alias-bg-layer-3)',
        color: 'var(--dsw-alias-label-primary)',
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${open ? '收起' : '展开'}：语音输入`}
        onClick={() => { setOpen(value => !value) }}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          border: 0,
          borderRadius: 12,
          padding: '14px 16px',
          background: 'none',
          color: 'inherit',
          font: 'inherit',
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <strong style={{ fontSize: 15, lineHeight: 1.4 }}>语音输入</strong>
          <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 13, lineHeight: 1.5 }}>
            配置浏览器语音识别使用的语言
          </span>
        </span>
        <span
          aria-hidden="true"
          style={{
            color: 'var(--dsw-alias-label-tertiary)',
            transform: open ? 'rotate(180deg)' : undefined,
            transition: 'transform .16s',
          }}
        >
          ▾
        </span>
      </button>
      {open ? (
        <div
          style={{
            margin: '0 16px',
            padding: '12px 0 16px',
            borderTop: '1px solid var(--dsw-alias-border-l2)',
          }}
        >
          <p style={{ margin: '0 0 14px', color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }}>
            此设置保存在当前浏览器中。
          </p>
          <label
            htmlFor="voice-input-language"
            style={{ display: 'grid', gap: 6, maxWidth: 360, fontSize: 13, fontWeight: 500 }}
          >
            <span>识别语言</span>
            <select
              id="voice-input-language"
              value={prefs.lang}
              onChange={event => { updatePrefs({ lang: event.currentTarget.value }) }}
              style={{
                width: '100%',
                height: 34,
                border: '1px solid var(--dsw-alias-border-l2)',
                borderRadius: 8,
                padding: '0 12px',
                background: 'var(--dsw-alias-bg-layer-3)',
                color: 'var(--dsw-alias-label-primary)',
                font: 'inherit',
              }}
            >
              {LANGUAGE_OPTIONS.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        </div>
      ) : null}
    </li>
  )
}
