import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { LANGUAGE_OPTIONS, loadPrefs, subscribePrefs, updatePrefs } from './prefs.ts'
import type {
  LocalServiceAutoStartSettings,
  LocalServiceInstallStatus,
  LocalServiceStatus,
} from '../local-service-contract.ts'

const SERVICE_STAGE_LABELS: Record<LocalServiceStatus['stage'], string> = {
  idle: '未启动',
  'checking-runtime': '检查运行环境',
  'starting-process': '启动服务进程',
  'checking-model': '检查模型文件',
  'downloading-model': '下载模型',
  'loading-model': '加载模型',
  'checking-health': '检查服务',
  ready: '已就绪',
  external: '外部服务',
  stopping: '停止服务',
  failed: '启动失败',
}

function serviceDiagnostics(status: LocalServiceStatus): string {
  const values = [
    `阶段：${SERVICE_STAGE_LABELS[status.stage]}`,
    `管理方式：${status.managed ? '插件管理' : '外部或未启动'}`,
  ]
  if (status.elapsedSeconds !== null) values.push(`已用时：${status.elapsedSeconds} 秒`)
  if (status.progressPercent !== null) values.push(`下载进度：${status.progressPercent}%`)
  return values.join(' · ')
}

function readableError(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null && 'message' in error
    && typeof (error as { readonly message?: unknown }).message === 'string') {
    return (error as { readonly message: string }).message
  }
  return fallback
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

/** One model exposed by the host for optional transcript polishing. */
export interface ModelOption {
  readonly value: string
  readonly label: string
}

/** Read-only host inputs for the Contextual Dictation settings card. */
export interface SettingsPanelProps {
  readonly modelOptions?: readonly ModelOption[]
  readonly localService?: {
    readonly status: (signal: AbortSignal) => Promise<LocalServiceStatus>
    readonly start: (signal: AbortSignal) => Promise<LocalServiceStatus>
    readonly stop: (signal: AbortSignal) => Promise<LocalServiceStatus>
    readonly install?: {
      readonly status: (signal: AbortSignal) => Promise<LocalServiceInstallStatus>
      readonly start: (signal: AbortSignal) => Promise<LocalServiceInstallStatus>
      readonly cancel: (signal: AbortSignal) => Promise<LocalServiceInstallStatus>
    }
    readonly autoStart?: {
      readonly get: (signal: AbortSignal) => Promise<LocalServiceAutoStartSettings>
      readonly set: (enabled: boolean, signal: AbortSignal) => Promise<LocalServiceAutoStartSettings>
    }
  }
}

/** Render the browser-local Contextual Dictation card inside Plugin configuration. */
export function SettingsPanel({
  modelOptions = [],
  localService,
}: SettingsPanelProps = {}): ReactNode {
  const prefs = useSyncExternalStore(subscribePrefs, loadPrefs, () => loadPrefs())
  const localInstaller = localService?.install
  const [open, setOpen] = useState(false)
  const [serviceStatus, setServiceStatus] = useState<LocalServiceStatus>()
  const [serviceBusy, setServiceBusy] = useState(false)
  const [serviceError, setServiceError] = useState('')
  const [installStatus, setInstallStatus] = useState<LocalServiceInstallStatus>()
  const [installBusy, setInstallBusy] = useState(false)
  const [installError, setInstallError] = useState('')
  const [autoStartSettings, setAutoStartSettings] = useState<LocalServiceAutoStartSettings>()
  const [autoStartBusy, setAutoStartBusy] = useState(false)
  const [autoStartError, setAutoStartError] = useState('')
  const autoStartControllerRef = useRef<AbortController>()
  const installControllerRef = useRef<AbortController>()

  useEffect(() => () => {
    autoStartControllerRef.current?.abort()
    installControllerRef.current?.abort()
  }, [])

  useEffect(() => {
    if (prefs.transcriptionProvider !== 'local-endpoint' || localService === undefined) return
    const controller = new AbortController()
    const refresh = (): void => {
      void localService.status(controller.signal).then((status) => {
        if (!controller.signal.aborted) {
          setServiceStatus(status)
          setServiceError('')
        }
      }, (error: unknown) => {
        if (!controller.signal.aborted) {
          setServiceError(readableError(error, '无法检查本地服务状态'))
        }
      })
    }
    refresh()
    const timer = window.setInterval(refresh, 3000)
    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [localService, prefs.transcriptionProvider])

  useEffect(() => {
    if (prefs.transcriptionProvider !== 'local-endpoint' || localInstaller === undefined) return
    const controller = new AbortController()
    installControllerRef.current = controller
    const refresh = (): void => {
      void localInstaller.status(controller.signal).then((status) => {
        if (!controller.signal.aborted) {
          setInstallStatus(status)
          setInstallError('')
        }
      }, (error: unknown) => {
        if (!controller.signal.aborted) {
          setInstallError(readableError(error, '无法检查本地 ASR 安装状态'))
        }
      })
    }
    refresh()
    const timer = window.setInterval(refresh, installStatus?.phase === 'installing' ? 500 : 3000)
    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [installStatus?.phase, localInstaller, prefs.transcriptionProvider])

  useEffect(() => {
    if (prefs.transcriptionProvider !== 'local-endpoint' || localService?.autoStart === undefined) return
    const controller = new AbortController()
    autoStartControllerRef.current = controller
    setAutoStartBusy(true)
    setAutoStartError('')
    void localService.autoStart.get(controller.signal).then((settings) => {
      if (!controller.signal.aborted) setAutoStartSettings(settings)
    }, (error: unknown) => {
      if (!controller.signal.aborted) {
        setAutoStartError(readableError(error, '无法读取自动启动设置'))
      }
    }).finally(() => {
      if (autoStartControllerRef.current === controller) setAutoStartBusy(false)
    })
    return () => controller.abort()
  }, [localService, prefs.transcriptionProvider])

  const updateAutoStart = (enabled: boolean): void => {
    if (localService?.autoStart === undefined) return
    autoStartControllerRef.current?.abort()
    const controller = new AbortController()
    autoStartControllerRef.current = controller
    setAutoStartBusy(true)
    setAutoStartError('')
    void localService.autoStart.set(enabled, controller.signal).then((settings) => {
      if (!controller.signal.aborted) setAutoStartSettings(settings)
    }, (error: unknown) => {
      if (!controller.signal.aborted) {
        setAutoStartError(readableError(error, '无法保存自动启动设置'))
      }
    }).finally(() => {
      if (autoStartControllerRef.current === controller) setAutoStartBusy(false)
    })
  }

  const runServiceAction = (
    action: (signal: AbortSignal) => Promise<LocalServiceStatus>,
  ): void => {
    const controller = new AbortController()
    setServiceBusy(true)
    setServiceError('')
    void action(controller.signal).then((status) => {
      setServiceStatus(status)
    }, (error: unknown) => {
      setServiceError(readableError(error, '本地服务操作失败'))
    }).finally(() => { setServiceBusy(false) })
  }

  const runInstallAction = (
    action: (signal: AbortSignal) => Promise<LocalServiceInstallStatus>,
  ): void => {
    installControllerRef.current?.abort()
    const controller = new AbortController()
    installControllerRef.current = controller
    setInstallBusy(true)
    setInstallError('')
    void action(controller.signal).then((status) => {
      if (!controller.signal.aborted) {
        setInstallStatus(status)
      }
    }, (error: unknown) => {
      if (!controller.signal.aborted) {
        setInstallError(readableError(error, '本地 ASR 安装操作失败'))
      }
    }).finally(() => {
      if (installControllerRef.current === controller) setInstallBusy(false)
    })
  }

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
          <fieldset style={{ display: 'grid', gap: 8, maxWidth: 520, margin: 0, padding: 0, border: 0 }}>
            <legend style={{ margin: '0 0 10px', padding: 0, fontSize: 13, fontWeight: 600, lineHeight: 1.5 }}>
              语音识别
            </legend>
            {([
              {
                value: 'web-speech' as const,
                title: '浏览器语音识别（默认）',
                description: '无需安装，立即使用。识别质量和可用性取决于浏览器及网络，音频可能由浏览器提供的在线服务处理。',
              },
              {
                value: 'local-endpoint' as const,
                title: '本地语音识别（Apple Silicon，实验性）',
                description: '录音和识别都在本机完成。首次使用需下载约 253 MB 识别模型，准备完成后可离线转写。',
              },
            ]).map(option => {
              const selected = prefs.transcriptionProvider === option.value
              return (
                <label
                  key={option.value}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 10,
                    padding: '10px 12px',
                    border: `1px solid ${selected ? 'var(--dsw-alias-border-l1)' : 'var(--dsw-alias-border-l2)'}`,
                    borderRadius: 8,
                    background: selected ? 'var(--dsw-alias-bg-layer-3)' : 'transparent',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="radio"
                    name="dictate-transcription-provider"
                    value={option.value}
                    checked={selected}
                    onChange={() => { updatePrefs({ transcriptionProvider: option.value }) }}
                    style={{ marginTop: 3 }}
                  />
                  <span style={{ display: 'grid', gap: 3 }}>
                    <strong style={{ fontSize: 13, lineHeight: 1.5 }}>{option.title}</strong>
                    <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, lineHeight: 1.5 }}>
                      {option.description}
                    </span>
                  </span>
                </label>
              )
            })}
          </fieldset>
          {prefs.transcriptionProvider === 'local-endpoint' ? (
            <div style={{ display: 'grid', gap: 8, marginTop: 12, maxWidth: 520 }}>
              {localService === undefined ? (
                <p role="status" style={{ margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }}>
                  当前 DSH 版本无法管理本地 ASR，请更新 DSH 后重试。
                </p>
              ) : (
                <div
                  style={{
                    display: 'grid',
                    gap: 8,
                    padding: 10,
                    border: '1px solid var(--dsw-alias-border-l2)',
                    borderRadius: 8,
                  }}
                >
                  {localInstaller !== undefined ? (
                    <div
                      style={{
                        display: 'grid',
                        gap: 8,
                        paddingBottom: 10,
                        borderBottom: '1px solid var(--dsw-alias-border-l2)',
                      }}
                    >
                      <strong style={{ fontSize: 13 }}>运行状态</strong>
                      <span role={installError === '' ? 'status' : 'alert'} style={{ fontSize: 12 }}>
                        {installError !== ''
                          ? installError
                          : installStatus?.phase === 'installed'
                            ? '已安装，可以使用'
                            : installStatus?.phase === 'not-installed'
                              ? '尚未安装'
                              : installStatus?.message ?? '正在检查安装状态'}
                      </span>
                      {installStatus?.phase === 'installing' && installStatus.progressPercent !== null ? (
                        <>
                          <progress
                            aria-label="本地语音识别安装进度"
                            max={100}
                            value={installStatus.progressPercent}
                            style={{ width: '100%' }}
                          />
                          <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }}>
                            {installStatus.completedBytes === null || installStatus.totalBytes === null
                              ? `${installStatus.progressPercent}%`
                              : `${formatBytes(installStatus.completedBytes)} / ${formatBytes(installStatus.totalBytes)}（${installStatus.progressPercent}%）`}
                          </span>
                        </>
                      ) : null}
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                        {installStatus?.phase === 'installing' ? (
                          <button
                            type="button"
                            disabled={installBusy}
                            onClick={() => { runInstallAction(localInstaller.cancel) }}
                          >
                            取消安装
                          </button>
                        ) : installStatus?.phase === 'installed' || installStatus?.phase === 'unsupported'
                          || installStatus?.available === false ? null : (
                          <button
                            type="button"
                            disabled={installBusy || installStatus === undefined}
                            onClick={() => { runInstallAction(localInstaller.start) }}
                          >
                            {installStatus?.phase === 'error' ? '重新安装' : '安装并准备'}
                          </button>
                        )}
                      </div>
                      <p style={{ margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, lineHeight: 1.5 }}>
                        {installStatus?.available === false
                          ? `当前版本暂不支持 ${installStatus.platform} 本地语音识别；请继续使用浏览器语音识别。`
                          : '识别模型：SenseVoice Q8。插件会自动完成安装和校验，不修改系统 Python 或 PATH。'}
                      </p>
                    </div>
                  ) : null}
                  {localService.autoStart !== undefined ? (
                    <>
                      <label
                        htmlFor="dictate-local-autostart"
                        style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 500 }}
                      >
                        <input
                          id="dictate-local-autostart"
                          type="checkbox"
                          checked={autoStartSettings?.enabled ?? false}
                          disabled={autoStartBusy || autoStartSettings === undefined
                            || (localInstaller !== undefined && installStatus?.available !== false
                              && installStatus?.phase !== 'installed')}
                          onChange={event => { updateAutoStart(event.currentTarget.checked) }}
                        />
                        <span>随 DSH 自动启动</span>
                      </label>
                      <p style={{ margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, lineHeight: 1.5 }}>
                        保存到当前 DSH profile；DSH 启动后会自动加载缓存模型。关闭只影响后续启动，不会停止当前服务。
                      </p>
                      {autoStartError !== '' ? <span role="alert" style={{ fontSize: 12 }}>{autoStartError}</span> : null}
                    </>
                  ) : null}
                  <span role={serviceError === '' ? 'status' : 'alert'} style={{ fontSize: 12 }}>
                    {serviceError !== ''
                      ? `当前状态：${serviceError}`
                      : `当前状态：${serviceStatus?.phase === 'running'
                        ? '运行中'
                        : serviceStatus?.phase === 'stopped'
                          ? '未启动'
                          : serviceStatus?.message ?? '正在检查'}`}
                  </span>
                  {serviceStatus?.phase === 'starting' && serviceStatus.progressPercent !== null ? (
                    <progress
                      aria-label="SenseVoice 模型下载进度"
                      max={100}
                      value={serviceStatus.progressPercent}
                      style={{ width: '100%' }}
                    />
                  ) : null}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    <button
                      type="button"
                      disabled={serviceBusy}
                      onClick={() => { runServiceAction(localService.status) }}
                    >
                      检查状态
                    </button>
                    {serviceStatus?.phase === 'running' ? (
                      <button
                        type="button"
                        disabled={serviceBusy || !serviceStatus.managed}
                        title={serviceStatus.managed ? '停止插件启动的本地服务' : '外部服务不能由插件停止'}
                        onClick={() => { runServiceAction(localService.stop) }}
                      >
                        停止服务
                      </button>
                    ) : serviceStatus?.phase === 'starting' ? (
                      <button
                        type="button"
                        disabled={serviceBusy || !serviceStatus.managed}
                        onClick={() => { runServiceAction(localService.stop) }}
                      >
                        取消启动
                      </button>
                    ) : serviceStatus?.phase === 'stopping' ? (
                      <button type="button" disabled>正在停止</button>
                    ) : (
                      <button
                        type="button"
                        disabled={serviceBusy
                          || (localInstaller !== undefined && installStatus?.available !== false
                            && installStatus?.phase !== 'installed')}
                        onClick={() => { runServiceAction(localService.start) }}
                      >
                        {serviceStatus?.phase === 'error' ? '重新启动服务' : '启动服务'}
                      </button>
                    )}
                  </div>
                  {serviceStatus !== undefined ? (
                    <details style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>
                      <summary>诊断信息</summary>
                      <code style={{ display: 'block', marginTop: 6, whiteSpace: 'normal' }}>
                        {serviceDiagnostics(serviceStatus)}
                      </code>
                    </details>
                  ) : null}
                </div>
              )}
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
          <h4 style={{ margin: '20px 0 10px', paddingTop: 16, borderTop: '1px solid var(--dsw-alias-border-l2)', fontSize: 13, lineHeight: 1.5 }}>
            输入方式
          </h4>
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
          <h4 style={{ margin: '20px 0 10px', paddingTop: 16, borderTop: '1px solid var(--dsw-alias-border-l2)', fontSize: 13, lineHeight: 1.5 }}>
            上下文增强
          </h4>
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
          <h4 style={{ margin: '20px 0 10px', paddingTop: 16, borderTop: '1px solid var(--dsw-alias-border-l2)', fontSize: 13, lineHeight: 1.5 }}>
            发送方式
          </h4>
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
