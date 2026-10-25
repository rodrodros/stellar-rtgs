// Two transactions from one account at once collide on its sequence number, so each signer gets
// a lane that runs its work one at a time (the central bank app's `WriteQueue`, plus a count of
// what is queued or in flight so the engine knows which lanes are idle).

export class Lane {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  constructor(readonly address: string) {}

  /** Nothing queued and nothing in flight. */
  get idle(): boolean {
    return this.pending === 0;
  }

  /** Runs `work` after everything queued before it, whether that succeeded or failed. */
  run<T>(work: () => Promise<T>): Promise<T> {
    this.pending++;
    const step = () => work().finally(() => this.pending--);
    const next = this.tail.then(step, step);
    this.tail = next.catch(() => {});
    return next;
  }
}
