// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps, ComponentType, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsPanel } from '../src/client/SettingsPanel.tsx'
import { TranscriptionDock } from '../src/client/TranscriptionDock.tsx'
import {
  apply,
  encodeModelReference,
  joinRecognitionSegments,
  VoiceInputButton,
} from '../src/client/index.tsx'
import { loadPrefs, normalizePrefs, updatePrefs } from '../src/client/prefs.ts'
import type { ContextTerm } from '../src/terms.ts'
import type { AsrProvider, AsrProviderStartOptions } from '../src/client/asrProvider.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutline14: () => <svg data-testid="native-chevron" />,
}))

const DEFAULT_USER_AGENT = window.navigator.userAgent

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length(): number { return this.values.size }
  clear(): void { this.values.clear() }
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null }
  removeItem(key: string): void { this.values.delete(key) }
  setItem(key: string, value: string): void { this.values.set(key, value) }
}

class FakeRecognition extends EventTarget {
  static instances: FakeRecognition[] = []

  lang = ''
  continuous = false
  interimResults = false
  maxAlternatives = 0
  phrases: WebkitSpeechRecognitionPhrase[] = []
  onstart: (() => void) | null = null
  onresult: ((event: WebkitSpeechRecognitionEvent) => void) | null = null
  onerror: ((event: WebkitSpeechRecognitionErrorEvent) => void) | null = null
  onend: (() => void) | null = null
  startCalls = 0
  phrasesAtStart: WebkitSpeechRecognitionPhrase[] = []
  stopCalls = 0
  abortCalls = 0

  constructor() {
    super()
    FakeRecognition.instances.push(this)
  }

  start(): void {
    this.startCalls += 1
    this.phrasesAtStart = [...this.phrases]
  }
  stop(): void { this.stopCalls += 1 }
  abort(): void { this.abortCalls += 1 }

  emitResults(...segments: ReadonlyArray<{ readonly text: string; readonly final: boolean }>): void {
    const results = segments.map(segment => Object.assign(
      [{ transcript: segment.text }],
      { isFinal: segment.final },
    ))
    this.onresult?.({ resultIndex: 0, results } as unknown as WebkitSpeechRecognitionEvent)
  }

  finishWith(text: string): void {
    this.emitResults({ text, final: true })
    this.onend?.()
  }
}

class FakeSpeechRecognitionPhrase implements WebkitSpeechRecognitionPhrase {
  constructor(readonly phrase: string, readonly boost = 1) {}
}

function voiceSurfaces(props: ComponentProps<typeof VoiceInputButton>): ReactNode {
  return <>
    <VoiceInputButton {...props} />
    <TranscriptionDock sessionId={props.sessionId} />
  </>
}

function voiceComposer(props: ComponentProps<typeof VoiceInputButton>): ReactNode {
  return <div data-composer-card>
    <textarea aria-label="Composer" />
    {voiceSurfaces(props)}
  </div>
}

describe('Contextual Dictation browser plugin', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeRecognition.instances = []
    Object.defineProperty(window, 'localStorage', { configurable: true, value: new MemoryStorage() })
    Object.defineProperty(window.navigator, 'userAgent', { configurable: true, value: DEFAULT_USER_AGENT })
    window.SpeechRecognition = FakeRecognition
    window.SpeechRecognitionPhrase = undefined
    updatePrefs({
      transcriptionProvider: 'web-speech',
      localEndpoint: 'http://127.0.0.1:39081',
      localFallbackPolicy: 'local-only',
      lang: 'zh-CN',
      mixedLanguageOptimizationEnabled: false,
      composerShortcutEnabled: false,
      modelPolishEnabled: false,
      selectedModel: '',
      autoSendEnabled: false,
    })
  })

  afterEach(() => {
    cleanup()
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    window.SpeechRecognition = undefined
    window.SpeechRecognitionPhrase = undefined
  })

  it('registers a card inside the Plugin configuration tab', () => {
    const register = vi.fn(() => vi.fn())
    const inject = vi.fn((name: string, mount: () => unknown) => { mount() })

    apply({ slots: { inject, register } } as never)

    expect(inject.mock.calls.map(call => call[0])).toEqual([
      'conversation.input.right',
      'conversation.input.dock',
      'settings.plugin.item',
    ])
    expect(register.mock.calls[2]?.[0]).toMatchObject({
      name: 'settings.plugin.item',
      key: 'dictate',
    })
    expect(register.mock.calls[2]?.[0]).not.toHaveProperty('id')
    expect(register.mock.calls[2]?.[0]).not.toHaveProperty('order')
  })

  it('loads the current host model catalog for the polishing selector', async () => {
    const components: ComponentType<Record<string, never>>[] = []
    const register = vi.fn((_entry: unknown, component: unknown) => {
      components.push(component as ComponentType<Record<string, never>>)
      return vi.fn()
    })
    const inject = vi.fn((_name: string, mount: () => unknown) => { mount() })
    const models = vi.fn(() => Promise.resolve({
      rpcId: 'models-1',
      result: {
        ok: true as const,
        value: {
          groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'chat', name: 'DeepSeek Chat' }] }],
          failures: [],
        },
      },
    }))
    apply({
      slots: { inject, register },
      connection: { api: { llm: { models } }, rpc: { call: vi.fn() } },
    } as never)

    const Settings = components[2]
    expect(Settings).toBeDefined()
    render(Settings === undefined ? null : <Settings />)
    await act(async () => { await Promise.resolve() })
    fireEvent.click(screen.getByRole('button', { name: '展开：上下文语音输入' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '启用模型润色' }))

    expect(screen.getByLabelText('润色模型')).not.toBeNull()
    expect(screen.getByRole('option', { name: 'DeepSeek Chat · DeepSeek' })).not.toBeNull()
    expect(models).toHaveBeenCalledOnce()
  })

  it('uses host theme tokens without a fixed dark fallback', () => {
    render(<SettingsPanel />)
    const disclosure = screen.getByRole('button', { name: '展开：上下文语音输入' })
    expect(disclosure.querySelector('svg')).not.toBeNull()
    expect(disclosure.textContent).not.toContain('▾')
    expect(disclosure.textContent).toContain('把语音转写到 Composer，并结合当前上下文优化识别和润色。')
    fireEvent.click(disclosure)
    const select = screen.getByLabelText('识别语言') as HTMLSelectElement

    expect(select.style.background).toBe('var(--dsw-alias-bg-layer-3)')
    expect(select.style.color).toBe('var(--dsw-alias-label-primary)')
    expect(select.getAttribute('style')).not.toContain('#202124')
  })

  it('persists a language selected on the settings page', () => {
    const first = render(<SettingsPanel />)
    fireEvent.click(screen.getByRole('button', { name: '展开：上下文语音输入' }))
    fireEvent.change(screen.getByLabelText('识别语言'), { target: { value: 'ja-JP' } })
    expect(loadPrefs().lang).toBe('ja-JP')
    expect(window.localStorage.getItem('dsh-dictate.prefs.v1')).toBe(
      '{"transcriptionProvider":"web-speech","localEndpoint":"http://127.0.0.1:39081","localFallbackPolicy":"local-only","lang":"ja-JP","mixedLanguageOptimizationEnabled":false,"composerShortcutEnabled":false,"modelPolishEnabled":false,"selectedModel":"","autoSendEnabled":false}',
    )

    first.unmount()
    render(<SettingsPanel />)
    fireEvent.click(screen.getByRole('button', { name: '展开：上下文语音输入' }))
    expect((screen.getByLabelText('识别语言') as HTMLSelectElement).value).toBe('ja-JP')
  })

  it('normalizes legacy language-only preferences and new model fields', () => {
    expect(normalizePrefs({ lang: 'ja-JP' })).toEqual({
      transcriptionProvider: 'web-speech',
      localEndpoint: 'http://127.0.0.1:39081',
      localFallbackPolicy: 'local-only',
      lang: 'ja-JP',
      mixedLanguageOptimizationEnabled: false,
      composerShortcutEnabled: false,
      modelPolishEnabled: false,
      selectedModel: '',
      autoSendEnabled: false,
    })
    expect(normalizePrefs({ lang: 'en-US', modelPolishEnabled: true, selectedModel: 'deepseek-chat' })).toEqual({
      transcriptionProvider: 'web-speech',
      localEndpoint: 'http://127.0.0.1:39081',
      localFallbackPolicy: 'local-only',
      lang: 'en-US',
      mixedLanguageOptimizationEnabled: false,
      composerShortcutEnabled: false,
      modelPolishEnabled: true,
      selectedModel: 'deepseek-chat',
      autoSendEnabled: false,
    })
  })

  it('keeps Web Speech as default and persists the optional local endpoint route', () => {
    render(<SettingsPanel />)
    fireEvent.click(screen.getByRole('button', { name: '展开：上下文语音输入' }))
    const provider = screen.getByLabelText('转写方式') as HTMLSelectElement

    expect(provider.value).toBe('web-speech')
    expect(screen.queryByLabelText('本地服务地址')).toBeNull()
    fireEvent.change(provider, { target: { value: 'local-endpoint' } })

    const endpoint = screen.getByLabelText('本地服务地址') as HTMLInputElement
    expect(endpoint.value).toBe('http://127.0.0.1:39081')
    expect(screen.getByText(/不会在浏览器中下载模型/)).not.toBeNull()
    expect((screen.getByLabelText('本地服务不可用时') as HTMLSelectElement).value).toBe('local-only')
    fireEvent.change(screen.getByLabelText('本地服务不可用时'), { target: { value: 'ask' } })
    expect(loadPrefs().localFallbackPolicy).toBe('ask')
    fireEvent.change(endpoint, { target: { value: '' } })
    expect((screen.getByLabelText('本地服务地址') as HTMLInputElement).value).toBe('')
    fireEvent.change(endpoint, { target: { value: 'http://localhost:41000/v1' } })
    expect(loadPrefs()).toMatchObject({
      transcriptionProvider: 'local-endpoint',
      localEndpoint: 'http://localhost:41000/v1',
    })
  })

  it('tests the configured endpoint directly from plugin settings', async () => {
    updatePrefs({ transcriptionProvider: 'local-endpoint' })
    const testEndpoint = vi.fn(async () => '连接成功：本地 SenseVoice 服务已就绪')
    render(<SettingsPanel testEndpoint={testEndpoint} />)
    fireEvent.click(screen.getByRole('button', { name: '展开：上下文语音输入' }))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
      await Promise.resolve()
    })

    expect(testEndpoint).toHaveBeenCalledWith(
      'http://127.0.0.1:39081',
      expect.any(AbortSignal),
    )
    expect(screen.getByText('连接成功：本地 SenseVoice 服务已就绪')).not.toBeNull()
  })

  it('shows a readable configured-endpoint connection failure', async () => {
    updatePrefs({ transcriptionProvider: 'local-endpoint' })
    const testEndpoint = vi.fn(() => Promise.reject({ message: '连接被拒绝' }))
    render(<SettingsPanel testEndpoint={testEndpoint} />)
    fireEvent.click(screen.getByRole('button', { name: '展开：上下文语音输入' }))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
      await Promise.resolve()
    })

    expect(screen.getByRole('alert').textContent).toContain('连接被拒绝')
  })

  it('checks, starts, and stops the managed local service from plugin settings', async () => {
    updatePrefs({ transcriptionProvider: 'local-endpoint' })
    const status = vi.fn(async () => ({
      phase: 'stopped' as const,
      stage: 'idle' as const,
      endpoint: 'http://127.0.0.1:39081',
      managed: false,
      message: '本地服务未启动',
      progressPercent: null,
      elapsedSeconds: null,
    }))
    const start = vi.fn(async () => ({
      phase: 'running' as const,
      stage: 'ready' as const,
      endpoint: 'http://127.0.0.1:39081',
      managed: true,
      message: '本地 SenseVoice 服务运行中',
      progressPercent: null,
      elapsedSeconds: 8,
    }))
    const stop = vi.fn(async () => ({
      phase: 'stopped' as const,
      stage: 'idle' as const,
      endpoint: 'http://127.0.0.1:39081',
      managed: false,
      message: '本地服务已停止',
      progressPercent: null,
      elapsedSeconds: null,
    }))
    render(<SettingsPanel localService={{ status, start, stop }} />)
    fireEvent.click(screen.getByRole('button', { name: '展开：上下文语音输入' }))
    await act(async () => { await Promise.resolve() })

    expect(status).toHaveBeenCalledWith(expect.any(AbortSignal))
    expect(screen.getByRole('status').textContent).toContain('本地服务未启动')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '检查状态' }))
      await Promise.resolve()
    })
    expect(status).toHaveBeenCalledTimes(2)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '启动服务' }))
      await Promise.resolve()
    })
    expect(start).toHaveBeenCalledWith(expect.any(AbortSignal))
    expect(screen.getByRole('status').textContent).toContain('本地 SenseVoice 服务运行中')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '停止服务' }))
      await Promise.resolve()
    })
    expect(stop).toHaveBeenCalledWith(expect.any(AbortSignal))
    expect(screen.getByRole('status').textContent).toContain('本地服务已停止')
  })

  it('shows real startup progress, cancel, retry, and diagnostics', async () => {
    updatePrefs({ transcriptionProvider: 'local-endpoint' })
    const status = vi.fn(async () => ({
      phase: 'starting' as const,
      stage: 'downloading-model' as const,
      endpoint: 'http://127.0.0.1:39081',
      managed: true,
      message: '正在下载 SenseVoice 模型（42%）',
      progressPercent: 42,
      elapsedSeconds: 17,
    }))
    const start = vi.fn(async () => ({
      phase: 'error' as const,
      stage: 'failed' as const,
      endpoint: 'http://127.0.0.1:39081',
      managed: false,
      message: '未找到 funasr-server',
      progressPercent: null,
      elapsedSeconds: 1,
    }))
    const stop = vi.fn(async () => ({
      phase: 'stopped' as const,
      stage: 'idle' as const,
      endpoint: 'http://127.0.0.1:39081',
      managed: false,
      message: '本地服务已停止',
      progressPercent: null,
      elapsedSeconds: null,
    }))
    render(<SettingsPanel localService={{ status, start, stop }} />)
    fireEvent.click(screen.getByRole('button', { name: '展开：上下文语音输入' }))
    await act(async () => { await Promise.resolve() })

    expect((screen.getByRole('progressbar', {
      name: 'SenseVoice 模型下载进度',
    }) as HTMLProgressElement).value).toBe(42)
    expect(screen.getByRole('button', { name: '取消启动' })).not.toBeNull()
    fireEvent.click(screen.getByText('诊断信息'))
    expect(screen.getByText(/阶段：下载模型/).textContent).toContain('已用时：17 秒')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '取消启动' }))
      await Promise.resolve()
    })
    expect(stop).toHaveBeenCalledWith(expect.any(AbortSignal))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '启动服务' }))
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: '重新启动服务' })).not.toBeNull()
  })

  it('shows mixed-language optimization for every Chinese language and preserves it while inactive', () => {
    render(<SettingsPanel />)
    fireEvent.click(screen.getByRole('button', { name: '展开：上下文语音输入' }))
    const language = screen.getByLabelText('识别语言')

    for (const value of ['zh-CN', 'zh-HK', 'zh-TW']) {
      fireEvent.change(language, { target: { value } })
      expect(screen.getByRole('checkbox', { name: '优化中英混合识别' })).not.toBeNull()
    }

    fireEvent.click(screen.getByRole('checkbox', { name: '优化中英混合识别' }))
    expect(loadPrefs().mixedLanguageOptimizationEnabled).toBe(true)
    fireEvent.change(language, { target: { value: 'en-US' } })
    expect(screen.queryByRole('checkbox', { name: '优化中英混合识别' })).toBeNull()
    expect(loadPrefs().mixedLanguageOptimizationEnabled).toBe(true)
    fireEvent.change(language, { target: { value: 'zh-CN' } })
    expect((screen.getByRole('checkbox', { name: '优化中英混合识别' }) as HTMLInputElement).checked).toBe(true)
  })

  it('toggles model polishing and persists a selected model', () => {
    render(<SettingsPanel modelOptions={[
      { value: 'deepseek-chat', label: 'DeepSeek Chat' },
      { value: 'deepseek-reasoner', label: 'DeepSeek Reasoner' },
    ]} />)
    fireEvent.click(screen.getByRole('button', { name: '展开：上下文语音输入' }))

    expect(screen.getByText('所选模型会根据当前 Session 和 Composer 提取相关词汇，提高语音识别和转写润色的准确度。')).not.toBeNull()
    expect((screen.getByRole('checkbox', { name: '启用模型润色' }) as HTMLInputElement).checked).toBe(false)
    expect(screen.queryByLabelText('润色模型')).toBeNull()

    fireEvent.click(screen.getByRole('checkbox', { name: '启用模型润色' }))
    expect(loadPrefs().modelPolishEnabled).toBe(true)
    fireEvent.change(screen.getByLabelText('润色模型'), { target: { value: 'deepseek-reasoner' } })

    expect(loadPrefs().selectedModel).toBe('deepseek-reasoner')
    expect(window.localStorage.getItem('dsh-dictate.prefs.v1')).toBe(
      '{"transcriptionProvider":"web-speech","localEndpoint":"http://127.0.0.1:39081","localFallbackPolicy":"local-only","lang":"zh-CN","mixedLanguageOptimizationEnabled":false,"composerShortcutEnabled":false,"modelPolishEnabled":true,"selectedModel":"deepseek-reasoner","autoSendEnabled":false}',
    )
  })

  it('keeps automatic sending off by default and persists explicit opt-in', () => {
    render(<SettingsPanel />)
    fireEvent.click(screen.getByRole('button', { name: '展开：上下文语音输入' }))

    const toggle = screen.getByRole('checkbox', { name: '自动发送转写结果（Beta）' }) as HTMLInputElement
    expect(toggle.checked).toBe(false)
    expect(screen.getByText('用户主动结束录音后，自动发送全部文字。识别或润色结果可能有误，建议保持关闭，并在 Composer 中检查后手动发送。')).not.toBeNull()
    const modelPolish = screen.getByRole('checkbox', { name: '启用模型润色' })
    expect(modelPolish.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)

    fireEvent.click(toggle)
    expect(loadPrefs().autoSendEnabled).toBe(true)
    expect(window.localStorage.getItem('dsh-dictate.prefs.v1')).toBe(
      '{"transcriptionProvider":"web-speech","localEndpoint":"http://127.0.0.1:39081","localFallbackPolicy":"local-only","lang":"zh-CN","mixedLanguageOptimizationEnabled":false,"composerShortcutEnabled":false,"modelPolishEnabled":false,"selectedModel":"","autoSendEnabled":true}',
    )
  })

  it('keeps the Composer shortcut off by default and persists explicit opt-in', () => {
    render(<SettingsPanel />)
    fireEvent.click(screen.getByRole('button', { name: '展开：上下文语音输入' }))

    const shortcut = screen.getByRole('checkbox', { name: '启用 Composer 录音快捷键' }) as HTMLInputElement
    expect(shortcut.checked).toBe(false)
    expect(screen.getByText('光标位于 Composer 文本框时，macOS 单击右 Command，Windows/Linux 单击右 Control。按一次开始，再按一次结束；与其他按键组合时不会触发。')).not.toBeNull()

    fireEvent.click(shortcut)
    expect(loadPrefs().composerShortcutEnabled).toBe(true)
    expect(window.localStorage.getItem('dsh-dictate.prefs.v1')).toBe(
      '{"transcriptionProvider":"web-speech","localEndpoint":"http://127.0.0.1:39081","localFallbackPolicy":"local-only","lang":"zh-CN","mixedLanguageOptimizationEnabled":false,"composerShortcutEnabled":true,"modelPolishEnabled":false,"selectedModel":"","autoSendEnabled":false}',
    )
  })

  it('reports that polishing models are unavailable when the host list is empty', () => {
    render(<SettingsPanel />)
    fireEvent.click(screen.getByRole('button', { name: '展开：上下文语音输入' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '启用模型润色' }))

    expect(screen.getByText('暂无可用模型')).not.toBeNull()
    expect(screen.queryByLabelText('润色模型')).toBeNull()
  })

  it('starts on the first click, stops on the second, and clears completion after three seconds', () => {
    updatePrefs({ lang: 'zh-HK' })
    const setDraft = vi.fn()
    const submit = vi.fn()
    render(voiceSurfaces({ inputActions: { setDraft, submit }, input: { draft: '' }, sessionId: 'session-1' }))

    const button = screen.getByRole('button', { name: '语音输入' })
    fireEvent.click(button)
    const recognition = FakeRecognition.instances[0]
    expect(recognition).toBeDefined()
    expect(recognition?.lang).toBe('zh-HK')
    expect(recognition?.startCalls).toBe(1)

    act(() => { recognition?.onstart?.() })
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(button.getAttribute('title')).toBe('点击结束并转写')

    fireEvent.click(button)
    expect(recognition?.stopCalls).toBe(1)

    act(() => { recognition?.finishWith('测试转写') })
    expect(setDraft).toHaveBeenCalledWith('测试转写')
    expect(submit).not.toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toContain('已转写完成')
    expect(screen.getByRole('status').textContent).toContain('转写结果已写入输入框，请检查后发送')
    expect(document.querySelector('[data-transcription-final]')).toBeNull()

    act(() => { vi.advanceTimersByTime(2999) })
    expect(screen.queryByRole('status')).not.toBeNull()
    act(() => { vi.advanceTimersByTime(1) })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('uses the local endpoint through the same Composer and explicit auto-send flow', async () => {
    updatePrefs({ transcriptionProvider: 'local-endpoint', autoSendEnabled: true })
    let callbacks: AsrProviderStartOptions | undefined
    const stop = vi.fn(async () => {
      callbacks?.onStatus?.('stopping')
      callbacks?.onProgress?.({ phase: 'runtime', message: '正在由本地服务转写' })
      callbacks?.onFinal?.('本地端点结果')
      callbacks?.onEnd?.('stop')
    })
    const provider: AsrProvider = {
      start: vi.fn((options = {}) => {
        callbacks = options
        options.onStart?.()
        return {
          stop,
          abort: vi.fn(async () => { options.onEnd?.('abort') }),
          updateTerms: vi.fn(async () => {}),
        }
      }),
    }
    const setDraft = vi.fn()
    const submit = vi.fn()
    render(voiceSurfaces({
      inputActions: { setDraft, submit },
      input: { draft: '已有文字' },
      sessionId: 'local-session',
      providers: { 'local-endpoint': provider },
    }))

    const button = screen.getByRole('button', { name: '语音输入' })
    fireEvent.click(button)
    expect(FakeRecognition.instances).toHaveLength(0)
    expect(button.getAttribute('title')).toBe('点击结束并转写')
    expect(document.querySelector('[data-transcription-title]')?.textContent).toBe('正在录音中')
    expect(screen.getByRole('status').textContent).toContain('再次点击麦克风结束并转写')
    expect(screen.getByRole('status').textContent).not.toContain('请开始说话')
    expect(setDraft).not.toHaveBeenCalled()

    await act(async () => { fireEvent.click(button); await Promise.resolve() })
    expect(stop).toHaveBeenCalledOnce()
    expect(setDraft).toHaveBeenCalledWith('已有文字 本地端点结果')
    expect(submit).toHaveBeenCalledOnce()
    expect(screen.getByRole('status').textContent).toContain('已转写完成')
    expect(screen.getByRole('status').textContent).toContain('转写结果已直接发送')
  })

  it('keeps five-character titles and phase-aware auxiliary copy through local ASR', () => {
    updatePrefs({ transcriptionProvider: 'local-endpoint' })
    let callbacks: AsrProviderStartOptions | undefined
    const provider: AsrProvider = {
      start: vi.fn((options = {}) => {
        callbacks = options
        options.onStart?.()
        return {
          stop: vi.fn(async () => {}),
          abort: vi.fn(async () => { options.onEnd?.('abort') }),
          updateTerms: vi.fn(async () => {}),
        }
      }),
    }
    render(voiceSurfaces({
      inputActions: { setDraft: vi.fn(), submit: vi.fn() },
      input: { draft: '' },
      sessionId: 'local-copy-session',
      providers: { 'local-endpoint': provider },
    }))

    const button = screen.getByRole('button', { name: '语音输入' })
    fireEvent.click(button)
    expect(document.querySelector('[data-transcription-title]')?.textContent).toBe('正在录音中')
    expect(document.querySelector('[data-transcription-auxiliary]')?.textContent).toContain(
      '再次点击麦克风结束并转写',
    )

    act(() => { callbacks?.onProgress?.({ phase: 'voice', message: '已检测到语音' }) })
    expect(document.querySelector('[data-transcription-title]')?.textContent).toBe('正在录音中')
    expect(document.querySelector('[data-transcription-auxiliary]')?.textContent).toContain(
      '已检测到语音',
    )

    fireEvent.click(button)
    expect(document.querySelector('[data-transcription-title]')?.textContent).toBe('正在转写中')
    expect(document.querySelector('[data-transcription-auxiliary]')?.textContent).toContain(
      '正在保留结尾语音',
    )

    act(() => { callbacks?.onProgress?.({ phase: 'runtime', message: '正在由本地服务转写' }) })
    const title = document.querySelector('[data-transcription-title]')?.textContent ?? ''
    expect(title).toBe('正在转写中')
    expect(Array.from(title)).toHaveLength(5)
    expect(document.querySelector('[data-transcription-auxiliary]')?.textContent).toContain(
      '本地服务正在识别语音，请稍候',
    )
  })

  it('only shows the microphone authorization state after a two-second delay', () => {
    updatePrefs({ transcriptionProvider: 'local-endpoint' })
    const provider: AsrProvider = {
      start: vi.fn(() => new Promise<never>(() => {})),
    }
    render(voiceSurfaces({
      inputActions: { setDraft: vi.fn(), submit: vi.fn() },
      input: { draft: '' },
      sessionId: 'local-permission-session',
      providers: { 'local-endpoint': provider },
    }))

    const button = screen.getByRole('button', { name: '语音输入' })
    fireEvent.click(button)
    expect(document.querySelector('[data-transcription-title]')).toBeNull()

    act(() => { vi.advanceTimersByTime(1999) })
    expect(document.querySelector('[data-transcription-title]')).toBeNull()

    act(() => { vi.advanceTimersByTime(1) })
    expect(document.querySelector('[data-transcription-title]')?.textContent).toBe('等待授权中')
    expect(document.querySelector('[data-transcription-auxiliary]')?.textContent).toContain(
      '请按浏览器提示允许麦克风访问',
    )

    fireEvent.click(button)
    expect(document.querySelector('[data-transcription-title]')).toBeNull()
  })

  it('asks before falling back to Web Speech when the local preflight fails', async () => {
    updatePrefs({ transcriptionProvider: 'local-endpoint', localFallbackPolicy: 'ask' })
    const checkLocalEndpoint = vi.fn(() => Promise.reject({ message: '本地服务未启动' }))
    const localStart = vi.fn()
    const webStart = vi.fn((options: AsrProviderStartOptions = {}) => {
      options.onStart?.()
      return {
        stop: vi.fn(async () => {}),
        abort: vi.fn(async () => { options.onEnd?.('abort') }),
        updateTerms: vi.fn(async () => {}),
      }
    })
    render(voiceSurfaces({
      inputActions: { setDraft: vi.fn(), submit: vi.fn() },
      input: { draft: '' },
      sessionId: 'local-fallback-ask',
      checkLocalEndpoint,
      providers: {
        'local-endpoint': { start: localStart },
        'web-speech': { start: webStart },
      },
    }))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '语音输入' }))
      await Promise.resolve()
    })

    expect(localStart).not.toHaveBeenCalled()
    expect(webStart).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('是否改用 Web Speech')
    fireEvent.click(screen.getByRole('button', { name: '改用 Web Speech' }))
    expect(webStart).toHaveBeenCalledOnce()
    expect(document.querySelector('[data-transcription-title]')?.textContent).toBe('正在听写中')
    expect(document.querySelector('[data-transcription-auxiliary]')?.textContent).toContain(
      '已按设置改用 Web Speech',
    )
  })

  it('keeps a failed local preflight local-only by default', async () => {
    updatePrefs({ transcriptionProvider: 'local-endpoint', localFallbackPolicy: 'local-only' })
    const localStart = vi.fn()
    const webStart = vi.fn()
    render(voiceSurfaces({
      inputActions: { setDraft: vi.fn(), submit: vi.fn() },
      input: { draft: '' },
      sessionId: 'local-fallback-disabled',
      checkLocalEndpoint: () => Promise.reject({ message: '本地服务未启动' }),
      providers: {
        'local-endpoint': { start: localStart },
        'web-speech': { start: webStart },
      },
    }))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '语音输入' }))
      await Promise.resolve()
    })

    expect(localStart).not.toHaveBeenCalled()
    expect(webStart).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('本地服务未启动')
    expect(screen.queryByRole('button', { name: '改用 Web Speech' })).toBeNull()
  })

  it('automatically falls back before recording only when the user allowed it', async () => {
    updatePrefs({ transcriptionProvider: 'local-endpoint', localFallbackPolicy: 'web-speech' })
    const localStart = vi.fn()
    const webStart = vi.fn((options: AsrProviderStartOptions = {}) => {
      options.onStart?.()
      return {
        stop: vi.fn(async () => {}),
        abort: vi.fn(async () => { options.onEnd?.('abort') }),
        updateTerms: vi.fn(async () => {}),
      }
    })
    render(voiceSurfaces({
      inputActions: { setDraft: vi.fn(), submit: vi.fn() },
      input: { draft: '' },
      sessionId: 'local-fallback-auto',
      checkLocalEndpoint: () => Promise.reject({ message: '本地服务未启动' }),
      providers: {
        'local-endpoint': { start: localStart },
        'web-speech': { start: webStart },
      },
    }))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '语音输入' }))
      await Promise.resolve()
    })

    expect(localStart).not.toHaveBeenCalled()
    expect(webStart).toHaveBeenCalledOnce()
    expect(document.querySelector('[data-transcription-title]')?.textContent).toBe('正在听写中')
    expect(document.querySelector('[data-transcription-auxiliary]')?.textContent).toContain(
      '已按设置改用 Web Speech',
    )
  })

  it('never falls back after local audio has already been recorded', async () => {
    updatePrefs({ transcriptionProvider: 'local-endpoint', localFallbackPolicy: 'web-speech' })
    let callbacks: AsrProviderStartOptions | undefined
    const localStart = vi.fn((options: AsrProviderStartOptions = {}) => {
      callbacks = options
      options.onStart?.()
      return {
        stop: vi.fn(async () => {
          options.onError?.({ code: 'endpoint-unreachable', message: '本地转写服务中断' })
          options.onEnd?.('error')
        }),
        abort: vi.fn(async () => { options.onEnd?.('abort') }),
        updateTerms: vi.fn(async () => {}),
      }
    })
    const webStart = vi.fn()
    render(voiceSurfaces({
      inputActions: { setDraft: vi.fn(), submit: vi.fn() },
      input: { draft: '' },
      sessionId: 'local-no-post-recording-fallback',
      checkLocalEndpoint: () => Promise.resolve('连接成功'),
      providers: {
        'local-endpoint': { start: localStart },
        'web-speech': { start: webStart },
      },
    }))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '语音输入' }))
      await Promise.resolve()
    })
    expect(callbacks).toBeDefined()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '语音输入' }))
      await Promise.resolve()
    })

    expect(webStart).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('本地转写服务中断')
  })

  it('shows a readable local endpoint startup failure', async () => {
    updatePrefs({ transcriptionProvider: 'local-endpoint' })
    const provider: AsrProvider = {
      start: () => Promise.reject({
        code: 'endpoint-invalid',
        message: '本地服务地址必须使用 localhost 或回环地址',
      }),
    }
    render(voiceSurfaces({
      inputActions: { setDraft: vi.fn(), submit: vi.fn() },
      input: { draft: '' },
      sessionId: 'local-error',
      providers: { 'local-endpoint': provider },
    }))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '语音输入' }))
      await Promise.resolve()
    })
    expect(screen.getByRole('alert').textContent).toContain('本地服务地址必须使用 localhost 或回环地址')
  })

  it('injects temporary context terms into supported Chinese recognition and model polishing', async () => {
    window.SpeechRecognitionPhrase = FakeSpeechRecognitionPhrase
    const selectedModel = encodeModelReference({ provider: 'deepseek', model: 'chat' })
    updatePrefs({
      lang: 'zh-TW',
      mixedLanguageOptimizationEnabled: true,
      modelPolishEnabled: true,
      selectedModel,
    })
    const contextTerms = [
      { text: 'DeepSeek Harness', boost: 6, source: 'session' as const },
      { text: 'Codex', boost: 4, source: 'composer' as const },
    ]
    const loadContextTerms = vi.fn(() => Promise.resolve(contextTerms))
    const polish = vi.fn(() => Promise.resolve('在 Codex 使用 DeepSeek Harness'))
    render(voiceSurfaces({
      inputActions: { setDraft: vi.fn(), submit: vi.fn() },
      input: { draft: '当前 Composer' },
      sessionId: 'session-1',
      loadContextTerms,
      polish,
    }))

    fireEvent.click(screen.getByRole('button', { name: '语音输入' }))
    const recognition = FakeRecognition.instances[0]
    expect(recognition?.startCalls).toBe(1)
    expect(recognition?.phrases).toEqual([])
    await act(async () => { await Promise.resolve() })

    expect(loadContextTerms).toHaveBeenCalledWith(
      {
        sessionId: 'session-1',
        draft: '当前 Composer',
        includeInferred: true,
        model: { provider: 'deepseek', model: 'chat' },
      },
      expect.any(AbortSignal),
    )
    expect(recognition?.phrases).toEqual([
      new FakeSpeechRecognitionPhrase('DeepSeek Harness', 6),
      new FakeSpeechRecognitionPhrase('Codex', 4),
    ])

    await act(async () => { recognition?.finishWith('在扣代克斯使用深度求索') })
    expect(polish).toHaveBeenCalledWith({
      sessionId: 'session-1',
      provider: 'deepseek',
      model: 'chat',
      transcript: '在扣代克斯使用深度求索',
      terms: contextTerms,
    }, expect.any(AbortSignal))
  })

  it('debounces background extraction and cancels an obsolete Composer key', async () => {
    updatePrefs({ mixedLanguageOptimizationEnabled: true })
    const loadContextTerms = vi.fn((_request: unknown, _signal: AbortSignal) => Promise.resolve([
      { text: '新词', boost: 4, source: 'composer' as const },
    ]))
    const view = render(voiceSurfaces({
      inputActions: { setDraft: vi.fn(), submit: vi.fn() },
      input: { draft: '旧草稿', phase: 'plain' },
      sessionId: 'session-1',
      loadContextTerms,
    }))

    act(() => { vi.advanceTimersByTime(999) })
    expect(loadContextTerms).not.toHaveBeenCalled()
    view.rerender(voiceSurfaces({
      inputActions: { setDraft: vi.fn(), submit: vi.fn() },
      input: { draft: '新草稿', phase: 'plain' },
      sessionId: 'session-1',
      loadContextTerms,
    }))
    act(() => { vi.advanceTimersByTime(1000) })
    await act(async () => { await Promise.resolve() })

    expect(loadContextTerms).toHaveBeenCalledOnce()
    expect(loadContextTerms.mock.calls[0]?.[0]).toMatchObject({ draft: '新草稿' })
    expect(loadContextTerms.mock.calls[0]?.[1].aborted).toBe(false)
  })

  it('uses an exact prefetched cache before recognition.start', async () => {
    window.SpeechRecognitionPhrase = FakeSpeechRecognitionPhrase
    updatePrefs({ mixedLanguageOptimizationEnabled: true })
    const terms = [{ text: 'DeepSeek Harness', boost: 6, source: 'session' as const }]
    const loadContextTerms = vi.fn(() => Promise.resolve(terms))
    render(voiceSurfaces({
      inputActions: { setDraft: vi.fn(), submit: vi.fn() },
      input: { draft: '当前 Composer', phase: 'plain' },
      sessionId: 'session-1',
      loadContextTerms,
    }))

    act(() => { vi.advanceTimersByTime(1000) })
    await act(async () => { await Promise.resolve() })
    expect(loadContextTerms).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: '语音输入' }))
    const recognition = FakeRecognition.instances[0]
    expect(loadContextTerms).toHaveBeenCalledTimes(2)
    expect(recognition?.phrasesAtStart).toEqual([
      new FakeSpeechRecognitionPhrase('DeepSeek Harness', 6),
    ])
  })

  it('starts recognition without waiting for an unfinished model extraction', async () => {
    window.SpeechRecognitionPhrase = FakeSpeechRecognitionPhrase
    updatePrefs({ mixedLanguageOptimizationEnabled: true })
    let resolveTerms: ((terms: readonly ContextTerm[]) => void) | undefined
    const loadContextTerms = vi.fn(() => new Promise<readonly ContextTerm[]>((resolve) => {
      resolveTerms = resolve
    }))
    render(voiceSurfaces({
      inputActions: { setDraft: vi.fn(), submit: vi.fn() },
      input: { draft: '当前 Composer', phase: 'plain' },
      sessionId: 'session-1',
      loadContextTerms,
    }))

    fireEvent.click(screen.getByRole('button', { name: '语音输入' }))
    const recognition = FakeRecognition.instances[0]
    expect(recognition?.startCalls).toBe(1)
    expect(recognition?.phrasesAtStart).toEqual([])

    await act(async () => {
      resolveTerms?.([{ text: 'DeepSeek Harness', boost: 6, source: 'session' }])
      await Promise.resolve()
    })
    expect(recognition?.phrases).toEqual([
      new FakeSpeechRecognitionPhrase('DeepSeek Harness', 6),
    ])
  })

  it('refreshes a cached phrase list after start without blocking recognition', async () => {
    window.SpeechRecognitionPhrase = FakeSpeechRecognitionPhrase
    updatePrefs({ mixedLanguageOptimizationEnabled: true })
    const oldTerms = [{ text: '旧专名', boost: 4, source: 'session' as const }]
    const newTerms = [{ text: '新专名', boost: 6, source: 'composer' as const }]
    let calls = 0
    const loadContextTerms = vi.fn(() => Promise.resolve(calls++ === 0 ? oldTerms : newTerms))
    render(voiceSurfaces({
      inputActions: { setDraft: vi.fn(), submit: vi.fn() },
      input: { draft: '当前 Composer', phase: 'plain' },
      sessionId: 'session-1',
      loadContextTerms,
    }))

    act(() => { vi.advanceTimersByTime(1000) })
    await act(async () => { await Promise.resolve() })
    fireEvent.click(screen.getByRole('button', { name: '语音输入' }))
    const recognition = FakeRecognition.instances[0]
    expect(recognition?.phrasesAtStart).toEqual([
      new FakeSpeechRecognitionPhrase('旧专名', 4),
    ])
    expect(loadContextTerms).toHaveBeenCalledTimes(2)

    await act(async () => { await Promise.resolve() })
    expect(recognition?.phrases).toEqual([
      new FakeSpeechRecognitionPhrase('新专名', 6),
    ])
  })

  it('keeps ordinary recognition when contextual phrases are unsupported', async () => {
    updatePrefs({ lang: 'zh-HK', mixedLanguageOptimizationEnabled: true })
    const loadContextTerms = vi.fn(() => Promise.resolve([
      { text: 'DeepSeek Harness', boost: 5, source: 'session' as const },
    ]))
    const setDraft = vi.fn()
    render(voiceSurfaces({
      inputActions: { setDraft, submit: vi.fn() },
      input: { draft: '' },
      sessionId: 'session-1',
      loadContextTerms,
    }))

    fireEvent.click(screen.getByRole('button', { name: '语音输入' }))
    const recognition = FakeRecognition.instances[0]
    await act(async () => { await Promise.resolve() })
    expect(recognition?.phrases).toEqual([])
    act(() => { recognition?.finishWith('普通识别') })
    expect(setDraft).toHaveBeenCalledWith('普通识别')
  })

  it('retries once without phrase bias when the recognition service rejects phrases', async () => {
    window.SpeechRecognitionPhrase = FakeSpeechRecognitionPhrase
    updatePrefs({ lang: 'zh-CN', mixedLanguageOptimizationEnabled: true })
    const loadContextTerms = vi.fn(() => Promise.resolve([
      { text: 'DeepSeek Harness', boost: 5, source: 'session' as const },
    ]))
    render(voiceSurfaces({
      inputActions: { setDraft: vi.fn(), submit: vi.fn() },
      input: { draft: '' },
      sessionId: 'session-1',
      loadContextTerms,
    }))

    fireEvent.click(screen.getByRole('button', { name: '语音输入' }))
    const first = FakeRecognition.instances[0]
    await act(async () => { await Promise.resolve() })
    expect(first?.phrases).toHaveLength(1)

    act(() => {
      first?.onerror?.({ error: 'phrases-not-supported', message: '' } as WebkitSpeechRecognitionErrorEvent)
      first?.onend?.()
    })
    const second = FakeRecognition.instances[1]
    expect(second?.startCalls).toBe(1)
    expect(second?.phrases).toEqual([])
    expect(loadContextTerms).toHaveBeenCalledOnce()
  })

  it('uses right Command on macOS', () => {
    Object.defineProperty(window.navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    })
    updatePrefs({ composerShortcutEnabled: true })
    render(voiceComposer({
      inputActions: { setDraft: vi.fn(), submit: vi.fn() },
      input: { draft: '' },
      sessionId: 'session-1',
    }))
    const composer = screen.getByRole('textbox', { name: 'Composer' })
    composer.focus()

    fireEvent.keyDown(composer, { key: 'Meta', code: 'MetaRight', metaKey: true, location: 2 })
    fireEvent.keyUp(composer, { key: 'Meta', code: 'MetaRight', location: 2 })

    expect(FakeRecognition.instances).toHaveLength(1)
    expect(FakeRecognition.instances[0]?.startCalls).toBe(1)
  })

  it('starts and explicitly stops from the right-side modifier while the Composer is focused', () => {
    updatePrefs({ composerShortcutEnabled: true, autoSendEnabled: true })
    const setDraft = vi.fn()
    const submit = vi.fn()
    render(voiceComposer({ inputActions: { setDraft, submit }, input: { draft: '' }, sessionId: 'session-1' }))
    const composer = screen.getByRole('textbox', { name: 'Composer' })
    composer.focus()

    fireEvent.keyDown(composer, { key: 'Control', code: 'ControlRight', ctrlKey: true, location: 2 })
    fireEvent.keyUp(composer, { key: 'Control', code: 'ControlRight', location: 2 })
    const recognition = FakeRecognition.instances[0]
    expect(recognition).toBeDefined()
    expect(recognition?.startCalls).toBe(1)

    act(() => { recognition?.onstart?.() })
    fireEvent.keyDown(composer, { key: 'Control', code: 'ControlRight', ctrlKey: true, location: 2 })
    fireEvent.keyUp(composer, { key: 'Control', code: 'ControlRight', location: 2 })
    expect(recognition?.stopCalls).toBe(1)

    act(() => { recognition?.finishWith('快捷键转写') })
    expect(setDraft).toHaveBeenCalledWith('快捷键转写')
    expect(submit).toHaveBeenCalledOnce()
  })

  it('ignores shortcut chords, repeats, composition, the left modifier, and focus outside Composer', () => {
    updatePrefs({ composerShortcutEnabled: true })
    const setDraft = vi.fn()
    const submit = vi.fn()
    render(<>
      {voiceComposer({ inputActions: { setDraft, submit }, input: { draft: '' }, sessionId: 'session-1' })}
      <textarea aria-label="Outside" />
    </>)
    const composer = screen.getByRole('textbox', { name: 'Composer' })
    const outside = screen.getByRole('textbox', { name: 'Outside' })
    composer.focus()

    fireEvent.keyDown(composer, { key: 'Control', code: 'ControlRight', ctrlKey: true, location: 2 })
    fireEvent.keyDown(composer, { key: 'c', code: 'KeyC', ctrlKey: true })
    fireEvent.keyUp(composer, { key: 'c', code: 'KeyC', ctrlKey: true })
    fireEvent.keyUp(composer, { key: 'Control', code: 'ControlRight', location: 2 })
    fireEvent.keyDown(composer, {
      key: 'Control', code: 'ControlRight', ctrlKey: true, location: 2, repeat: true,
    })
    fireEvent.keyUp(composer, { key: 'Control', code: 'ControlRight', location: 2 })
    fireEvent.keyDown(composer, {
      key: 'Control', code: 'ControlRight', ctrlKey: true, location: 2, isComposing: true,
    })
    fireEvent.keyUp(composer, {
      key: 'Control', code: 'ControlRight', location: 2, isComposing: true,
    })
    fireEvent.keyDown(composer, { key: 'Control', code: 'ControlLeft', ctrlKey: true, location: 1 })
    fireEvent.keyUp(composer, { key: 'Control', code: 'ControlLeft', location: 1 })
    outside.focus()
    fireEvent.keyDown(outside, { key: 'Control', code: 'ControlRight', ctrlKey: true, location: 2 })
    fireEvent.keyUp(outside, { key: 'Control', code: 'ControlRight', location: 2 })

    expect(FakeRecognition.instances).toHaveLength(0)
    expect(setDraft).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })

  it('shows live final and interim recognition without mutating the Composer draft', () => {
    const setDraft = vi.fn()
    const submit = vi.fn()
    render(voiceSurfaces({ inputActions: { setDraft, submit }, input: { draft: '' }, sessionId: 'session-1' }))

    fireEvent.click(screen.getByRole('button', { name: '语音输入' }))
    const recognition = FakeRecognition.instances[0]
    act(() => { recognition?.onstart?.() })
    act(() => { recognition?.emitResults(
      { text: '今天晚上', final: true },
      { text: '天气不错', final: false },
    ) })

    expect(document.querySelector('[data-transcription-title]')?.textContent).toBe('正在听写中')
    expect(screen.getByRole('status').textContent).toContain('今天晚上')
    expect(screen.getByRole('status').textContent).toContain('天气不错')
    expect(setDraft).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })

  it('keeps the finalizing phase when recognition results arrive after stop', () => {
    const setDraft = vi.fn()
    const submit = vi.fn()
    render(voiceSurfaces({ inputActions: { setDraft, submit }, input: { draft: '' }, sessionId: 'session-1' }))

    const button = screen.getByRole('button', { name: '语音输入' })
    fireEvent.click(button)
    const recognition = FakeRecognition.instances[0]
    act(() => { recognition?.onstart?.() })
    fireEvent.click(button)
    act(() => { recognition?.emitResults({ text: '停止后的最终结果', final: true }) })

    expect(document.querySelector('[data-transcription-title]')?.textContent).toBe('正在确认中')
    expect(screen.getByRole('status').textContent).not.toContain('正在听写中')
    expect(setDraft).not.toHaveBeenCalled()

    act(() => { recognition?.onend?.() })
    expect(setDraft).toHaveBeenCalledWith('停止后的最终结果')
    expect(submit).not.toHaveBeenCalled()
  })

  it('joins recognition segments according to the selected language', () => {
    expect(joinRecognitionSegments(['你好', '世界'], 'zh-CN')).toBe('你好世界')
    expect(joinRecognitionSegments(['hello', 'world'], 'en-US')).toBe('hello world')
  })

  it('automatically sends the raw transcript when model polishing is disabled', () => {
    updatePrefs({ autoSendEnabled: true })
    const setDraft = vi.fn()
    const submit = vi.fn()
    render(voiceSurfaces({ inputActions: { setDraft, submit }, input: { draft: '已有文字' }, sessionId: 'session-1' }))

    const button = screen.getByRole('button', { name: '语音输入' })
    fireEvent.click(button)
    const recognition = FakeRecognition.instances[0]
    act(() => { recognition?.onstart?.() })
    fireEvent.click(button)
    act(() => { recognition?.finishWith('原始转写') })

    expect(setDraft).toHaveBeenCalledWith('已有文字 原始转写')
    expect(submit).toHaveBeenCalledOnce()
    expect(setDraft.mock.invocationCallOrder[0]).toBeLessThan(submit.mock.invocationCallOrder[0] ?? 0)
    expect(screen.getByRole('status').textContent).toContain('已转写完成')
    expect(screen.getByRole('status').textContent).toContain('转写结果已直接发送')
    expect(document.querySelector('[data-transcription-final]')).toBeNull()
  })

  it('keeps a spontaneous recognition result in the Composer when automatic sending is enabled', () => {
    updatePrefs({ autoSendEnabled: true })
    const setDraft = vi.fn()
    const submit = vi.fn()
    render(voiceSurfaces({ inputActions: { setDraft, submit }, input: { draft: '' }, sessionId: 'session-1' }))

    const button = screen.getByRole('button', { name: '语音输入' })
    fireEvent.click(button)
    const recognition = FakeRecognition.instances[0]
    act(() => { recognition?.onstart?.() })
    act(() => { recognition?.finishWith('浏览器自行结束') })

    expect(setDraft).toHaveBeenCalledWith('浏览器自行结束')
    expect(submit).not.toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toContain('已转写完成')
    expect(screen.getByRole('status').textContent).toContain('转写结果已写入输入框，请检查后发送')
  })

  it('shows a provisional transcript and Composer destination while polishing', async () => {
    const selectedModel = encodeModelReference({ provider: 'deepseek', model: 'chat' })
    updatePrefs({ modelPolishEnabled: true, selectedModel })
    const setDraft = vi.fn()
    const submit = vi.fn()
    let resolvePolish: ((text: string) => void) | undefined
    const polish = vi.fn(() => new Promise<string>((resolve) => { resolvePolish = resolve }))
    render(voiceSurfaces({
      inputActions: { setDraft, submit },
      input: { draft: '前文' },
      sessionId: 'session-1',
      polish,
    }))

    fireEvent.click(screen.getByRole('button', { name: '语音输入' }))
    const recognition = FakeRecognition.instances[0]
    act(() => { recognition?.onstart?.() })
    act(() => { recognition?.finishWith('深度求索哈尼斯') })

    expect(document.querySelector('[data-transcription-title]')?.textContent).toBe('正在润色中')
    expect(screen.getByRole('status').textContent).toContain('初步识别（非最终）：')
    expect(screen.getByRole('status').textContent).toContain('深度求索哈尼斯')
    expect(screen.getByRole('status').textContent).toContain('润色后将写入输入框')
    expect(document.querySelector('[data-transcription-provisional]')).not.toBeNull()
    expect(polish).toHaveBeenCalledWith({
      sessionId: 'session-1',
      provider: 'deepseek',
      model: 'chat',
      transcript: '深度求索哈尼斯',
      terms: [],
    }, expect.any(AbortSignal))

    await act(async () => { resolvePolish?.('DeepSeek Harness') })
    expect(setDraft).toHaveBeenCalledWith('前文 DeepSeek Harness')
    expect(submit).not.toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toContain('已润色完成')
    expect(screen.getByRole('status').textContent).toContain('最终结果已写入输入框')
  })

  it('starts polishing immediately when background terms are still pending', () => {
    const selectedModel = encodeModelReference({ provider: 'deepseek', model: 'chat' })
    updatePrefs({ modelPolishEnabled: true, selectedModel })
    let resolveTerms: ((terms: readonly ContextTerm[]) => void) | undefined
    const loadContextTerms = vi.fn(() => new Promise<readonly ContextTerm[]>((resolve) => {
      resolveTerms = resolve
    }))
    const polish = vi.fn(() => Promise.resolve('即时润色'))
    render(voiceSurfaces({
      inputActions: { setDraft: vi.fn(), submit: vi.fn() },
      input: { draft: '前文', phase: 'plain' },
      sessionId: 'session-1',
      loadContextTerms,
      polish,
    }))

    fireEvent.click(screen.getByRole('button', { name: '语音输入' }))
    const recognition = FakeRecognition.instances[0]
    act(() => { recognition?.finishWith('原始转写') })

    expect(polish).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'deepseek',
      model: 'chat',
      transcript: '原始转写',
      terms: [],
    }), expect.any(AbortSignal))
    resolveTerms?.([])
  })

  it('keeps the original transcript when model polishing fails', async () => {
    updatePrefs({
      modelPolishEnabled: true,
      selectedModel: encodeModelReference({ provider: 'deepseek', model: 'chat' }),
    })
    const setDraft = vi.fn()
    const submit = vi.fn()
    const polish = vi.fn(() => Promise.reject(new Error('provider unavailable')))
    render(voiceSurfaces({
      inputActions: { setDraft, submit },
      input: { draft: '' },
      sessionId: 'session-1',
      polish,
    }))

    fireEvent.click(screen.getByRole('button', { name: '语音输入' }))
    const recognition = FakeRecognition.instances[0]
    act(() => { recognition?.onstart?.() })
    await act(async () => { recognition?.finishWith('原始转写') })

    expect(setDraft).toHaveBeenCalledWith('原始转写')
    expect(submit).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('润色未完成')
    expect(screen.getByRole('alert').textContent).toContain('原始转写已写入输入框')
  })

  it('automatically sends the polished result after model polishing succeeds', async () => {
    updatePrefs({
      autoSendEnabled: true,
      modelPolishEnabled: true,
      selectedModel: encodeModelReference({ provider: 'deepseek', model: 'chat' }),
    })
    const setDraft = vi.fn()
    const submit = vi.fn()
    let resolvePolish: ((text: string) => void) | undefined
    const polish = vi.fn(() => new Promise<string>((resolve) => { resolvePolish = resolve }))
    render(voiceSurfaces({
      inputActions: { setDraft, submit },
      input: { draft: '' },
      sessionId: 'session-1',
      polish,
    }))

    const button = screen.getByRole('button', { name: '语音输入' })
    fireEvent.click(button)
    const recognition = FakeRecognition.instances[0]
    act(() => { recognition?.onstart?.() })
    fireEvent.click(button)
    act(() => { recognition?.finishWith('原始转写') })

    expect(screen.getByRole('status').textContent).toContain('初步识别（非最终）：')
    expect(screen.getByRole('status').textContent).toContain('原始转写')
    expect(screen.getByRole('status').textContent).toContain('润色后将直接发送')
    await act(async () => { resolvePolish?.('润色结果') })

    expect(setDraft).toHaveBeenCalledWith('润色结果')
    expect(submit).toHaveBeenCalledOnce()
    expect(screen.getByRole('status').textContent).toContain('已润色完成')
    expect(screen.getByRole('status').textContent).toContain('最终结果已直接发送')
    expect(document.querySelector('[data-transcription-final]')).toBeNull()
  })

  it('keeps a spontaneous polished result in the Composer when automatic sending is enabled', async () => {
    updatePrefs({
      autoSendEnabled: true,
      modelPolishEnabled: true,
      selectedModel: encodeModelReference({ provider: 'deepseek', model: 'chat' }),
    })
    const setDraft = vi.fn()
    const submit = vi.fn()
    const polish = vi.fn(() => Promise.resolve('润色结果'))
    render(voiceSurfaces({
      inputActions: { setDraft, submit },
      input: { draft: '' },
      sessionId: 'session-1',
      polish,
    }))

    fireEvent.click(screen.getByRole('button', { name: '语音输入' }))
    const recognition = FakeRecognition.instances[0]
    act(() => { recognition?.onstart?.() })
    await act(async () => { recognition?.finishWith('浏览器自行结束') })

    expect(setDraft).toHaveBeenCalledWith('润色结果')
    expect(submit).not.toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toContain('已润色完成')
    expect(screen.getByRole('status').textContent).toContain('最终结果已写入输入框')
  })

  it('automatically sends the original transcript when model polishing fails', async () => {
    updatePrefs({
      autoSendEnabled: true,
      modelPolishEnabled: true,
      selectedModel: encodeModelReference({ provider: 'deepseek', model: 'chat' }),
    })
    const setDraft = vi.fn()
    const submit = vi.fn()
    const polish = vi.fn(() => Promise.reject(new Error('provider unavailable')))
    render(voiceSurfaces({
      inputActions: { setDraft, submit },
      input: { draft: '' },
      sessionId: 'session-1',
      polish,
    }))

    const button = screen.getByRole('button', { name: '语音输入' })
    fireEvent.click(button)
    const recognition = FakeRecognition.instances[0]
    act(() => { recognition?.onstart?.() })
    fireEvent.click(button)
    await act(async () => { recognition?.finishWith('原始转写') })

    expect(setDraft).toHaveBeenCalledWith('原始转写')
    expect(submit).toHaveBeenCalledOnce()
    expect(screen.getByRole('alert').textContent).toContain('润色未完成')
    expect(screen.getByRole('alert').textContent).toContain('原始转写已直接发送')
    expect(document.querySelector('[data-transcription-final]')).toBeNull()
  })
})
