/** Speculative full-transcript polishing. Raw recognition is always authoritative. */
export interface ProgressivePolishOptions {
  readonly polish: (raw: string, signal: AbortSignal) => Promise<string>
  readonly preview: (text: string) => void
  readonly join: (parts: readonly string[]) => string
  readonly pauseMs?: number
  readonly intervalMs?: number
  readonly maxBackgroundCalls?: number
  readonly maxBackgroundCharacters?: number
}

export interface ProgressivePolishMetrics {
  backgroundCalls: number
  stopCalls: number
  finalCalls: number
  inputCharacters: number
  /** Abort signals sent for superseded, finished, or cancelled speculative work. */
  abortSignals: number
  lastRequestMs: number | null
  reused: 'none' | 'completed' | 'in-flight'
}

/** One recording owns one scheduler; cancellation invalidates every outstanding result. */
export class ProgressivePolish {
  readonly metrics: ProgressivePolishMetrics = {
    backgroundCalls: 0, stopCalls: 0, finalCalls: 0, inputCharacters: 0, lastRequestMs: null, reused: 'none',
    abortSignals: 0,
  }
  private raw = ''
  private interim = ''
  private timer: ReturnType<typeof setTimeout> | undefined
  private lastStarted = -Infinity
  private lastAttempt = ''
  private cancelled = false
  private finishing = false
  private stopping = false
  private completed: { raw: string; text: string } | undefined
  private pending: { raw: string; controller: AbortController; promise: Promise<string> } | undefined

  constructor(private readonly options: ProgressivePolishOptions) {}

  /** A complete recognition snapshot, never an append-only rendering patch. */
  update(raw: string, interim: string): void {
    if (this.cancelled || this.finishing) return
    const previous = this.snapshot()
    this.raw = raw
    this.interim = interim
    this.render()
    if (previous === this.snapshot()) return
    this.clearTimer()
    this.schedule()
  }

  /** Overlap recognition shutdown with one speculative pass of the latest words. */
  prepareToStop(): void {
    if (this.cancelled || this.finishing || this.stopping) return
    this.stopping = true
    this.clearTimer()
    this.startSpeculative(true)
  }

  private snapshot(): string {
    return this.options.join([this.raw, this.interim]).trim()
  }

  private schedule(): void {
    if (this.cancelled || this.finishing || this.stopping) return
    const snapshot = this.snapshot()
    if (snapshot.length < 8 || snapshot === this.lastAttempt) return
    const wait = Math.max(this.options.pauseMs ?? 900,
      this.lastStarted + (this.options.intervalMs ?? 4000) - Date.now())
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.startSpeculative(false)
    }, wait)
  }

  private startSpeculative(atStop: boolean): void {
    const snapshot = this.snapshot()
    if (this.cancelled || this.finishing || snapshot === ''
      || this.completed?.raw === snapshot || this.pending?.raw === snapshot) return
    if (!atStop && this.pending !== undefined) return
    if (this.metrics.backgroundCalls >= (this.options.maxBackgroundCalls ?? 12)
      || this.metrics.inputCharacters + snapshot.length > (this.options.maxBackgroundCharacters ?? 48_000)) return
    if (atStop) {
      this.abortPending()
      this.pending = undefined
      this.metrics.stopCalls += 1
    }
    this.metrics.backgroundCalls += 1
    void this.request(snapshot).then(() => {}, () => {}).finally(() => {
      // Never queue one model request per recognition event.
      if (this.pending === undefined && this.timer === undefined) this.schedule()
    })
  }

  /** Reuse only an exact full-raw match; later corrections force a fresh whole-text pass. */
  async finish(raw: string): Promise<string> {
    if (this.cancelled) throw new Error('dictation cancelled')
    this.finishing = true
    this.raw = raw
    this.interim = ''
    this.clearTimer()
    if (this.completed?.raw === raw) {
      this.metrics.reused = 'completed'
      return this.completed.text
    }
    if (this.pending?.raw === raw) {
      this.metrics.reused = 'in-flight'
      try { return await this.pending.promise } catch {
        if (this.cancelled) throw new Error('dictation cancelled')
        // Retry a failed speculative request once through the ordinary final path.
      }
    }
    this.abortPending()
    this.pending = undefined
    this.metrics.finalCalls += 1
    return this.request(raw)
  }

  cancel(): void {
    this.cancelled = true
    this.clearTimer()
    this.abortPending()
    this.pending = undefined
    this.completed = undefined
  }

  private render(): void {
    const completed = this.completed
    const snapshot = this.snapshot()
    const preview = completed !== undefined && snapshot.startsWith(completed.raw)
      ? this.options.join([completed.text, snapshot.slice(completed.raw.length)])
      : snapshot
    this.options.preview(preview)
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Signal the RPC chain, rather than merely ignoring a stale browser result. */
  private abortPending(): void {
    if (this.pending !== undefined && !this.pending.controller.signal.aborted) {
      this.pending.controller.abort()
      this.metrics.abortSignals += 1
    }
  }

  private request(raw: string): Promise<string> {
    const controller = new AbortController()
    this.lastStarted = Date.now()
    const started = this.lastStarted
    this.lastAttempt = raw
    this.metrics.inputCharacters += raw.length
    let operation: Promise<string>
    try { operation = this.options.polish(raw, controller.signal) } catch (error) { operation = Promise.reject(error) }
    const promise = operation.then(text => {
      if (this.cancelled || controller.signal.aborted) throw new Error('dictation cancelled')
      if (text.trim() === '') throw new Error('empty polish result')
      this.metrics.lastRequestMs = Date.now() - started
      this.completed = { raw, text }
      if (!this.finishing) this.render()
      return text
    }).finally(() => {
      if (this.pending?.controller === controller) this.pending = undefined
    })
    this.pending = { raw, controller, promise }
    return promise
  }
}
