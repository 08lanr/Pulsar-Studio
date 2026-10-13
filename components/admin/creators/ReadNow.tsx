"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/components/locale";
import { call } from "./api";

/** The Stats tab's "Read now": today's insights again (read-only towards Meta). */
export default function ReadNow({ accountId }: { accountId: string }) {
  const { tt } = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const read = async () => {
    setBusy(true); setError(null);
    const r = await call(`/api/admin/creators/${accountId}/stats`, "POST");
    setBusy(false);
    if (!r.ok) setError(r.error);
    router.refresh();
  };
  return (
    <span className="cr-actions">
      <button type="button" className="btn btn-sm btn-outline" disabled={busy} onClick={() => void read()}>{busy ? tt("cr.stats.reading") : tt("cr.stats.readNow")}</button>
      {error && <span className="err" role="alert">{error}</span>}
    </span>
  );
}
