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
  finalCalls: number
  inputCharacters: number
  reused: 'none' | 'completed' | 'in-flight'
}

/** One recording owns one scheduler; cancellation invalidates every outstanding result. */
export class ProgressivePolish {
  readonly metrics: ProgressivePolishMetrics = {
    backgroundCalls: 0, finalCalls: 0, inputCharacters: 0, reused: 'none',
  }
  private raw = ''
  private interim = ''
  private timer: ReturnType<typeof setTimeout> | undefined
  private lastStarted = -Infinity
  private lastAttempt = ''
  private cancelled = false
  private finishing = false
  private completed: { raw: string; text: string } | undefined
  private pending: { raw: string; controller: AbortController; promise: Promise<string> } | undefined

  constructor(private readonly options: ProgressivePolishOptions) {}

  /** A complete recognition snapshot, never an append-only rendering patch. */
  update(raw: string, interim: string): void {
    if (this.cancelled || this.finishing) return
    const changed = this.raw !== raw || this.interim !== interim
    this.raw = raw
    this.interim = interim
    this.render()
    if (!changed) return
    this.clearTimer()
    if (raw.length < 8 || raw === this.lastAttempt) return
    const wait = Math.max(this.options.pauseMs ?? 900,
      this.lastStarted + (this.options.intervalMs ?? 4000) - Date.now())
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (this.cancelled || this.finishing || this.pending !== undefined) return
      if (this.metrics.backgroundCalls >= (this.options.maxBackgroundCalls ?? 12)
        || this.metrics.inputCharacters + this.raw.length > (this.options.maxBackgroundCharacters ?? 48_000)) return
      this.metrics.backgroundCalls += 1
      void this.request(this.raw).then(() => {}, () => {}).finally(() => {
        // A newer snapshot waits for another quiet interval, rather than piling up requests.
        if (!this.cancelled && !this.finishing && this.raw !== this.lastAttempt) {
          const raw = this.raw
          this.raw = ''
          this.update(raw, this.interim)
        }
      })
    }, wait)
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
    this.pending?.controller.abort()
    this.pending = undefined
    this.metrics.finalCalls += 1
    return this.request(raw)
  }

  cancel(): void {
    this.cancelled = true
    this.clearTimer()
    this.pending?.controller.abort()
    this.pending = undefined
    this.completed = undefined
  }

  private render(): void {
    const completed = this.completed
    const stable = completed !== undefined && this.raw.startsWith(completed.raw)
      ? this.options.join([completed.text, this.raw.slice(completed.raw.length)])
      : this.raw
    this.options.preview(this.options.join([stable, this.interim]))
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private request(raw: string): Promise<string> {
    const controller = new AbortController()
    this.lastStarted = Date.now()
    this.lastAttempt = raw
    this.metrics.inputCharacters += raw.length
    let operation: Promise<string>
    try { operation = this.options.polish(raw, controller.signal) } catch (error) { operation = Promise.reject(error) }
    const promise = operation.then(text => {
      if (this.cancelled || controller.signal.aborted) throw new Error('dictation cancelled')
      if (text.trim() === '') throw new Error('empty polish result')
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
