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
    case 'preparing': return snapshot.status || '正在准备录音'
    case 'listening': return snapshot.status || '正在听写'
    case 'finalizing': return snapshot.status || '正在确认文字'
    case 'polishing': return '模型润色中'
    case 'complete':
    case 'error':
      return snapshot.status
    case 'idle':
      return ''
    default: {
      const exhaustive: never = snapshot.phase
      return exhaustive
    }
  }
}

function textPreview(snapshot: TranscriptionSnapshot): ReactNode {
  if (snapshot.phase === 'preparing' || snapshot.phase === 'listening' || snapshot.phase === 'finalizing') {
    if (snapshot.finalText === '' && snapshot.interimText === '') {
      return snapshot.phase === 'preparing'
        ? null
        : <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>请开始说话…</span>
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
  if (snapshot.finalText === '') return null
  return <span data-transcription-final>{snapshot.finalText}</span>
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
      <strong style={{ flex: 'none', fontWeight: 600 }}>{title}</strong>
      <span style={{ minWidth: 0 }}>{textPreview(snapshot)}</span>
    </div>
  )
}
