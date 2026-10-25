// Every write the app sends comes from the one connected signer, and two transactions from the
// same account at once collide on its sequence number. So writes, from buttons and from the
// auto-keeper alike, go through one queue per signer and are sent one at a time.
import { createContext, useContext } from "react";

export class WriteQueue {
  private tail: Promise<unknown> = Promise.resolve();

  /** Runs `work` after every write queued before it, whether those succeed or fail. */
  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work);
    this.tail = next.catch(() => {});
    return next;
  }
}

/** The default is for trees without a provider (tests); the app provides one per signer. */
export const WriteQueueContext = createContext(new WriteQueue());

export function useWriteQueue(): WriteQueue {
  return useContext(WriteQueueContext);
}
