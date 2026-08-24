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
  type TranscriptionTimelineEvent,
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
    case 'complete': return snapshot.status.includes('润色') ? '已润色完成' : '已转写完成'
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

function eventColor(event: TranscriptionTimelineEvent): string {
  if (event.tone === 'error') return 'var(--dsw-alias-state-error-primary)'
  if (event.tone === 'warning') return 'var(--dsw-alias-state-warn-label)'
  return 'var(--dsw-alias-label-secondary)'
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
    snapshot.history,
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
  const renderedHistory = snapshot.history.filter((event, index) => {
    const isLatest = index === snapshot.history.length - 1
    const repeatsCurrent = event.phase === snapshot.phase
      && event.label === snapshot.status
      && event.detail === snapshot.hint
    return !isLatest || !repeatsCurrent
  })
  const hasHistory = renderedHistory.length > 0
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
        className={isSettled ? 'dsh-dictate-timeline dsh-dictate-timeline-settled' : 'dsh-dictate-timeline'}
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
          border: '1px solid var(--dsw-alias-border-l2)',
          borderRadius: 8,
          backgroundColor: 'var(--dsw-alias-bg-layer-2)',
          background: 'color-mix(in srgb, var(--dsw-alias-bg-layer-2) 82%, transparent)',
          backdropFilter: 'blur(18px) saturate(1.12)',
          WebkitBackdropFilter: 'blur(18px) saturate(1.12)',
          boxShadow: '0 8px 24px rgb(0 0 0 / 10%)',
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
          .dsh-dictate-timeline { animation: dsh-dictate-event-in 180ms ease-out; }
          .dsh-dictate-timeline-settled {
            animation: dsh-dictate-settled-out ${TRANSCRIPTION_COMPLETE_VISIBLE_MS}ms cubic-bezier(.2, .8, .2, 1) forwards;
          }
          .dsh-dictate-timeline-event { animation: dsh-dictate-event-in 180ms ease-out; }
          @media (prefers-reduced-motion: reduce) {
            .dsh-dictate-timeline,
            .dsh-dictate-timeline-settled,
            .dsh-dictate-timeline-event { animation: none; }
          }
        `}</style>

        {hasHistory ? (
          <div
            aria-label="本次语音输入记录"
            data-transcription-history
            style={{
              display: 'flex',
              flex: 'none',
              flexDirection: 'column',
              gap: 4,
              padding: '8px 12px 7px',
              borderBottom: '1px solid var(--dsw-alias-border-l2)',
              fontSize: 12,
              lineHeight: 1.35,
            }}
          >
            {renderedHistory.map(event => (
              <div
                className="dsh-dictate-timeline-event"
                data-event-id={event.id}
                data-transcription-event
                key={event.id}
                style={{
                  display: 'block',
                  alignItems: 'baseline',
                  color: eventColor(event),
                }}
              >
                <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                  <strong style={{ fontWeight: 550 }}>{event.label}</strong>
                  {event.detail !== '' ? (
                    <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}> · {event.detail}</span>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        ) : null}

        <div
          aria-atomic="true"
          aria-label={announcement || title || '语音输入状态'}
          aria-live={snapshot.phase === 'error' ? 'assertive' : 'polite'}
          data-transcription-current
          role={role}
          style={{
            position: 'sticky',
            zIndex: 1,
            top: 0,
            display: 'flex',
            flex: 'none',
            alignItems: 'baseline',
            gap: 8,
            minWidth: 0,
            padding: '8px 12px',
            backgroundColor: 'var(--dsw-alias-bg-layer-2)',
            background: 'color-mix(in srgb, var(--dsw-alias-bg-layer-2) 90%, transparent)',
            backdropFilter: 'blur(18px) saturate(1.12)',
            WebkitBackdropFilter: 'blur(18px) saturate(1.12)',
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
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

        {snapshot.action !== null ? (
          <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '0 12px 8px' }}>
            <button
              type="button"
              onClick={snapshot.action.run}
              style={{ pointerEvents: 'auto' }}
            >
              {snapshot.action.label}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
