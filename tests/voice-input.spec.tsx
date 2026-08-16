// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps, ComponentType, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsPanel } from '../src/client/SettingsPanel.tsx'
import { TranscriptionDock } from '../src/client/TranscriptionDock.tsx'
import { apply, encodeModelReference, joinRecognitionSegments, VoiceInputButton } from '../src/client/index.tsx'
import { loadPrefs, normalizePrefs, updatePrefs } from '../src/client/prefs.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutline14: () => <svg data-testid="native-chevron" />,
}))

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
  onstart: (() => void) | null = null
  onresult: ((event: WebkitSpeechRecognitionEvent) => void) | null = null
  onerror: ((event: WebkitSpeechRecognitionErrorEvent) => void) | null = null
  onend: (() => void) | null = null
  startCalls = 0
  stopCalls = 0
  abortCalls = 0

  constructor() {
    super()
    FakeRecognition.instances.push(this)
  }

  start(): void { this.startCalls += 1 }
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

function voiceSurfaces(props: ComponentProps<typeof VoiceInputButton>): ReactNode {
  return <>
    <VoiceInputButton {...props} />
    <TranscriptionDock sessionId={props.sessionId} />
  </>
}

describe('Voice Input browser plugin', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeRecognition.instances = []
    Object.defineProperty(window, 'localStorage', { configurable: true, value: new MemoryStorage() })
    window.SpeechRecognition = FakeRecognition
    updatePrefs({ lang: 'zh-CN', modelPolishEnabled: false, selectedModel: '', autoSendEnabled: false })
  })

  afterEach(() => {
    cleanup()
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    window.SpeechRecognition = undefined
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
      id: 'voice-input',
    })
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
    fireEvent.click(screen.getByRole('button', { name: '展开：语音输入' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '启用模型润色' }))

    expect(screen.getByLabelText('润色模型')).not.toBeNull()
    expect(screen.getByRole('option', { name: 'DeepSeek Chat · DeepSeek' })).not.toBeNull()
    expect(models).toHaveBeenCalledOnce()
  })

  it('uses host theme tokens without a fixed dark fallback', () => {
    render(<SettingsPanel />)
    const disclosure = screen.getByRole('button', { name: '展开：语音输入' })
    expect(disclosure.querySelector('svg')).not.toBeNull()
    expect(disclosure.textContent).not.toContain('▾')
    fireEvent.click(disclosure)
    const select = screen.getByLabelText('识别语言') as HTMLSelectElement

    expect(select.style.background).toBe('var(--dsw-alias-bg-layer-3)')
    expect(select.style.color).toBe('var(--dsw-alias-label-primary)')
    expect(select.getAttribute('style')).not.toContain('#202124')
  })

  it('persists a language selected on the settings page', () => {
    const first = render(<SettingsPanel />)
    fireEvent.click(screen.getByRole('button', { name: '展开：语音输入' }))
    fireEvent.change(screen.getByLabelText('识别语言'), { target: { value: 'ja-JP' } })
    expect(loadPrefs().lang).toBe('ja-JP')
    expect(window.localStorage.getItem('dsh-voice-input.prefs.v1')).toBe(
      '{"lang":"ja-JP","modelPolishEnabled":false,"selectedModel":"","autoSendEnabled":false}',
    )

    first.unmount()
    render(<SettingsPanel />)
    fireEvent.click(screen.getByRole('button', { name: '展开：语音输入' }))
    expect((screen.getByLabelText('识别语言') as HTMLSelectElement).value).toBe('ja-JP')
  })

  it('normalizes legacy language-only preferences and new model fields', () => {
    expect(normalizePrefs({ lang: 'ja-JP' })).toEqual({
      lang: 'ja-JP',
      modelPolishEnabled: false,
      selectedModel: '',
      autoSendEnabled: false,
    })
    expect(normalizePrefs({ lang: 'en-US', modelPolishEnabled: true, selectedModel: 'deepseek-chat' })).toEqual({
      lang: 'en-US',
      modelPolishEnabled: true,
      selectedModel: 'deepseek-chat',
      autoSendEnabled: false,
    })
  })

  it('toggles model polishing and persists a selected model', () => {
    render(<SettingsPanel modelOptions={[
      { value: 'deepseek-chat', label: 'DeepSeek Chat' },
      { value: 'deepseek-reasoner', label: 'DeepSeek Reasoner' },
    ]} />)
    fireEvent.click(screen.getByRole('button', { name: '展开：语音输入' }))

    expect(screen.getByText('录音转写完成后，把原始转写和最近的会话文本发送给所选模型提供商进行润色，再填入输入框。是否自动发送由“自动发送转写结果”控制；润色失败时使用原始转写。')).not.toBeNull()
    expect((screen.getByRole('checkbox', { name: '启用模型润色' }) as HTMLInputElement).checked).toBe(false)
    expect(screen.queryByLabelText('润色模型')).toBeNull()

    fireEvent.click(screen.getByRole('checkbox', { name: '启用模型润色' }))
    expect(loadPrefs().modelPolishEnabled).toBe(true)
    fireEvent.change(screen.getByLabelText('润色模型'), { target: { value: 'deepseek-reasoner' } })

    expect(loadPrefs().selectedModel).toBe('deepseek-reasoner')
    expect(window.localStorage.getItem('dsh-voice-input.prefs.v1')).toBe(
      '{"lang":"zh-CN","modelPolishEnabled":true,"selectedModel":"deepseek-reasoner","autoSendEnabled":false}',
    )
  })

  it('keeps automatic sending off by default and persists explicit opt-in', () => {
    render(<SettingsPanel />)
    fireEvent.click(screen.getByRole('button', { name: '展开：语音输入' }))

    const toggle = screen.getByRole('checkbox', { name: '自动发送转写结果' }) as HTMLInputElement
    expect(toggle.checked).toBe(false)
    expect(screen.getByText('用户点击结束录音后，自动发送输入框中的全部文字。浏览器自行结束识别时只填入输入框，不自动发送。启用模型润色时会等待润色完成；润色失败时仍会发送原始转写。')).not.toBeNull()

    fireEvent.click(toggle)
    expect(loadPrefs().autoSendEnabled).toBe(true)
    expect(window.localStorage.getItem('dsh-voice-input.prefs.v1')).toBe(
      '{"lang":"zh-CN","modelPolishEnabled":false,"selectedModel":"","autoSendEnabled":true}',
    )
  })

  it('reports that polishing models are unavailable when the host list is empty', () => {
    render(<SettingsPanel />)
    fireEvent.click(screen.getByRole('button', { name: '展开：语音输入' }))
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
    expect(screen.getByRole('status').textContent).toContain('语音已转入输入框，请检查后发送')
    expect(document.querySelector('[data-transcription-final]')).toBeNull()

    act(() => { vi.advanceTimersByTime(2999) })
    expect(screen.queryByRole('status')).not.toBeNull()
    act(() => { vi.advanceTimersByTime(1) })
    expect(screen.queryByRole('status')).toBeNull()
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

    expect(screen.getByRole('status').textContent).toContain('正在听写')
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

    expect(screen.getByRole('status').textContent).toContain('正在确认文字')
    expect(screen.getByRole('status').textContent).not.toContain('正在听写')
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
    expect(screen.getByRole('status').textContent).toContain('转写结果已交给 DSH 发送')
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
    expect(screen.getByRole('status').textContent).toContain('语音已转入输入框，请检查后发送')
  })

  it('shows only 模型润色中 while a selected model is polishing', async () => {
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

    expect(screen.getByRole('status').textContent).toContain('模型润色中')
    expect(polish).toHaveBeenCalledWith({
      sessionId: 'session-1',
      provider: 'deepseek',
      model: 'chat',
      transcript: '深度求索哈尼斯',
    }, expect.any(AbortSignal))

    await act(async () => { resolvePolish?.('DeepSeek Harness') })
    expect(setDraft).toHaveBeenCalledWith('前文 DeepSeek Harness')
    expect(submit).not.toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toContain('语音已转入输入框，请检查后发送')
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
    expect(screen.getByRole('alert').textContent).toContain('模型润色失败，已保留原始转写')
  })

  it('automatically sends the polished result after model polishing succeeds', async () => {
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

    const button = screen.getByRole('button', { name: '语音输入' })
    fireEvent.click(button)
    const recognition = FakeRecognition.instances[0]
    act(() => { recognition?.onstart?.() })
    fireEvent.click(button)
    await act(async () => { recognition?.finishWith('原始转写') })

    expect(setDraft).toHaveBeenCalledWith('润色结果')
    expect(submit).toHaveBeenCalledOnce()
    expect(screen.getByRole('status').textContent).toContain('润色结果已交给 DSH 发送')
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
    expect(screen.getByRole('status').textContent).toContain('语音已转入输入框，请检查后发送')
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
    expect(screen.getByRole('alert').textContent).toContain('模型润色失败，原始转写已交给 DSH 发送')
    expect(document.querySelector('[data-transcription-final]')).toBeNull()
  })
})
