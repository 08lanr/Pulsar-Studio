// Is this ad account safe to launch into? — Pulsar Grow's lib/account-health.ts.
// CLIENT-SAFE on purpose (no fs, no TikTok imports): the setup page imports
// it directly. Deny-by-default: an unrecognised status is never "ready".

export type AccountHealth = "ready" | "blocked" | "pending" | "unknown";

const STATUS_META: Record<string, { label: string; health: AccountHealth }> = {
  STATUS_ENABLE: { label: "Ready", health: "ready" },
  STATUS_DISABLE: { label: "Suspended", health: "blocked" },
  STATUS_LIMIT: { label: "Limited by TikTok", health: "blocked" },
  STATUS_PENALTY: { label: "Penalised", health: "blocked" },
  STATUS_PUNISH: { label: "Penalised", health: "blocked" },
  STATUS_CONFIRM_FAIL: { label: "Verification failed", health: "blocked" },
  STATUS_CONFIRM_FAIL_END: { label: "Verification failed", health: "blocked" },
  STATUS_PENDING_CONFIRM: { label: "Awaiting confirmation", health: "pending" },
  STATUS_PENDING_VERIFIED: { label: "Awaiting verification", health: "pending" },
  STATUS_CONFIRM_MODIFY: { label: "Verification in progress", health: "pending" },
  STATUS_CONFIRM_MODIFY_END: { label: "Verification in progress", health: "pending" },
  STATUS_WAIT_FOR_BPM_AUDIT: { label: "In TikTok review", health: "pending" },
  STATUS_WAIT_FOR_PUBLIC_AUTH: { label: "Awaiting authorization", health: "pending" },
  STATUS_SELF_SERVICE_UNAUDITED: { label: "Unaudited", health: "pending" },
  STATUS_CONTRACT_PENDING: { label: "Contract pending", health: "pending" },
};

export function accountHealth(status?: string | null): AccountHealth {
  if (!status) return "unknown";
  return STATUS_META[status]?.health ?? "unknown";
}

/** Human label for an account status; an unseen value still reads, de-shouted. */
export function accountStatusLabel(status?: string | null): string {
  if (!status) return "Status unknown";
  return STATUS_META[status]?.label ?? status.replace(/^STATUS_/, "").toLowerCase().replace(/_/g, " ");
}
