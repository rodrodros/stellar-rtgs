import { toRtgsError } from "@rtgs/core";
import { Component, type ReactNode } from "react";

/** Shows a failure in core's words instead of a blank page, with a way back. */
export class ErrorBoundary extends Component<{ children: ReactNode; onReset?: () => void }, { error?: unknown }> {
  override state: { error?: unknown } = {};

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  override render() {
    if (this.state.error === undefined) return this.props.children;
    const error = toRtgsError(this.state.error);
    return (
      <div className="tx tx-error" role="alert">
        <strong>{error.title}</strong> {error.detail}{" "}
        <button
          type="button"
          onClick={() => {
            this.setState({ error: undefined });
            this.props.onReset?.();
          }}
        >
          Reconnect
        </button>
      </div>
    );
  }
}
