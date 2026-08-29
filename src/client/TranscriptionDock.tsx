import {
  useCallback,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import {
  getTranscriptionSnapshot,
  subscribeTranscription,
  type TranscriptionSnapshot,
} from './transcriptionStore.ts'

/** Props for the live transcription timeline associated with one session. */
export interface TranscriptionDockProps {
  readonly sessionId: string
}

/** Keep the completed result readable briefly, then retract it into the Composer. */
export const TRANSCRIPTION_COMPLETE_VISIBLE_MS = 4_000

function phaseTitle(snapshot: TranscriptionSnapshot): string {
  switch (snapshot.phase) {
    case 'preparing': return '等待授权中'
    case 'listening': return snapshot.status.includes('录音') ? '正在录音中' : '正在听写中'
    case 'finalizing':
      if (snapshot.status.includes('转写')) return '正在转写中'
      return '正在确认中'
    case 'polishing': return '正在润色中'
    case 'complete':
      if (snapshot.status === '已加入词典' || snapshot.status === '本次已忽略') return snapshot.status
      return snapshot.status.includes('润色') ? '已润色完成' : '已转写完成'
    case 'dictionary': return '发现新词汇'
    case 'error': return snapshot.status.includes('润色') ? '润色未完成' : '转写未完成'
    case 'idle': return ''
    default: {
      const exhaustive: never = snapshot.phase
      return exhaustive
    }
  }
}

/** Format elapsed recording time without making it look like a wall-clock timestamp. */
export function formatRecordingDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000))
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

function durationCopy(snapshot: TranscriptionSnapshot): string {
  if (snapshot.phase !== 'listening' || snapshot.recordingElapsedMs === null) return ''
  return `已持续 ${formatRecordingDuration(snapshot.recordingElapsedMs)}`
}

function phaseIndicatorColor(snapshot: TranscriptionSnapshot): string {
  if (snapshot.phase === 'listening' || snapshot.phase === 'error') {
    return 'var(--dsw-alias-state-error-primary, #ee4651)'
  }
  if (snapshot.phase === 'complete') {
    return 'var(--dsw-alias-state-success-primary, #249b68)'
  }
  if (snapshot.phase === 'dictionary') {
    return 'var(--dsw-alias-state-business-secondary, #7559d6)'
  }
  return 'var(--dsw-alias-state-business-primary, #356df3)'
}

function transcriptPreview(snapshot: TranscriptionSnapshot): ReactNode {
  if (snapshot.finalText === '' && snapshot.interimText === '') return null
  const label = snapshot.phase === 'listening' || snapshot.phase === 'preparing'
    ? '实时识别（非最终）：'
    : '初步转写（非最终）：'
  return (
    <div
      aria-label={label.slice(0, -1)}
      data-transcription-preview
      style={{
        display: 'flex',
        minWidth: 0,
        gap: 6,
        borderTop: '1px solid var(--dsw-alias-border-l2)',
        padding: '7px 12px 8px',
        fontSize: 12,
        lineHeight: 1.5,
      }}
    >
      <span style={{ flex: 'none', color: 'var(--dsw-alias-label-tertiary)' }}>{label}</span>
      <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
        {snapshot.finalText !== '' ? (
          <span data-transcription-provisional>{snapshot.finalText}</span>
        ) : null}
        {snapshot.finalText !== '' && snapshot.interimText !== '' ? ' ' : null}
        {snapshot.interimText !== '' ? (
          <span data-transcription-interim style={{ color: 'var(--dsw-alias-label-tertiary)' }}>
            {snapshot.interimText}
          </span>
        ) : null}
      </span>
    </div>
  )
}

/** Render one session's voice-status timeline above the host Composer without reflowing it. */
export function TranscriptionDock({ sessionId }: TranscriptionDockProps): ReactNode {
  const subscribe = useCallback(
    (listener: () => void) => subscribeTranscription(sessionId, listener),
    [sessionId],
  )
  const getSnapshot = useCallback(() => getTranscriptionSnapshot(sessionId), [sessionId])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const scrollRef = useRef<HTMLDivElement>(null)
  const followLatestRef = useRef(true)

  useEffect(() => {
    followLatestRef.current = true
    const scroll = scrollRef.current
    if (scroll !== null) scroll.scrollTop = scroll.scrollHeight
  }, [sessionId])

  useEffect(() => {
    const scroll = scrollRef.current
    if (scroll !== null && followLatestRef.current) scroll.scrollTop = scroll.scrollHeight
  }, [
    snapshot.finalText,
    snapshot.hint,
    snapshot.interimText,
    snapshot.phase,
    snapshot.status,
  ])

  if (snapshot.phase === 'idle') return null

  const title = phaseTitle(snapshot)
  const duration = durationCopy(snapshot)
  const role = snapshot.phase === 'error' ? 'alert' : 'status'
  const announcement = snapshot.announcement !== ''
    ? snapshot.announcement
    : [title, duration, snapshot.hint].filter(Boolean).join('。')
  const preview = transcriptPreview(snapshot)
  const isSettled = snapshot.phase === 'complete'

  return (
    <div
      data-transcription-viewport
      data-transcription-overlay
      style={{
        position: 'absolute',
        right: 12,
        bottom: 8,
        left: 12,
        height: 180,
        width: 'auto',
        maxWidth: 'calc(var(--dsh-composer-card-max-width) - 24px)',
        margin: '0 auto',
        clipPath: 'inset(-32px -32px 0 -32px)',
        pointerEvents: 'none',
      }}
    >
      <div
        className={`dsh-dictate-timeline dsh-dictate-phase-${snapshot.phase}${isSettled ? ' dsh-dictate-timeline-settled' : ''}`}
        data-testid="transcription-dock"
        data-transcription-dock
        onScroll={(event) => {
          const scroll = event.currentTarget
          followLatestRef.current = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 24
        }}
        ref={scrollRef}
        tabIndex={0}
        style={{
          boxSizing: 'border-box',
          position: 'absolute',
          zIndex: 40,
          right: 0,
          bottom: 0,
          left: 0,
          display: 'flex',
          flexDirection: 'column',
          width: 'auto',
          maxHeight: '100%',
          overflowX: 'hidden',
          overflowY: 'auto',
          overscrollBehavior: 'contain',
          color: 'var(--dsw-alias-label-primary)',
          pointerEvents: isSettled ? 'none' : 'auto',
          scrollbarColor: 'var(--dsw-alias-scrollbar-bg-l2) transparent',
          scrollbarWidth: 'thin',
          touchAction: 'pan-y',
        }}
      >
        <style>{`
          @keyframes dsh-dictate-event-in {
            from { opacity: 0; transform: translateY(4px); }
            to { opacity: 1; transform: translateY(0); }
          }
          @keyframes dsh-dictate-settled-out {
            0%, 88% { transform: translateY(0); }
            100% { transform: translateY(calc(100% + 8px)); }
          }
          @keyframes dsh-dictate-dictionary-in {
            from { transform: translateY(calc(100% + 8px)); }
            to { transform: translateY(0); }
          }
          @keyframes dsh-dictate-indicator-breathe {
            0%, 100% { opacity: .2; transform: scale(1); }
            50% { opacity: 0; transform: scale(2.35); }
          }
          @keyframes dsh-dictate-indicator-confirm {
            0% { transform: scale(.72); }
            55% { transform: scale(1.14); }
            100% { transform: scale(1); }
          }
          @keyframes dsh-dictate-indicator-confirm-ring {
            0% { opacity: .28; transform: scale(1); }
            100% { opacity: 0; transform: scale(2.5); }
          }
          .dsh-dictate-timeline { animation: dsh-dictate-event-in 180ms ease-out; }
          .dsh-dictate-timeline-settled {
            animation: dsh-dictate-settled-out ${TRANSCRIPTION_COMPLETE_VISIBLE_MS}ms cubic-bezier(.2, .8, .2, 1) forwards;
          }
          .dsh-dictate-phase-dictionary {
            animation: dsh-dictate-dictionary-in 220ms cubic-bezier(.2, .8, .2, 1) both;
          }
          .dsh-dictate-status-indicator {
            position: relative;
            flex: none;
            align-self: center;
            width: 9px;
            height: 9px;
            border-radius: 999px;
            background: currentColor;
          }
          .dsh-dictate-status-indicator::after {
            content: '';
            position: absolute;
            inset: 0;
            border-radius: inherit;
            background: currentColor;
            opacity: 0;
          }
          .dsh-dictate-phase-preparing .dsh-dictate-status-indicator::after,
          .dsh-dictate-phase-listening .dsh-dictate-status-indicator::after,
          .dsh-dictate-phase-finalizing .dsh-dictate-status-indicator::after,
          .dsh-dictate-phase-polishing .dsh-dictate-status-indicator::after {
            animation: dsh-dictate-indicator-breathe 1600ms ease-in-out infinite;
          }
          .dsh-dictate-phase-complete .dsh-dictate-status-indicator {
            animation: dsh-dictate-indicator-confirm 440ms cubic-bezier(.2, .8, .2, 1) 1;
          }
          .dsh-dictate-phase-complete .dsh-dictate-status-indicator::after {
            animation: dsh-dictate-indicator-confirm-ring 440ms ease-out 1;
          }
          @media (prefers-reduced-motion: reduce) {
            .dsh-dictate-timeline,
            .dsh-dictate-timeline-settled,
            .dsh-dictate-phase-dictionary,
            .dsh-dictate-status-indicator,
            .dsh-dictate-status-indicator::after { animation: none; }
          }
        `}</style>

        <div
          data-transcription-current-card
          style={{
            position: 'sticky',
            zIndex: 2,
            bottom: 0,
            flex: 'none',
            width: '100%',
            marginTop: 0,
            overflow: 'hidden',
            border: '1px solid var(--dsw-alias-border-l2)',
            borderRadius: 8,
            backgroundColor: 'var(--dsw-alias-bg-layer-2)',
            boxShadow: '0 7px 22px rgb(0 0 0 / 9%)',
          }}
        >
          <div
            aria-atomic="true"
            aria-label={announcement || title || '语音输入状态'}
            aria-live={snapshot.phase === 'error' ? 'assertive' : 'polite'}
            data-transcription-current
            role={role}
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 8,
              minWidth: 0,
              padding: '8px 12px',
              fontSize: 13,
              lineHeight: 1.5,
            }}
          >
            <span
              aria-hidden="true"
              className="dsh-dictate-status-indicator"
              data-transcription-indicator
              style={{ color: phaseIndicatorColor(snapshot) }}
            />
            <strong
              aria-hidden="true"
              data-transcription-title
              style={{ flex: 'none', fontWeight: 600 }}
            >
              {title}
            </strong>
            <span
              aria-hidden="true"
              data-transcription-auxiliary
              style={{ display: 'inline-flex', minWidth: 0, flexWrap: 'wrap', gap: 6 }}
            >
              {duration !== '' ? (
                <span
                  data-recording-duration
                  style={{ color: 'var(--dsw-alias-label-tertiary)', fontVariantNumeric: 'tabular-nums' }}
                >
                  {duration}
                </span>
              ) : null}
              {duration !== '' && snapshot.hint !== '' ? (
                <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>·</span>
              ) : null}
              {snapshot.hint !== '' ? (
                <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>{snapshot.hint}</span>
              ) : null}
            </span>
          </div>

          {preview}

          {snapshot.action !== null || snapshot.secondaryAction !== null ? (
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '0 12px 8px' }}>
              {snapshot.secondaryAction !== null ? (
                <button
                  type="button"
                  onClick={snapshot.secondaryAction.run}
                  style={{ pointerEvents: 'auto' }}
                >
                  {snapshot.secondaryAction.label}
                </button>
              ) : null}
              {snapshot.action !== null ? (
                <button
                  type="button"
                  onClick={snapshot.action.run}
                  style={{ pointerEvents: 'auto' }}
                >
                  {snapshot.action.label}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
