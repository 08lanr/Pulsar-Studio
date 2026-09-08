"use client";

// Fixture mode only: names the dataset for what it is and offers the reset.
// Simulated rows are labelled where they appear; this chip says the whole
// workspace is the rehearsal dataset, and puts it back the way it started.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/components/locale";

export default function DemoBadge({ canReset = true }: { canReset?: boolean }) {
  const { tt } = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<"idle" | "done" | "error">("idle");
  async function reset() {
    if (!window.confirm(tt("review.resetConfirm"))) return;
    setBusy(true);
    setState("idle");
    try {
      const res = await fetch("/api/demo/reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ seed: "demo" }) });
      if (!res.ok) throw new Error(String(res.status));
      setState("done");
      router.refresh();
    } catch {
      setState("error");
    } finally {
      setBusy(false);
    }
  }
  const label = busy ? tt("common.loading") : state === "done" ? tt("demo.resetDone") : state === "error" ? tt("demo.resetFailed") : tt("demo.reset");
  return (
    <span className="demo-badge" role="group" aria-label={tt("demo.badge")}>
      <span className="demo-badge-label" title={tt("demo.badgeHint")}>{tt("demo.badge")}</span>
      {canReset && <button type="button" className="demo-badge-reset" onClick={reset} disabled={busy} aria-live="polite">{label}</button>}
    </span>
  );
}
