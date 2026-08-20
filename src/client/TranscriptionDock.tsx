import { useCallback, useSyncExternalStore, type ReactNode } from 'react'
import {
  getTranscriptionSnapshot,
  subscribeTranscription,
  type TranscriptionSnapshot,
} from './transcriptionStore.ts'

/** Props for the live transcription preview associated with one session. */
export interface TranscriptionDockProps {
  readonly sessionId: string
}

function phaseTitle(snapshot: TranscriptionSnapshot): string {
  switch (snapshot.phase) {
    case 'preparing': return '等待授权中'
    case 'listening': return snapshot.status.includes('录音') ? '正在录音中' : '正在听写中'
    case 'finalizing':
      if (snapshot.status.includes('转写')) return '正在转写中'
      return '正在确认中'
    case 'polishing': return '正在润色中'
    case 'complete': return snapshot.status.includes('润色') ? '已润色完成' : '已转写完成'
    case 'error': return snapshot.status.includes('润色') ? '润色未完成' : '转写未完成'
    case 'idle':
      return ''
    default: {
      const exhaustive: never = snapshot.phase
      return exhaustive
    }
  }
}

function textPreview(snapshot: TranscriptionSnapshot): ReactNode {
  if (snapshot.phase === 'polishing') {
    return (
      <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6 }}>
        <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>初步识别（非最终）：</span>
        {snapshot.finalText !== '' ? (
          <span data-transcription-provisional>{snapshot.finalText}</span>
        ) : null}
        {snapshot.hint !== '' ? (
          <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>· {snapshot.hint}</span>
        ) : null}
      </span>
    )
  }
  if (snapshot.phase === 'preparing' || snapshot.phase === 'listening' || snapshot.phase === 'finalizing') {
    if (snapshot.finalText === '' && snapshot.interimText === '') {
      if (snapshot.hint === '') return null
      return <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>{snapshot.hint}</span>
    }
    return (
      <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6 }}>
        {snapshot.finalText !== '' ? <span data-transcription-final>{snapshot.finalText}</span> : null}
        {snapshot.interimText !== '' ? (
          <span data-transcription-interim style={{ color: 'var(--dsw-alias-label-tertiary)' }}>
            {snapshot.interimText}
          </span>
        ) : null}
      </span>
    )
  }
  if (snapshot.finalText !== '') return <span data-transcription-final>{snapshot.finalText}</span>
  if (snapshot.hint === '') return null
  return <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>{snapshot.hint}</span>
}

/** Render one session's live transcript above the host composer. */
export function TranscriptionDock({ sessionId }: TranscriptionDockProps): ReactNode {
  const subscribe = useCallback(
    (listener: () => void) => subscribeTranscription(sessionId, listener),
    [sessionId],
  )
  const getSnapshot = useCallback(() => getTranscriptionSnapshot(sessionId), [sessionId])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  if (snapshot.phase === 'idle') return null

  const title = phaseTitle(snapshot)
  const role = snapshot.phase === 'error' ? 'alert' : 'status'
  return (
    <div
      aria-label={title || '实时听写状态'}
      data-transcription-dock
      data-testid="transcription-dock"
      role={role}
      style={{
        boxSizing: 'border-box',
        display: 'flex',
        flex: 'none',
        alignItems: 'baseline',
        gap: 8,
        width: 'calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance))',
        maxWidth: 'var(--dsh-composer-card-max-width)',
        margin: '0 auto 8px',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 8,
        padding: '8px 12px',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        lineHeight: 1.5,
      }}
    >
      <strong data-transcription-title style={{ flex: 'none', fontWeight: 600 }}>{title}</strong>
      <span data-transcription-auxiliary style={{ minWidth: 0 }}>{textPreview(snapshot)}</span>
      {snapshot.action !== null ? (
        <button
          type="button"
          onClick={snapshot.action.run}
          style={{ marginLeft: 'auto', flex: 'none' }}
        >
          {snapshot.action.label}
        </button>
      ) : null}
    </div>
  )
}
