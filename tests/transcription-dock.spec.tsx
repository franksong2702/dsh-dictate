// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatRecordingDuration, TranscriptionDock } from '../src/client/TranscriptionDock.tsx'
import {
  EMPTY_TRANSCRIPTION,
  getTranscriptionSnapshot,
  resetTranscription,
  subscribeTranscription,
  type TranscriptionTimelineEvent,
  updateTranscription,
  upsertTranscriptionEvent,
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

  it('keeps timeline events isolated, capped, and updates an id in place', () => {
    const listenerA = vi.fn()
    const listenerB = vi.fn()
    const unsubscribeA = subscribeTranscription('dock-a', listenerA)
    const unsubscribeB = subscribeTranscription('dock-b', listenerB)
    const makeEvent = (id: string, detail = id): TranscriptionTimelineEvent => ({
      id,
      elapsedMs: Number(id.replace('event-', '')) * 1000,
      phase: 'listening',
      label: '正在录音中',
      detail,
      tone: 'warning',
    })

    for (let index = 0; index < 13; index += 1) {
      upsertTranscriptionEvent('dock-a', makeEvent(`event-${index}`))
    }
    const beforeUpdate = getTranscriptionSnapshot('dock-a')
    expect(beforeUpdate.history).toHaveLength(12)
    expect(beforeUpdate.history[0]?.id).toBe('event-1')
    expect(beforeUpdate.history[4]?.id).toBe('event-5')

    const updated = upsertTranscriptionEvent('dock-a', makeEvent('event-5', '已持续 05:00'))
    expect(updated.history).toHaveLength(12)
    expect(updated.history[4]).toEqual(expect.objectContaining({
      id: 'event-5',
      detail: '已持续 05:00',
    }))
    expect(updated.history.map((event) => event.id)).toEqual(beforeUpdate.history.map((event) => event.id))
    expect(listenerA).toHaveBeenCalledTimes(14)
    expect(listenerB).not.toHaveBeenCalled()

    upsertTranscriptionEvent('dock-b', makeEvent('event-b'))
    expect(getTranscriptionSnapshot('dock-b').history).toHaveLength(1)
    expect(getTranscriptionSnapshot('dock-a').history).toBe(updated.history)
    expect(listenerA).toHaveBeenCalledTimes(14)
    expect(listenerB).toHaveBeenCalledOnce()

    unsubscribeA()
    unsubscribeB()
  })

  it('does not notify or replace the snapshot when an event is unchanged', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeTranscription('dock-stable', listener)
    const event: TranscriptionTimelineEvent = {
      id: 'recording-started',
      elapsedMs: 0,
      phase: 'listening',
      label: '正在录音中',
      detail: '已持续 00:00',
      tone: 'warning',
    }

    const first = upsertTranscriptionEvent('dock-stable', event)
    const second = upsertTranscriptionEvent('dock-stable', { ...event })

    expect(second).toBe(first)
    expect(listener).toHaveBeenCalledOnce()
    unsubscribe()
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
    ['finalizing', '正在转写中', '正在处理录音，请稍候…', '正在转写中'],
    ['finalizing', '正在转写中', '正在生成转写结果，请稍候…', '正在转写中'],
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

  it('anchors an opaque clipped viewport above the Composer without taking layout space', () => {
    updateTranscription('dock-render', { phase: 'listening' })

    render(<TranscriptionDock sessionId="dock-render" />)
    const viewport = document.querySelector('[data-transcription-viewport]') as HTMLElement
    const dock = screen.getByTestId('transcription-dock')
    expect(viewport.style.position).toBe('absolute')
    expect(viewport.style.left).toBe('12px')
    expect(viewport.style.right).toBe('12px')
    expect(viewport.style.bottom).toBe('8px')
    expect(viewport.style.height).toBe('180px')
    expect(viewport.style.clipPath).toBe('inset(-32px -32px 0 -32px)')
    expect(viewport.style.pointerEvents).toBe('none')
    expect(dock.style.boxSizing).toBe('border-box')
    expect(dock.style.position).toBe('absolute')
    expect(dock.style.maxHeight).toBe('100%')
    expect(dock.style.overflowY).toBe('auto')
    expect(dock.style.zIndex).toBe('40')
    expect(Number(dock.style.zIndex)).toBeLessThan(100)
    expect(dock.style.pointerEvents).toBe('auto')
    expect(dock.style.backgroundColor).toBe('var(--dsw-alias-bg-layer-2)')
    expect(dock.getAttribute('style')).not.toContain('color-mix')
    expect(dock.getAttribute('style')).not.toContain('backdrop-filter')
    const current = document.querySelector('[data-transcription-current]') as HTMLElement
    expect(current.style.backgroundColor).toBe('var(--dsw-alias-bg-layer-2)')
    expect(current.getAttribute('style')).not.toContain('color-mix')
    expect(current.getAttribute('style')).not.toContain('backdrop-filter')
  })

  it('slides the completed timeline down without fading it', () => {
    updateTranscription('dock-render', {
      phase: 'complete',
      status: '已润色完成',
      hint: '最终结果已写入输入框',
    })

    render(<TranscriptionDock sessionId="dock-render" />)
    const dock = screen.getByTestId('transcription-dock')
    const css = document.querySelector('style')?.textContent ?? ''
    expect(dock.className).toContain('dsh-dictate-timeline-settled')
    expect(dock.style.pointerEvents).toBe('none')
    expect(css).toContain('translateY(calc(100% + 8px))')
    expect(css).toContain('4000ms')
    expect(css).not.toContain('100% { opacity: 0; }')
  })

  it('marks the polishing transcript as provisional and explains its destination', () => {
    updateTranscription('dock-render', {
      phase: 'polishing',
      status: '正在润色中',
      finalText: '初步转写',
      hint: '初步转写不是最终结果；完成后将写入输入框',
    })

    render(<TranscriptionDock sessionId="dock-render" />)
    expect(screen.getByText('正在润色中')).not.toBeNull()
    const label = screen.getByText('初步转写（非最终）：')
    const destination = screen.getByText('初步转写不是最终结果；完成后将写入输入框')
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
    expect(screen.getByRole(role, { name: new RegExp(title) })).not.toBeNull()
    expect(screen.getByText(title)).not.toBeNull()
    expect(Array.from(title)).toHaveLength(5)
    expect(screen.getByText(hint)).not.toBeNull()
  })

  it('does not repeat the current terminal state in the history list', () => {
    updateTranscription('dock-render', {
      phase: 'error',
      status: '转写未完成',
      hint: '麦克风权限被拒绝，请重试',
      announcement: '转写未完成。麦克风权限被拒绝，请重试',
    })
    upsertTranscriptionEvent('dock-render', {
      id: 'recording-stop',
      elapsedMs: 8_000,
      phase: 'finalizing',
      label: '录音已结束',
      detail: '录音时长 00:08 · 用户主动结束',
      tone: 'complete',
    })
    upsertTranscriptionEvent('dock-render', {
      id: 'error',
      elapsedMs: 8_000,
      phase: 'error',
      label: '转写未完成',
      detail: '麦克风权限被拒绝，请重试',
      tone: 'error',
    })

    render(<TranscriptionDock sessionId="dock-render" />)
    expect(screen.getByRole('alert', { name: /转写未完成/ })).not.toBeNull()
    expect(document.querySelectorAll('[data-event-id="error"]')).toHaveLength(0)
    expect(document.querySelectorAll('[data-event-id="recording-stop"]')).toHaveLength(1)
    expect(screen.getAllByText('转写未完成')).toHaveLength(1)
  })

  it('shows elapsed time only while recording and leaves the stopped duration in history', () => {
    updateTranscription('dock-render', {
      phase: 'listening',
      status: '正在录音中',
      hint: '再次点击麦克风结束并转写',
      recordingElapsedMs: 138_000,
    })
    const view = render(<TranscriptionDock sessionId="dock-render" />)

    const duration = document.querySelector('[data-recording-duration]')
    expect(duration?.textContent).toBe('已持续 02:18')
    expect(duration?.getAttribute('style')).toContain('var(--dsw-alias-label-tertiary)')
    expect(document.querySelector('[data-transcription-auxiliary]')?.textContent).not.toContain('已录音')

    updateTranscription('dock-render', {
      phase: 'finalizing',
      status: '正在转写中',
      hint: '正在处理最后一段录音…',
    })
    upsertTranscriptionEvent('dock-render', {
      id: 'recording-stop',
      elapsedMs: 138_000,
      phase: 'finalizing',
      label: '录音已结束',
      detail: '录音时长 02:18 · 用户主动结束',
      tone: 'complete',
    })
    view.rerender(<TranscriptionDock sessionId="dock-render" />)
    expect(document.querySelector('[data-recording-duration]')).toBeNull()
    expect(document.querySelector('[data-event-id="recording-stop"]')?.textContent).toContain(
      '录音时长 02:18 · 用户主动结束',
    )
  })

  it('renders natural history copy without generic recording timestamps', () => {
    updateTranscription('dock-render', {
      phase: 'finalizing',
      status: '正在转写中',
      hint: '正在处理最后一段录音…',
      recordingElapsedMs: 540_000,
    })
    upsertTranscriptionEvent('dock-render', {
      id: 'recording-stop',
      elapsedMs: 540_000,
      phase: 'finalizing',
      label: '录音已结束',
      detail: '录音时长 09:00 · 已达到时长上限',
      tone: 'complete',
    })

    render(<TranscriptionDock sessionId="dock-render" />)
    expect(document.querySelector('[data-transcription-event-time]')).toBeNull()
    expect(document.querySelector('[data-event-id="recording-stop"]')?.textContent).toBe(
      '录音已结束 · 录音时长 09:00 · 已达到时长上限',
    )
    expect(document.querySelector('[data-transcription-current]')?.textContent).toContain('正在转写中')
    expect(document.querySelector('[data-recording-duration]')).toBeNull()
    expect(formatRecordingDuration(540_999)).toBe('09:00')
  })

  it('makes the whole timeline keyboard-scrollable, follows new text, and respects manual scrollback', () => {
    updateTranscription('dock-render', {
      phase: 'listening',
      status: '正在听写中',
      interimText: '第一段较长的实时识别内容',
    })
    for (let index = 0; index < 6; index += 1) {
      upsertTranscriptionEvent('dock-render', {
        id: `event-${index}`,
        elapsedMs: index * 1_000,
        phase: 'listening',
        label: `阶段 ${index}`,
        detail: '',
        tone: 'complete',
      })
    }

    render(<TranscriptionDock sessionId="dock-render" />)
    const dock = screen.getByTestId('transcription-dock')
    const history = document.querySelector('[data-transcription-history]')
    Object.defineProperties(dock, {
      clientHeight: { configurable: true, value: 180 },
      scrollHeight: { configurable: true, value: 600 },
      scrollTop: { configurable: true, value: 420, writable: true },
    })
    expect(dock.getAttribute('tabindex')).toBe('0')
    expect(history?.getAttribute('tabindex')).toBeNull()
    expect(dock.style.overscrollBehavior).toBe('contain')

    fireEvent.scroll(dock)
    act(() => {
      updateTranscription('dock-render', { interimText: '第二段最新识别内容' })
    })
    expect(dock.scrollTop).toBe(600)

    dock.scrollTop = 120
    fireEvent.scroll(dock)
    act(() => {
      updateTranscription('dock-render', { interimText: '用户回看时到达的新内容' })
    })
    expect(dock.scrollTop).toBe(120)
    expect(document.querySelector('style')?.textContent).toContain('prefers-reduced-motion: reduce')
  })
})
