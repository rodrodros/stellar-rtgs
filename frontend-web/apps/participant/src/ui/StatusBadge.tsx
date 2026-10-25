import type { PaymentStatus } from "@rtgs/core";

const LABELS: Record<PaymentStatus, string> = {
  queued: "Queued",
  settled: "Settled",
  revoked: "Revoked",
  expired: "Expired",
};

export function StatusBadge({ status }: { status: PaymentStatus }) {
  return <span className={`badge badge-${status}`}>{LABELS[status]}</span>;
}

export function PriorityBadge({ priority }: { priority: "urgent" | "normal" }) {
  return <span className={`badge badge-${priority}`}>{priority === "urgent" ? "Urgent" : "Normal"}</span>;
}
