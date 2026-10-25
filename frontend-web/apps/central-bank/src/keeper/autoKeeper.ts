// The in-tab auto-keeper: while this tab is open and the toggle is on, it rejects expired
// payment orders and converts overdue repos. It is a demo stand-in. A keeper that runs when no
// browser is open needs a server, which this project doesn't have.
export interface KeeperWork {
  payments: bigint[];
  repos: bigint[];
}

export interface KeeperDeps {
  /** What is due now, read from the latest snapshot. */
  due(): KeeperWork;
  expire(id: bigint): Promise<unknown>;
  convertOverdue(repoId: bigint): Promise<unknown>;
  onResult?(result: KeeperResult): void;
}

export type KeeperResult =
  | { kind: "expired" | "converted"; id: bigint }
  | { kind: "failed"; action: "expire" | "convert"; id: bigint; error: unknown };

/**
 * One pass at a time, one transaction at a time, since every keeper transaction comes from
 * the same account. An id that failed is skipped for `retryAfterTicks` passes, so a refusal
 * doesn't resend it every tick.
 */
export class AutoKeeper {
  private running = false;
  private busy = false;
  private tickCount = 0;
  private readonly failedAt = new Map<string, number>();

  constructor(
    private readonly deps: KeeperDeps,
    private readonly retryAfterTicks = 6,
  ) {}

  start(): void {
    this.running = true;
  }

  stop(): void {
    this.running = false;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** One pass over the due work. Does nothing when stopped or while a pass is still going. */
  async tick(): Promise<void> {
    if (!this.running || this.busy) return;
    this.busy = true;
    this.tickCount += 1;
    try {
      const { payments, repos } = this.deps.due();
      for (const id of payments) await this.run("expire", id, () => this.deps.expire(id));
      for (const id of repos) await this.run("convert", id, () => this.deps.convertOverdue(id));
    } finally {
      this.busy = false;
    }
  }

  private async run(action: "expire" | "convert", id: bigint, send: () => Promise<unknown>): Promise<void> {
    if (!this.running) return;
    const key = `${action}:${id}`;
    const failed = this.failedAt.get(key);
    if (failed !== undefined && this.tickCount - failed < this.retryAfterTicks) return;
    try {
      await send();
      this.failedAt.delete(key);
      this.deps.onResult?.({ kind: action === "expire" ? "expired" : "converted", id });
    } catch (error) {
      this.failedAt.set(key, this.tickCount);
      this.deps.onResult?.({ kind: "failed", action, id, error });
    }
  }
}
