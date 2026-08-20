// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TranscriptionDock } from '../src/client/TranscriptionDock.tsx'
import {
  EMPTY_TRANSCRIPTION,
  getTranscriptionSnapshot,
  resetTranscription,
  subscribeTranscription,
  updateTranscription,
} from '../src/client/transcriptionStore.ts'

afterEach(() => {
  cleanup()
  resetTranscription('dock-a')
  resetTranscription('dock-b')
  resetTranscription('dock-stable')
  resetTranscription('dock-render')
})

describe('transcription store', () => {
  it('keeps session updates and subscribers isolated', () => {
    const listenerA = vi.fn()
    const listenerB = vi.fn()
    const unsubscribeA = subscribeTranscription('dock-a', listenerA)
    const unsubscribeB = subscribeTranscription('dock-b', listenerB)

    updateTranscription('dock-a', { phase: 'listening', finalText: '甲' })

    expect(listenerA).toHaveBeenCalledOnce()
    expect(listenerB).not.toHaveBeenCalled()
    expect(getTranscriptionSnapshot('dock-a').finalText).toBe('甲')
    expect(getTranscriptionSnapshot('dock-b')).toBe(EMPTY_TRANSCRIPTION)

    updateTranscription('dock-b', { phase: 'finalizing', interimText: '乙' })
    expect(listenerA).toHaveBeenCalledOnce()
    expect(listenerB).toHaveBeenCalledOnce()
    expect(getTranscriptionSnapshot('dock-b').interimText).toBe('乙')

    unsubscribeA()
    unsubscribeB()
  })

  it('returns a stable object until a session changes', () => {
    const initial = getTranscriptionSnapshot('dock-stable')
    expect(initial).toBe(EMPTY_TRANSCRIPTION)
    expect(getTranscriptionSnapshot('dock-stable')).toBe(initial)

    updateTranscription('dock-stable', { phase: 'complete', finalText: '完成', status: '转写完成' })
    const completed = getTranscriptionSnapshot('dock-stable')
    expect(completed).not.toBe(initial)
    expect(getTranscriptionSnapshot('dock-stable')).toBe(completed)

    resetTranscription('dock-stable')
    expect(getTranscriptionSnapshot('dock-stable')).toBe(EMPTY_TRANSCRIPTION)
  })
})

describe('TranscriptionDock', () => {
  it('does not render while the session is idle', () => {
    render(<TranscriptionDock sessionId="dock-render" />)
    expect(screen.queryByTestId('transcription-dock')).toBeNull()
    expect(document.querySelector('[data-transcription-dock]')).toBeNull()
  })

  it('shows final text and a subdued interim transcript while listening', () => {
    updateTranscription('dock-render', {
      phase: 'listening',
      finalText: '已经确认',
      interimText: '还在识别',
    })

    render(<TranscriptionDock sessionId="dock-render" />)
    expect(screen.getByRole('status')).not.toBeNull()
    expect(screen.getByText('正在听写中')).not.toBeNull()
    expect(screen.getByText('已经确认')).not.toBeNull()
    const interim = screen.getByText('还在识别')
    expect(interim.getAttribute('style')).toContain('var(--dsw-alias-label-tertiary)')
  })

  it.each([
    ['preparing', '等待授权中', '请按浏览器提示允许麦克风访问…', '等待授权中'],
    ['listening', '正在录音中', '再次点击麦克风结束并转写', '正在录音中'],
    ['listening', '正在听写中', '请开始说话…', '正在听写中'],
    ['finalizing', '正在转写中', '录音已结束，正在准备音频…', '正在转写中'],
    ['finalizing', '正在转写中', '本地服务正在识别语音，请稍候…', '正在转写中'],
    ['finalizing', '正在确认中', '正在确认识别结果，请稍候…', '正在确认中'],
  ] as const)('shows a fixed five-character title and auxiliary copy for %s / %s', (
    phase,
    status,
    hint,
    expectedTitle,
  ) => {
    updateTranscription('dock-render', { phase, status, hint, finalText: '', interimText: '' })

    render(<TranscriptionDock sessionId="dock-render" />)
    const title = document.querySelector('[data-transcription-title]')
    const auxiliary = document.querySelector('[data-transcription-auxiliary]')
    expect(title?.textContent).toBe(expectedTitle)
    expect(Array.from(title?.textContent ?? '')).toHaveLength(5)
    expect(auxiliary?.textContent?.trim()).not.toBe('')
    const preview = screen.getByText(hint)
    expect(preview.getAttribute('style')).toContain('var(--dsw-alias-label-tertiary)')
  })

  it('uses the host Composer width and centers on the same horizontal axis', () => {
    updateTranscription('dock-render', { phase: 'listening' })

    render(<TranscriptionDock sessionId="dock-render" />)
    const dock = screen.getByTestId('transcription-dock')
    expect(dock.style.boxSizing).toBe('border-box')
    expect(dock.style.flex).toBe('0 0 auto')
    expect(dock.style.width).toBe(
      'calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance))',
    )
    expect(dock.style.maxWidth).toBe('var(--dsh-composer-card-max-width)')
    expect(dock.style.margin).toBe('0px auto 8px')
  })

  it('marks the polishing transcript as provisional and explains its destination', () => {
    updateTranscription('dock-render', {
      phase: 'polishing',
      status: '正在润色中',
      finalText: '初步转写',
      hint: '润色后将写入输入框',
    })

    render(<TranscriptionDock sessionId="dock-render" />)
    expect(screen.getByText('正在润色中')).not.toBeNull()
    const label = screen.getByText('初步识别（非最终）：')
    const destination = screen.getByText('· 润色后将写入输入框')
    expect(label.getAttribute('style')).toContain('var(--dsw-alias-label-tertiary)')
    expect(destination.getAttribute('style')).toContain('var(--dsw-alias-label-tertiary)')
    expect(document.querySelector('[data-transcription-provisional]')?.textContent).toBe('初步转写')
    expect(document.querySelector('[data-transcription-final]')).toBeNull()
  })

  it.each([
    ['complete', '已转写完成', '结果已写入输入框', 'status'],
    ['complete', '已润色完成', '最终结果已写入输入框', 'status'],
    ['error', '转写未完成', '没有识别到语音，请重试', 'alert'],
    ['error', '润色未完成', '原始转写已写入输入框', 'alert'],
  ] as const)('renders %s with a fixed title, auxiliary copy, and ARIA role', (
    phase,
    title,
    hint,
    role,
  ) => {
    updateTranscription('dock-render', { phase, status: title, hint, finalText: '' })

    render(<TranscriptionDock sessionId="dock-render" />)
    expect(screen.getByRole(role, { name: title })).not.toBeNull()
    expect(screen.getByText(title)).not.toBeNull()
    expect(Array.from(title)).toHaveLength(5)
    expect(screen.getByText(hint)).not.toBeNull()
  })
})
