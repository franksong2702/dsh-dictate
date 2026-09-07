// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountComposerPreview } from '../src/client/composerPreview.ts'

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks() })

describe('Composer preview geometry', () => {
  it.each(['div', 'textarea'])('keeps the %s preview within a fractional-width scroll container on mount and resize', kind => {
    const scroll = document.createElement('div')
    scroll.style.overflow = 'auto'
    const grow = document.createElement('div')
    const target = document.createElement(kind)
    grow.append(target)
    scroll.append(grow)
    document.body.append(scroll)
    Object.defineProperty(target, 'offsetWidth', { value: 790 })
    Object.defineProperty(target, 'offsetHeight', { value: 28 })
    const bounds = vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ width: 789.59375, height: 28 } as DOMRect)
    const preview = mountComposerPreview(target, { draft: '', start: 0, end: 0 }, vi.fn(), vi.fn(), vi.fn())!
    preview.update('短文字')
    const view = document.querySelector<HTMLElement>('[data-dictate-composer-preview]')!
    expect(Number.parseFloat(view.style.width)).toBeLessThanOrEqual(789.59375)
    expect(view.style.width).toBe('789.59375px')
    bounds.mockReturnValue({ width: 319.59375, height: 28 } as DOMRect)
    window.dispatchEvent(new Event('resize'))
    expect(Number.parseFloat(view.style.width)).toBeLessThanOrEqual(319.59375)
    expect(view.style.width).toBe('319.59375px')
    preview.dispose()
  })
})
