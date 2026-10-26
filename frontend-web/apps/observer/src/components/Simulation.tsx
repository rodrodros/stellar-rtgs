// The simulator's status, for viewers of a hosted devnet: a label beside the feed while it
// runs, and a banner when it is quiet, paused or lost.
import { formatDuration } from "../model/expiry.ts";
import type { SimView } from "../model/simulation.ts";
import { Time } from "./format.tsx";

export function SimulationBadge(props: { view: SimView }) {
  const { view } = props;
  if (view.kind === "none") return null;
  const label = view.kind === "live" || view.kind === "quiet" ? "simulation running" : view.kind === "paused" ? "simulation paused" : "simulation down";
  const tone = view.kind === "live" ? "live" : view.kind === "lost" ? "error" : "backfilling";
  return (
    <span className={`feed feed-${tone}`}>
      <span className="dot" aria-hidden /> {label}
    </span>
  );
}

export function SimulationBanner(props: { view: SimView }) {
  const { view } = props;
  switch (view.kind) {
    case "none":
    case "live":
      return null;
    case "quiet":
      return (
        <div className="banner banner-warn" role="status">
          The simulation is running, but no transactions have reached the contract in the last {formatDuration(view.quietSecs)}.
        </div>
      );
    case "paused":
      return (
        <div className="banner banner-warn" role="status">
          <strong>The simulation is {view.state === "stopping" ? "stopping" : "paused"}</strong> (since <Time at={view.at} />,{" "}
          {formatDuration(view.secs)} ago). It restarts shortly; until then no new transactions arrive.
        </div>
      );
    case "lost":
      return (
        <div className="banner banner-warn" role="status">
          <strong>The simulation stopped unexpectedly</strong>: last heard from <Time at={view.at} />, {formatDuration(view.secs)} ago. It
          restarts automatically; until then no new transactions arrive.
        </div>
      );
  }
}
