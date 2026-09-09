"use client";

// The producer's TikTok launch account (decision 2026-09-09): the account
// Pulsar assigned from its Business Center, or the request for one. The
// payment method is an opt-in record for a Pulsar-managed account — brand,
// holder and last four only; Studio never sees a card number and charges
// nothing itself.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/components/locale";
import type { AccountRequest, CompanyAccount } from "@/lib/types";

export default function LaunchAccountPanel({ account, requests, canAct }: { account: CompanyAccount | null; requests: AccountRequest[]; canAct: boolean }) {
  const { tt } = useT();
  const router = useRouter();
  const open = requests.find((r) => r.status === "requested" || r.status === "provisioning") ?? null;
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [note, setNote] = useState("");
  const [withCard, setWithCard] = useState(false);
  const [brand, setBrand] = useState("Visa");
  const [holder, setHolder] = useState("");
  const [last4, setLast4] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const ready = !!account?.identity_id;

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/producer/company/account-request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ contact_name: contactName, contact_email: contactEmail, note: note || null, payment: withCard ? { brand, holder, last4 } : null }) });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setSent(true);
      router.refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <section className="rs-panel" id="launch-account">
      <div className="rs-panel-head"><div><h2>{tt("ws.launchAccount.title")}</h2><p>{tt("ws.launchAccount.sub")}</p></div><span className="rs-panel-aside"><span className={`state ${ready ? "state-available" : account ? "state-collecting_history" : "state-requires_connection"}`}>{tt(account ? "ws.launchAccount.ready" : "ws.launchAccount.notReady")}</span></span></div>
      {account ? (
        <dl className="rs-kv">
          <dt>{tt("ws.accounts.name")}</dt><dd>{account.name}</dd>
          <dt>{tt("ws.launchAccount.advertiser")}</dt><dd className="pd-mono">{account.external_ref}</dd>
          <dt>{tt("ws.launchAccount.identity")}</dt><dd>{account.identity_id ? <span className="pd-mono">{account.identity_id}</span> : <span className="gt-muted">{tt("ws.launchAccount.noIdentity")}</span>}</dd>
          <dt>{tt("ws.launchAccount.assignedAt")}</dt><dd>{account.assigned_at?.slice(0, 10) ?? "—"}</dd>
          {account.note && <><dt>{tt("ws.accounts.note")}</dt><dd>{account.note}</dd></>}
        </dl>
      ) : open || sent ? (
        <div className="rs-panel-body">
          <p><strong>{tt("ws.launchAccount.requestStatus")}</strong> · <span className="state state-collecting_history">{tt(`ws.launchAccount.status.${open?.status ?? "requested"}`)}</span>{open?.payment && <> · <span className="gt-muted">{tt("ws.launchAccount.paymentOnFile")}: {open.payment.brand} •••• {open.payment.last4}</span></>}</p>
          {sent && <p className="note note-success" role="status">{tt("ws.launchAccount.sent")}</p>}
          {open?.staff_note && <p className="gt-muted">{open.staff_note}</p>}
        </div>
      ) : !canAct ? (
        <p className="rs-panel-body gt-muted">{tt("ws.launchAccount.viewerOnly")}</p>
      ) : (
        <form className="rs-form ws-brief-form" onSubmit={submit} style={{ padding: "12px 16px 16px" }}>
          <h3 style={{ margin: "0 0 4px" }}>{tt("ws.launchAccount.request")}</h3>
          <p className="hint" style={{ marginTop: 0 }}>{tt("ws.launchAccount.requestSub")}</p>
          <fieldset disabled={busy}>
            <div className="ws-brief-grid">
              <label>{tt("ws.launchAccount.contactName")}<input className="input" required maxLength={120} value={contactName} onChange={(e) => setContactName(e.target.value)} /></label>
              <label>{tt("ws.launchAccount.contactEmail")}<input className="input" type="email" required maxLength={200} value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} /></label>
              <label className="ws-span">{tt("ws.launchAccount.note")}<input className="input" maxLength={400} value={note} onChange={(e) => setNote(e.target.value)} /></label>
            </div>
            <div style={{ marginTop: 12 }}>
              <strong>{tt("ws.launchAccount.payment")}</strong>
              <p className="hint">{tt("ws.launchAccount.paymentSub")}</p>
              <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={withCard} onChange={(e) => setWithCard(e.target.checked)} /> {tt("ws.launchAccount.paymentOptIn")}</label>
              {withCard && <div className="ws-brief-grid" style={{ marginTop: 8 }}>
                <label>{tt("ws.launchAccount.cardBrand")}<select className="select" value={brand} onChange={(e) => setBrand(e.target.value)}>{["Visa", "Mastercard", "UnionPay", "American Express"].map((b) => <option key={b}>{b}</option>)}</select></label>
                <label>{tt("ws.launchAccount.cardLast4")}<input className="input" inputMode="numeric" pattern="\d{4}" maxLength={4} required={withCard} value={last4} onChange={(e) => setLast4(e.target.value.replace(/\D/g, "").slice(0, 4))} /></label>
                <label className="ws-span">{tt("ws.launchAccount.cardHolder")}<input className="input" maxLength={120} required={withCard} value={holder} onChange={(e) => setHolder(e.target.value)} /></label>
              </div>}
            </div>
          </fieldset>
          <div className="rs-form-foot">
            <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !contactName.trim() || !contactEmail.trim() || (withCard && (last4.length !== 4 || !holder.trim()))}>{busy ? tt("common.loading") : tt("ws.launchAccount.send")}</button>
            {error && <span role="alert" className="err">{error}</span>}
          </div>
        </form>
      )}
    </section>
  );
}
