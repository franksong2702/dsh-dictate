import type { ReactNode } from 'react'
import type { ContextTerm } from '../terms.ts'
import type { AsrTermsStatus } from './asrProvider.ts'

export interface VocabularyView {
  readonly sessionId: string
  readonly terms: readonly ContextTerm[]
  readonly pending: boolean
  readonly failed: boolean
  readonly recognition: AsrTermsStatus | 'unchecked'
}

/** User-visible vocabulary, never a diagnostic log or a persisted global dictionary. */
export function VocabularyDetails({ view, polishEnabled, local }: {
  readonly view: VocabularyView
  readonly polishEnabled: boolean
  readonly local: boolean
}): ReactNode {
  const recognition = local ? '本地识别暂不接收动态关键词提示。'
    : view.recognition === 'submitted' ? '最近一次识别：关键词已传给浏览器，不保证识别服务会采纳。'
      : view.recognition === 'unsupported' ? '浏览器未提供关键词提示接口。'
        : view.recognition === 'rejected' ? '浏览器拒绝了关键词提示，继续普通识别。'
          : view.recognition === 'empty' ? '最近一次识别尚未收到关键词。' : '开始录音后检查浏览器是否接受关键词。'
  return <details data-dictate-vocabulary style={{ position: 'relative', fontSize: 12 }}
    onKeyDown={event => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      event.currentTarget.open = false
      event.currentTarget.querySelector('summary')?.focus()
    }}>
    <summary aria-label="当前关键词" title="查看当前会话关键词及识别提示状态"
      style={{ cursor: 'pointer', padding: '4px 6px', borderRadius: 6 }}>词</summary>
    <div role="region" aria-label="当前会话关键词"
      style={{ position: 'absolute', right: 0, bottom: 'calc(100% + 8px)', zIndex: 60,
        width: 300, maxWidth: 'calc(100vw - 48px)', maxHeight: 260, overflowY: 'auto',
        boxSizing: 'border-box', padding: 12, borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2, #ddd)',
        background: 'var(--dsw-alias-surface-l1, #fff)', color: 'var(--dsw-alias-label-primary, #222)',
        boxShadow: '0 4px 18px #0002', lineHeight: 1.6 }}>
      <strong>当前关键词 · {view.terms.length}</strong>
      <p style={{ margin: '6px 0' }}>{view.pending ? '已有词先使用，正在补充关键词。'
        : view.failed ? '关键词刷新失败，暂时保留已准备的词。' : '优先使用草稿和近期词，也保留本会话较早的术语。'}</p>
      <p style={{ margin: '6px 0' }}>{recognition}</p>
      <p style={{ margin: '6px 0' }}>{polishEnabled ? '这些词也会提供给润色模型参考。' : '模型润色未开启。'}</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
        {view.terms.map(term => <span key={term.text.toLocaleLowerCase('en-US')}
          title={term.source === 'composer' ? '来自当前草稿' : '来自本会话'}
          style={{ padding: '1px 5px', border: '1px solid var(--dsw-alias-border-l2, #ddd)', borderRadius: 4, overflowWrap: 'anywhere' }}>{term.text}</span>)}
        {view.terms.length === 0 ? <span>暂无关键词</span> : null}
      </div>
    </div>
  </details>
}
