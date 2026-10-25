// Core's store loads once per session and doesn't retry: if its first load failed, the event
// feed never started, so the app is neither live nor complete until it reconnects.
import { useSnapshot } from "@rtgs/core/react";
import { useReconnect } from "../session/Reconnect.tsx";

export function StoreHealth() {
  const status = useSnapshot((s) => s.status);
  const error = useSnapshot((s) => s.error);
  const reconnect = useReconnect();
  if (status === "error") {
    return (
      <div className="tx tx-error" role="alert">
        <strong>Couldn't load the system's state.</strong> {error ? `${error.title}: ${error.detail}` : ""} Payment orders and live
        updates are missing until you reconnect.{" "}
        <button type="button" onClick={reconnect}>
          Reconnect
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
