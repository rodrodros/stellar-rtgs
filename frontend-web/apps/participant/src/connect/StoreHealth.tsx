// Core's store retries a failed first load by itself, with backoff; until one succeeds the
// event feed hasn't started, so the app is neither live nor complete. Say so, and offer to try
// again at once.
import { useSnapshot, useStore } from "@rtgs/core/react";

export function StoreHealth() {
  const store = useStore();
  const status = useSnapshot((s) => s.status);
  const error = useSnapshot((s) => s.error);
  if (status === "error") {
    return (
      <div className="tx tx-error" role="alert">
        <strong>Couldn't load the system's state.</strong> {error ? `${error.title}: ${error.detail}` : ""} Payment orders and live
        updates are missing until it loads; retrying.{" "}
        <button type="button" onClick={() => store.retry()}>
          Try again now
        </button>
      </div>
    );
  }
  if (error) {
    return (
      <p className="note warn" role="status">
        The last refresh failed ({error.title}: {error.detail}); some figures may be out of date.
      </p>
    );
  }
  return null;
}
