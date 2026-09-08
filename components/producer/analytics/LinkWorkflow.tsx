"use client";

import { useState } from "react";
import { useT } from "@/components/locale";

// The confirm / unlink buttons of the linking workflow. The page renders the
// listing preview on the server; this only posts the mapping and moves on.
// Errors name the failed action and keep the page usable; a conflict (the
// listing is linked to another title) is shown with the server's message.

export function ConfirmLink({ titleId, listingId, next, disabled }: { titleId: string; listingId: string; next: string; disabled?: boolean }) {
  const { tt } = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/producer/analytics/titles/${titleId}/link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ listing_id: listingId }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(res.status === 409 ? `${tt("an.link.conflict")} ${body.error ?? ""}` : res.status === 403 ? tt("an.readOnly") : `${tt("an.link.failed")} ${body.error ?? res.status}`);
        return;
      }
      window.location.href = next;
    } catch (e) {
      setError(`${tt("an.link.failed")} ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="an-link-actions">
      <button type="button" className="btn btn-primary" onClick={confirm} disabled={busy || disabled} aria-disabled={busy || disabled}>{busy ? tt("ux.loading") : tt("an.link.confirm")}</button>
      {error && <p className="note note-warn" role="alert">{error}</p>}
    </div>
  );
}

export function UnlinkButton({ titleId, next }: { titleId: string; next: string }) {
  const { tt } = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function unlink() {
    if (!window.confirm(tt("an.link.unlinkConfirm"))) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/producer/analytics/titles/${titleId}/link`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(`${tt("an.link.unlinkFailed")} ${body.error ?? res.status}`);
        return;
      }
      window.location.href = next;
    } catch (e) {
      setError(`${tt("an.link.unlinkFailed")} ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="an-link-actions">
      <button type="button" className="btn btn-outline btn-sm" onClick={unlink} disabled={busy} aria-disabled={busy}>{busy ? tt("ux.loading") : tt("an.link.unlink")}</button>
      {error && <p className="note note-warn" role="alert">{error}</p>}
    </div>
  );
}
