"use client";

// Customer-owned account inventory: record what the customer owns and the
// state they report. Studio never creates accounts or holds credentials.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/components/locale";
import type { CompanyAccount } from "@/lib/types";

const PROVIDERS: CompanyAccount["provider"][] = ["tiktok", "meta", "youtube"];
const KINDS: CompanyAccount["kind"][] = ["business_center", "ad_account", "channel", "pixel"];
const STATES: CompanyAccount["state"][] = ["unconnected", "invited", "connected", "revoked"];
const ACCESS: CompanyAccount["access"][] = ["none", "partner", "owner_operated"];

export default function AccountsForm({ accounts, canAct }: { accounts: CompanyAccount[]; canAct: boolean }) {
  const { tt } = useT();
  const router = useRouter();
  const [editing, setEditing] = useState<Partial<CompanyAccount> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(ev: React.FormEvent) {
    ev.preventDefault();
    if (!editing || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/producer/company/accounts", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: editing.id, provider: editing.provider ?? "tiktok", kind: editing.kind ?? "ad_account", name: editing.name ?? "", external_ref: editing.external_ref ?? null, state: editing.state ?? "unconnected", access: editing.access ?? "none", note: editing.note ?? null }) });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setEditing(null);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ws-accounts">
      <div className="gtable gtable-flush rs-table" style={{ ["--cols" as string]: "90px 130px minmax(0,2fr) 110px 150px minmax(0,2fr) 70px" }}>
        <div className="gt-head"><span>{tt("ws.accounts.provider")}</span><span>{tt("ws.accounts.kind")}</span><span>{tt("ws.accounts.name")}</span><span>{tt("ws.accounts.state")}</span><span>{tt("ws.accounts.access")}</span><span>{tt("ws.accounts.note")}</span><span /></div>
        {accounts.length === 0 && <div className="gt-row gt-muted">{tt("ws.accounts.empty")}</div>}
        {accounts.map((a) => (
          <div className="gt-row" key={a.id}>
            <span className="rs-platform">{a.provider}</span>
            <span>{tt(`ws.accounts.kind.${a.kind}`)}</span>
            <span style={{ minWidth: 0 }}><span className="rs-title-name">{a.name}</span>{a.external_ref && <span className="rs-title-sub">{a.external_ref}</span>}</span>
            <span><span className={`state ${a.state === "connected" ? "state-available" : a.state === "invited" ? "state-collecting_history" : a.state === "revoked" ? "state-failed" : "state-requires_connection"}`}>{tt(`ws.accounts.state.${a.state}`)}</span></span>
            <span>{tt(`ws.accounts.access.${a.access}`)}</span>
            <span className="gt-muted" style={{ whiteSpace: "normal" }}>{a.note ?? ""}</span>
            <span>{canAct && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(a)}>{tt("ux.edit")}</button>}</span>
          </div>
        ))}
      </div>
      {canAct && !editing && <div className="rs-panel-foot"><button type="button" className="btn btn-outline btn-sm" onClick={() => setEditing({ provider: "tiktok", kind: "ad_account", state: "unconnected", access: "none" })}>{tt("ws.accounts.add")}</button></div>}
      {editing && (
        <form className="rs-form ws-brief-form" onSubmit={save} style={{ padding: "12px 16px 16px" }}>
          <fieldset disabled={busy}>
            <div className="ws-brief-grid">
              <label>{tt("ws.accounts.provider")}<select className="select" value={editing.provider} onChange={(e) => setEditing({ ...editing, provider: e.target.value as CompanyAccount["provider"] })}>{PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}</select></label>
              <label>{tt("ws.accounts.kind")}<select className="select" value={editing.kind} onChange={(e) => setEditing({ ...editing, kind: e.target.value as CompanyAccount["kind"] })}>{KINDS.map((k) => <option key={k} value={k}>{tt(`ws.accounts.kind.${k}`)}</option>)}</select></label>
              <label>{tt("ws.accounts.state")}<select className="select" value={editing.state} onChange={(e) => setEditing({ ...editing, state: e.target.value as CompanyAccount["state"] })}>{STATES.map((s) => <option key={s} value={s}>{tt(`ws.accounts.state.${s}`)}</option>)}</select></label>
              <label>{tt("ws.accounts.access")}<select className="select" value={editing.access} onChange={(e) => setEditing({ ...editing, access: e.target.value as CompanyAccount["access"] })}>{ACCESS.map((s) => <option key={s} value={s}>{tt(`ws.accounts.access.${s}`)}</option>)}</select></label>
              <label className="ws-span">{tt("ws.accounts.name")}<input className="input" maxLength={120} required value={editing.name ?? ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></label>
              <label>{tt("ws.accounts.ref")}<input className="input" maxLength={120} value={editing.external_ref ?? ""} onChange={(e) => setEditing({ ...editing, external_ref: e.target.value })} /></label>
              <label className="ws-span">{tt("ws.accounts.note")}<input className="input" maxLength={400} value={editing.note ?? ""} onChange={(e) => setEditing({ ...editing, note: e.target.value })} /></label>
            </div>
          </fieldset>
          <div className="rs-form-foot">
            <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !(editing.name ?? "").trim()}>{tt("ws.accounts.save")}</button>
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => setEditing(null)}>{tt("ux.close")}</button>
            {error && <span role="alert" className="err">{error}</span>}
          </div>
        </form>
      )}
    </div>
  );
}
