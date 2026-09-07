/** Temporary editable projection inside the host textbox footprint; no host draft writes. */
export interface PreviewInsertion {
  readonly draft: string
  readonly start: number
  readonly end: number
}

export interface ComposerPreview {
  update(text: string): void
  dispose(): void
}

/**
 * The public DSH slot does not expose the Lexical editor or transient ranges.
 * Keep its persisted draft untouched and restore its resident textbox on exit.
 */
export function mountComposerPreview(
  target: HTMLElement,
  insertion: PreviewInsertion,
  onEdit: (text: string) => void,
  onCancel: () => void,
  onEditStart: () => void,
): ComposerPreview | undefined {
  const parent = target.parentElement
  if (parent === null) return undefined
  const view = document.createElement('div')
  view.dataset.dictateComposerPreview = ''
  view.setAttribute('contenteditable', 'plaintext-only')
  view.setAttribute('role', 'textbox')
  view.setAttribute('aria-label', '语音输入中的 Composer')
  view.setAttribute('aria-multiline', 'true')
  view.setAttribute('aria-busy', 'true')
  view.spellcheck = false
  const computed = getComputedStyle(target)
  Object.assign(view.style, {
    position: 'absolute', zIndex: '2', boxSizing: 'border-box',
    font: computed.font, lineHeight: computed.lineHeight,
    letterSpacing: computed.letterSpacing, color: computed.color,
    padding: computed.padding, border: computed.border,
    borderRadius: computed.borderRadius,
    whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', overflowY: 'auto', outline: 'none',
  })
  const previousOpacity = target.style.opacity
  const previousPointerEvents = target.style.pointerEvents
  const previousAriaHidden = target.getAttribute('aria-hidden')
  const previousTabindex = target.getAttribute('tabindex')
  const previousParentPosition = parent.style.position
  const previousHeight = target.style.height
  const placeholder = parent.querySelector<HTMLElement>('[data-composer-placeholder]')
  const previousPlaceholderVisibility = placeholder?.style.visibility
  if (placeholder !== null) placeholder.style.visibility = 'hidden'
  if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative'
  // Opacity (not display:none) preserves native pointer capture for a held mouse.
  target.style.opacity = '0'
  target.style.pointerEvents = 'none'
  target.setAttribute('aria-hidden', 'true')
  target.tabIndex = -1
  parent.append(view)
  let disposed = false
  let text = ''
  let adjustedHeight: string | undefined
  const layout = (): void => {
    if (disposed) return
    view.style.left = `${target.offsetLeft}px`
    view.style.top = `${target.offsetTop}px`
    view.style.width = `${target.offsetWidth}px`
    const maxHeight = Number.parseFloat(computed.maxHeight)
    const desired = Math.min(Math.max(target.offsetHeight, view.scrollHeight),
      Number.isFinite(maxHeight) ? maxHeight : 320)
    if (desired > target.offsetHeight) {
      adjustedHeight = `${desired}px`
      target.style.height = adjustedHeight
    }
    view.style.height = `${Math.max(desired, target.offsetHeight)}px`
  }
  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(layout)
  observer?.observe(target)
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    observer?.disconnect()
    window.removeEventListener('resize', layout)
    target.removeEventListener('beforeinput', cancelFromNative)
    target.removeEventListener('compositionstart', cancelFromNative)
    target.removeEventListener('keydown', nativeKey, true)
    const focused = document.activeElement === view
    view.remove()
    target.style.opacity = previousOpacity
    target.style.pointerEvents = previousPointerEvents
    if (placeholder !== null) placeholder.style.visibility = previousPlaceholderVisibility ?? ''
    if (adjustedHeight !== undefined && target.style.height === adjustedHeight) target.style.height = previousHeight
    if (previousAriaHidden === null) target.removeAttribute('aria-hidden')
    else target.setAttribute('aria-hidden', previousAriaHidden)
    if (previousTabindex === null) target.removeAttribute('tabindex')
    else target.setAttribute('tabindex', previousTabindex)
    if (parent.style.position === 'relative' && previousParentPosition !== 'relative') parent.style.position = previousParentPosition
    if (focused) target.focus()
  }
  const cancelFromNative = (): void => { onCancel() }
  const nativeKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel() }
    if (event.key === 'Enter') {
      if (!event.isComposing) event.preventDefault()
      event.stopPropagation()
    }
  }
  // If focus remains on the resident textbox during a mouse hold, native typing cancels first.
  target.addEventListener('beforeinput', cancelFromNative)
  target.addEventListener('compositionstart', cancelFromNative)
  target.addEventListener('keydown', nativeKey, true)
  view.addEventListener('keydown', nativeKey)
  let composing = false
  let editing = false
  const beginEdit = (): void => {
    if (editing) return
    editing = true
    onEditStart()
  }
  view.addEventListener('beforeinput', event => { beginEdit(); event.stopPropagation() })
  const edited = (): void => {
    if (composing) return
    const selection = window.getSelection()
    let caret: number | undefined
    if (selection?.rangeCount && view.contains(selection.anchorNode)) {
      const before = document.createRange()
      before.selectNodeContents(view)
      before.setEnd(selection.anchorNode!, selection.anchorOffset)
      caret = before.toString().length
    }
    onEdit(view.innerText ?? view.textContent ?? '')
    // React/Lexical applies setDraft after the input event. Continue typing at the
    // edited position instead of jumping to the beginning of the restored editor.
    if (caret !== undefined && typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(() => {
      if (!target.isConnected || document.activeElement !== target) return
      if (target instanceof HTMLTextAreaElement) {
        target.setSelectionRange(caret, caret)
        return
      }
      const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT)
      let remaining = caret
      let node = walker.nextNode()
      while (node !== null) {
        const length = node.textContent?.length ?? 0
        if (remaining <= length) {
          const range = document.createRange()
          range.setStart(node, remaining)
          range.collapse(true)
          selection?.removeAllRanges()
          selection?.addRange(range)
          return
        }
        remaining -= length
        node = walker.nextNode()
      }
    })
  }
  view.addEventListener('compositionstart', event => {
    event.stopPropagation(); composing = true; beginEdit()
  })
  view.addEventListener('compositionend', event => {
    event.stopPropagation(); composing = false; edited()
  })
  view.addEventListener('input', event => { event.stopPropagation(); edited() })
  window.addEventListener('resize', layout)
  return {
    update(next: string): void {
      if (disposed || editing || text === next && view.childNodes.length > 0) return
      text = next
      const provisional = document.createElement('span')
      provisional.dataset.dictateProvisional = ''
      provisional.style.textDecoration = 'underline dashed'
      provisional.style.textUnderlineOffset = '4px'
      provisional.textContent = text
      const focused = document.activeElement === view
      view.replaceChildren(document.createTextNode(insertion.draft.slice(0, insertion.start)),
        provisional, document.createTextNode(insertion.draft.slice(insertion.end)))
      if (focused) {
        const selection = window.getSelection()
        const range = document.createRange()
        range.selectNodeContents(provisional)
        range.collapse(false)
        selection?.removeAllRanges()
        selection?.addRange(range)
      }
      layout()
    },
    dispose,
  }
}
