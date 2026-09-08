"use client";

// Watch / unwatch a market listing for the company. Editors only; the
// server refuses viewers and staff, and the button is disabled for them.

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/components/locale";

export default function WatchButton({ listingKey, watching, canAct }: { listingKey: string; watching: boolean; canAct: boolean }) {
  const { tt } = useT();
  const router = useRouter();
  const [on, setOn] = useState(watching);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setOn(watching), [watching]);

  async function toggle() {
    if (!canAct || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/producer/research/watchlist", {
        method: on ? "DELETE" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ listing_key: listingKey }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setOn(!on);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="rs-tool-row" style={{ alignItems: "center" }}>
      <button type="button" className={`btn btn-sm ${on ? "btn-primary" : "btn-outline"}`} onClick={toggle} disabled={!canAct || busy} title={canAct ? undefined : tt("research.watch.readOnly")} aria-pressed={on}>
        {on ? `✓ ${tt("research.watch.watching")}` : tt("research.watch.add")}
      </button>
      {error && <span className="err" role="alert">{error}</span>}
    </span>
  );
}
