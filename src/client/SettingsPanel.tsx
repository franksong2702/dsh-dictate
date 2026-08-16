import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { useState, useSyncExternalStore, type ReactNode } from 'react'
import { LANGUAGE_OPTIONS, loadPrefs, subscribePrefs, updatePrefs } from './prefs.ts'

/** One model exposed by the host for optional transcript polishing. */
export interface ModelOption {
  readonly value: string
  readonly label: string
}

/** Read-only host inputs for the Voice Input settings card. */
export interface SettingsPanelProps {
  readonly modelOptions?: readonly ModelOption[]
}

/** Render the browser-local Voice Input card inside Plugin configuration. */
export function SettingsPanel({ modelOptions = [] }: SettingsPanelProps = {}): ReactNode {
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
            配置识别语言、模型润色和自动发送
          </span>
        </span>
        <span
          aria-hidden="true"
          style={{
            flex: 'none',
            display: 'flex',
            color: 'var(--dsw-alias-label-tertiary)',
            transform: open ? 'rotate(180deg)' : undefined,
            transition: 'transform .16s',
          }}
        >
          <IconChevronDownOutline14 />
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
          <div style={{ display: 'grid', gap: 8, marginTop: 18, maxWidth: 520 }}>
            <label
              htmlFor="voice-input-auto-send"
              style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 500 }}
            >
              <input
                id="voice-input-auto-send"
                type="checkbox"
                checked={prefs.autoSendEnabled}
                onChange={event => { updatePrefs({ autoSendEnabled: event.currentTarget.checked }) }}
              />
              <span>自动发送转写结果</span>
            </label>
            <p style={{ margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, lineHeight: 1.5 }}>
              用户点击结束录音后，自动发送输入框中的全部文字。浏览器自行结束识别时只填入输入框，不自动发送。启用模型润色时会等待润色完成；润色失败时仍会发送原始转写。
            </p>
          </div>
          <div style={{ display: 'grid', gap: 8, marginTop: 18, maxWidth: 520 }}>
            <label
              htmlFor="voice-input-model-polish"
              style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 500 }}
            >
              <input
                id="voice-input-model-polish"
                type="checkbox"
                checked={prefs.modelPolishEnabled}
                onChange={event => { updatePrefs({ modelPolishEnabled: event.currentTarget.checked }) }}
              />
              <span>启用模型润色</span>
            </label>
            <p style={{ margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, lineHeight: 1.5 }}>
              录音转写完成后，把原始转写和最近的会话文本发送给所选模型提供商进行润色，再填入输入框。是否自动发送由“自动发送转写结果”控制；润色失败时使用原始转写。
            </p>
            {prefs.modelPolishEnabled ? (
              modelOptions.length === 0 ? (
                <p role="status" style={{ margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }}>
                  暂无可用模型
                </p>
              ) : (
                <label
                  htmlFor="voice-input-polish-model"
                  style={{ display: 'grid', gap: 6, fontSize: 13, fontWeight: 500 }}
                >
                  <span>润色模型</span>
                  <select
                    id="voice-input-polish-model"
                    value={prefs.selectedModel}
                    onChange={event => { updatePrefs({ selectedModel: event.currentTarget.value }) }}
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
                    <option value="" disabled>请选择模型</option>
                    {modelOptions.map(option => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
              )
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  )
}
