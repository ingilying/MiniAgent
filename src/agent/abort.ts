/** Returned by `AbortGate.guard` when the signal won the race. */
export const ABORTED = Symbol('aborted')

/**
 * Makes reads lose to aborts on purpose: a consumer that breaks out (or an
 * aborted signal) must settle the run at once instead of hanging on a
 * stream that never ends. Call `dispose()` when the run is over.
 */
export class AbortGate {
  private flagged: boolean
  private readonly tripped: Promise<typeof ABORTED>
  private readonly onAbort: () => void

  constructor(private readonly signal: AbortSignal | undefined) {
    this.flagged = signal?.aborted === true
    let trip!: () => void
    this.tripped = new Promise((resolve) => {
      trip = () => resolve(ABORTED)
    })
    this.onAbort = () => {
      this.flagged = true
      trip()
    }
    signal?.addEventListener('abort', this.onAbort, { once: true })
  }

  /** Whether the signal has fired. */
  get aborted(): boolean {
    return this.flagged
  }

  /** The abort reason, or a generic error when the signal gave none. */
  error(): unknown {
    return this.signal?.reason ?? new Error('Run aborted before it finished.')
  }

  /** Resolves with `work`, or `ABORTED` when the signal fires first. */
  async guard<T>(work: Promise<T>): Promise<T | typeof ABORTED> {
    if (this.flagged) {
      return ABORTED
    }
    if (this.signal === undefined) {
      return work
    }
    return Promise.race([work, this.tripped])
  }

  dispose(): void {
    this.signal?.removeEventListener('abort', this.onAbort)
  }
}
