// Listener plumbing shared by the feed, the store and the registry: an app's callback that
// throws must not break core's own loops or starve the other listeners.

/**
 * Reports an exception from an app's listener without letting it break core's own loop: the
 * host's `reportError` (browsers, Node 22+), else the console.
 */
export function reportListenerError(e: unknown): void {
  const report = (globalThis as { reportError?: (e: unknown) => void }).reportError;
  if (report) report(e);
  else console.error("@rtgs/core: a listener threw", e);
}

/** Calls each listener, reporting rather than propagating what it throws. */
export function notifyAll<A extends unknown[]>(listeners: Iterable<(...args: A) => void>, ...args: A): void {
  for (const listener of listeners) {
    try {
      listener(...args);
    } catch (e) {
      reportListenerError(e);
    }
  }
}
