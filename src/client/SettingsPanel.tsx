import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { useState, useSyncExternalStore, type ReactNode } from 'react'
import { LANGUAGE_OPTIONS, loadPrefs, subscribePrefs, updatePrefs } from './prefs.ts'

/** One model exposed by the host for optional transcript polishing. */
export interface ModelOption {
  readonly value: string
  readonly label: string
}

/** Read-only host inputs for the Contextual Dictation settings card. */
export interface SettingsPanelProps {
  readonly modelOptions?: readonly ModelOption[]
}

/** Render the browser-local Contextual Dictation card inside Plugin configuration. */
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
        aria-label={`${open ? '收起' : '展开'}：上下文语音输入`}
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
          <strong style={{ fontSize: 15, lineHeight: 1.4 }}>上下文语音输入</strong>
          <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 13, lineHeight: 1.5 }}>
            把语音转写到 Composer，并结合当前上下文优化识别和润色。
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
            识别和行为开关保存在当前浏览器中；动态词汇仅用于本次录音，不会保存。
          </p>
          <label
            htmlFor="dictate-transcription-provider"
            style={{ display: 'grid', gap: 6, maxWidth: 360, fontSize: 13, fontWeight: 500 }}
          >
            <span>转写方式</span>
            <select
              id="dictate-transcription-provider"
              value={prefs.transcriptionProvider}
              onChange={event => {
                updatePrefs({
                  transcriptionProvider: event.currentTarget.value === 'local-endpoint'
                    ? 'local-endpoint'
                    : 'web-speech',
                })
              }}
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
              <option value="web-speech">浏览器语音识别（默认）</option>
              <option value="local-endpoint">本地服务端点（实验性）</option>
            </select>
          </label>
          {prefs.transcriptionProvider === 'local-endpoint' ? (
            <div style={{ display: 'grid', gap: 8, marginTop: 12, maxWidth: 520 }}>
              <label
                htmlFor="dictate-local-endpoint"
                style={{ display: 'grid', gap: 6, maxWidth: 360, fontSize: 13, fontWeight: 500 }}
              >
                <span>本地服务地址</span>
                <input
                  id="dictate-local-endpoint"
                  type="url"
                  value={prefs.localEndpoint}
                  onChange={event => { updatePrefs({ localEndpoint: event.currentTarget.value }) }}
                  spellCheck={false}
                  style={{
                    width: '100%',
                    boxSizing: 'border-box',
                    height: 34,
                    border: '1px solid var(--dsw-alias-border-l2)',
                    borderRadius: 8,
                    padding: '0 12px',
                    background: 'var(--dsw-alias-bg-layer-3)',
                    color: 'var(--dsw-alias-label-primary)',
                    font: 'inherit',
                  }}
                />
              </label>
              <p style={{ margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, lineHeight: 1.5 }}>
                录音结束后发送到本机 SenseVoice 服务；不会在浏览器中下载模型。服务需单独启动，并允许当前 DSH 地址跨域访问。
              </p>
            </div>
          ) : null}
          <label
            htmlFor="dictate-language"
            style={{ display: 'grid', gap: 6, maxWidth: 360, marginTop: 14, fontSize: 13, fontWeight: 500 }}
          >
            <span>识别语言</span>
            <select
              id="dictate-language"
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
          {prefs.lang.startsWith('zh-') ? (
            <div style={{ display: 'grid', gap: 8, marginTop: 12, maxWidth: 520 }}>
              <label
                htmlFor="dictate-mixed-language-optimization"
                style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 500 }}
              >
                <input
                  id="dictate-mixed-language-optimization"
                  type="checkbox"
                  checked={prefs.mixedLanguageOptimizationEnabled}
                  onChange={event => {
                    updatePrefs({ mixedLanguageOptimizationEnabled: event.currentTarget.checked })
                  }}
                />
                <span>优化中英混合识别</span>
              </label>
              <p style={{ margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, lineHeight: 1.5 }}>
                {prefs.transcriptionProvider === 'web-speech'
                  ? '根据当前 Session 和 Composer 中出现的英文词、缩写和专有名词，提高 Web Speech 识别和模型润色的准确度。词汇仅用于本次录音，不会持久化；浏览器不支持时使用普通识别。'
                  : '根据当前 Session 和 Composer 中出现的英文词、缩写和专有名词，提高后续模型润色的准确度。SenseVoice 端点当前不接收动态词汇。'}
              </p>
            </div>
          ) : null}
          <div style={{ display: 'grid', gap: 8, marginTop: 18, maxWidth: 520 }}>
            <label
              htmlFor="dictate-composer-shortcut"
              style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 500 }}
            >
              <input
                id="dictate-composer-shortcut"
                type="checkbox"
                checked={prefs.composerShortcutEnabled}
                onChange={event => { updatePrefs({ composerShortcutEnabled: event.currentTarget.checked }) }}
              />
              <span>启用 Composer 录音快捷键</span>
            </label>
            <p style={{ margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, lineHeight: 1.5 }}>
              光标位于 Composer 文本框时，macOS 单击右 Command，Windows/Linux 单击右 Control。按一次开始，再按一次结束；与其他按键组合时不会触发。
            </p>
          </div>
          <div style={{ display: 'grid', gap: 8, marginTop: 18, maxWidth: 520 }}>
            <label
              htmlFor="dictate-model-polish"
              style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 500 }}
            >
              <input
                id="dictate-model-polish"
                type="checkbox"
                checked={prefs.modelPolishEnabled}
                onChange={event => { updatePrefs({ modelPolishEnabled: event.currentTarget.checked }) }}
              />
              <span>启用模型润色</span>
            </label>
            <p style={{ margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, lineHeight: 1.5 }}>
              所选模型会根据当前 Session 和 Composer 提取相关词汇，提高语音识别和转写润色的准确度。
            </p>
            {prefs.modelPolishEnabled ? (
              modelOptions.length === 0 ? (
                <p role="status" style={{ margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }}>
                  暂无可用模型
                </p>
              ) : (
                <label
                  htmlFor="dictate-polish-model"
                  style={{ display: 'grid', gap: 6, fontSize: 13, fontWeight: 500 }}
                >
                  <span>润色模型</span>
                  <select
                    id="dictate-polish-model"
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
          <div style={{ display: 'grid', gap: 8, marginTop: 18, maxWidth: 520 }}>
            <label
              htmlFor="dictate-auto-send"
              style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 500 }}
            >
              <input
                id="dictate-auto-send"
                type="checkbox"
                checked={prefs.autoSendEnabled}
                onChange={event => { updatePrefs({ autoSendEnabled: event.currentTarget.checked }) }}
              />
              <span>自动发送转写结果（Beta）</span>
            </label>
            <p style={{ margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, lineHeight: 1.5 }}>
              用户主动结束录音后，自动发送全部文字。识别或润色结果可能有误，建议保持关闭，并在 Composer 中检查后手动发送。
            </p>
          </div>
        </div>
      ) : null}
    </li>
  )
}
