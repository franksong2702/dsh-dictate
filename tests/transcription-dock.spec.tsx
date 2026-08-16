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
    expect(screen.getByText('正在听写')).not.toBeNull()
    expect(screen.getByText('已经确认')).not.toBeNull()
    const interim = screen.getByText('还在识别')
    expect(interim.getAttribute('style')).toContain('var(--dsw-alias-label-tertiary)')
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

  it.each([
    ['polishing', '模型润色中', 'status'],
    ['complete', '转写完成', 'status'],
    ['error', '转写失败', 'alert'],
  ] as const)('renders %s with its exact title, preview, and ARIA role', (phase, title, role) => {
    updateTranscription('dock-render', { phase, status: title, finalText: '预览原文' })

    render(<TranscriptionDock sessionId="dock-render" />)
    expect(screen.getByRole(role, { name: title })).not.toBeNull()
    expect(screen.getByText(title)).not.toBeNull()
    expect(screen.getByText('预览原文')).not.toBeNull()
  })
})
