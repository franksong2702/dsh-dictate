// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsPanel } from '../src/client/SettingsPanel.tsx'
import { apply, VoiceInputButton } from '../src/client/index.tsx'
import { loadPrefs, updatePrefs } from '../src/client/prefs.ts'

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

  finishWith(text: string): void {
    const result = Object.assign([{ transcript: text }], { isFinal: true })
    this.onresult?.({ resultIndex: 0, results: [result] } as unknown as WebkitSpeechRecognitionEvent)
    this.onend?.()
  }
}

describe('Voice Input browser plugin', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeRecognition.instances = []
    Object.defineProperty(window, 'localStorage', { configurable: true, value: new MemoryStorage() })
    window.SpeechRecognition = FakeRecognition
    updatePrefs({ lang: 'zh-CN' })
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
      'settings.plugin.item',
    ])
    expect(register.mock.calls[1]?.[0]).toMatchObject({
      name: 'settings.plugin.item',
      id: 'voice-input',
    })
  })

  it('uses host theme tokens without a fixed dark fallback', () => {
    render(<SettingsPanel />)
    fireEvent.click(screen.getByRole('button', { name: '展开：语音输入' }))
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
    expect(window.localStorage.getItem('dsh-voice-input.prefs.v1')).toBe('{"lang":"ja-JP"}')

    first.unmount()
    render(<SettingsPanel />)
    fireEvent.click(screen.getByRole('button', { name: '展开：语音输入' }))
    expect((screen.getByLabelText('识别语言') as HTMLSelectElement).value).toBe('ja-JP')
  })

  it('starts on the first click, stops on the second, and clears completion after three seconds', () => {
    updatePrefs({ lang: 'zh-HK' })
    const setDraft = vi.fn()
    render(<VoiceInputButton inputActions={{ setDraft }} input={{ draft: '' }} />)

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
    expect(screen.getByRole('status').textContent).toBe('语音已转入输入框，请检查后发送')

    act(() => { vi.advanceTimersByTime(2999) })
    expect(screen.queryByRole('status')).not.toBeNull()
    act(() => { vi.advanceTimersByTime(1) })
    expect(screen.queryByRole('status')).toBeNull()
  })
})
