"use client";

import { useCallback, useEffect, useState } from "react";
import { useT } from "@/components/locale";
import { postJson } from "@/lib/api-client";
import type { AccountRequest } from "@/lib/types";

type Status = {
  connection: { mode: "fake" | "sandbox" | "production"; appConfigured: boolean; connected: boolean; connections: Array<{ label?: string; advertiserIds: string[]; scopes: number; savedAt: string; tokenTail: string }>; reachableAccounts: number; state: "READY" | "ACTION_REQUIRED" | "BLOCKED"; reasons: string[] };
  accounts: Array<{ advertiserId: string; name?: string; status?: string; currency?: string; balance?: number }>;
  accountsOmitted: number;
  probe: { advertiserId: string; state: string; reasons: string[]; identities: Array<{ id: string; type: "BC_AUTH_TT" | "TT_USER"; name?: string }>; balance?: number; status?: string } | null;
  requests: AccountRequest[];
  producers: Array<{ id: string; name_zh: string; name_en: string | null }>;
  scheduler: { started: boolean; lastTickAt: string | null; lastSummary: { polled: number; synced: number; errors: string[] } | null };
};

export default function TikTokSetup({ isAdmin, connect, connectDetail }: { isAdmin: boolean; connect: string | null; connectDetail: string | null }) {
  const { tt } = useT();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<{ advertiserId: string; requestId: string | null; producerId: string } | null>(null);
  const [name, setName] = useState("");
  const [identity, setIdentity] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async (advertiser?: string) => {
    setError(null);
    try {
      const res = await fetch(`/api/admin/tiktok/status${advertiser ? `?advertiser=${advertiser}` : ""}`, { cache: "no-store" });
      const body = (await res.json()) as Status & { error?: string };
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setStatus(body);
    } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function run(key: string, fn: () => Promise<string | null>) {
    setBusy(key); setError(null); setInfo(null);
    try { const m = await fn(); if (m) setInfo(m); await load(assigning?.advertiserId); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }
  const probe = (id: string) => run(`probe-${id}`, async () => { await load(id); return null; });
  const startAssign = (advertiserId: string, requestId: string | null, producerId?: string) => {
    setAssigning({ advertiserId, requestId, producerId: producerId ?? status?.producers[0]?.id ?? "" });
    setName(`TikTok ad account ${advertiserId.slice(-4)}`);
    setIdentity(status?.probe?.advertiserId === advertiserId ? status.probe.identities[0]?.id ?? "" : "");
    void load(advertiserId);
  };
  const assign = () => run("assign", async () => {
    if (!assigning) return null;
    const identityRow = status?.probe?.identities.find((i) => i.id === identity) ?? null;
    await postJson("/api/admin/tiktok/assign", { producer_id: assigning.producerId, advertiser_id: assigning.advertiserId, name, identity_id: identityRow?.id ?? null, identity_type: identityRow?.type ?? null, note: note || null, request_id: assigning.requestId });
    const producer = status?.producers.find((p) => p.id === assigning.producerId);
    setAssigning(null);
    return tt("admin.tiktok.assigned", { producer: producer?.name_en || producer?.name_zh || "" });
  });
  const resolve = (id: string, s: "provisioning" | "declined") => run(`req-${id}`, async () => { await postJson(`/api/admin/tiktok/requests/${id}`, { status: s }); return null; });
  const sync = () => run("sync", async () => { const r = await postJson<{ summary: { polled: number; synced: number; errors: string[] } }>("/api/promote/sync", {}); return tt("admin.promote.launch.synced", { polled: r.summary.polled, synced: r.summary.synced, errors: r.summary.errors.length }); });

  if (!status && !error) return <p className="pd-muted" role="status">{tt("admin.tiktok.loading")}</p>;
  const c = status?.connection;
  const openRequests = status?.requests.filter((r) => r.status === "requested" || r.status === "provisioning") ?? [];

  return <div className="pd">
    {connect === "connected" && <p className="note note-success" role="status">{tt("admin.tiktok.connected")}</p>}
    {connect === "error" && <p className="note note-warn" role="alert">{tt("admin.tiktok.connectError", { detail: connectDetail ?? "" })}</p>}
    {error && <p className="note note-warn" role="alert">{error}</p>}
    {info && <p className="note note-info" role="status">{info}</p>}

    {c && <section className="card pd-panel">
      <div className="pd-section-head" style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
        <h2 className="section-title">{tt("admin.tiktok.connection")} <span className={`pill ${c.state === "READY" ? "status-approved" : c.state === "BLOCKED" ? "pill-error" : "pill-warning"}`}>{tt(`admin.tiktok.state.${c.state}`)}</span></h2>
        {isAdmin && c.mode === "production" && <a className="btn btn-primary btn-sm" href="/api/admin/tiktok/connect">{tt(c.connected ? "admin.tiktok.reconnect" : "admin.tiktok.connect")}</a>}
      </div>
      <dl className="pd-kv">
        <dt>{tt("admin.tiktok.mode")}</dt><dd>{tt(`admin.tiktok.mode.${c.mode}`)}</dd>
        <dt>{tt("admin.tiktok.connections")}</dt><dd>{c.connections.length ? <ul className="pd-list">{c.connections.map((x, i) => <li key={i}><span className="pd-mono">…{x.tokenTail}</span> · {x.advertiserIds.length} accounts · {x.savedAt.slice(0, 10)}</li>)}</ul> : <span className="pd-muted">{tt("admin.tiktok.noConnections")}</span>}</dd>
        {typeof window !== "undefined" && c.mode === "production" && <><dt>{tt("admin.tiktok.redirectUri")}</dt><dd className="pd-mono">{`${window.location.origin}/api/admin/tiktok/callback`}</dd></>}
      </dl>
      {c.reasons.length > 0 && <ul className="pd-list pd-muted">{c.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
    </section>}

    <section className="card pd-panel">
      <h2 className="section-title">{tt("admin.tiktok.accounts")} <span className="pd-count">{status?.accounts.length ?? 0}</span></h2>
      <div className="gtable" style={{ "--cols": "minmax(160px,1fr) minmax(160px,1.4fr) 130px 90px 170px" } as React.CSSProperties}>
        <div className="gt-head"><span>ID</span><span>{tt("ws.accounts.name")}</span><span>{tt("ws.accounts.state")}</span><span>Balance</span><span /></div>
        {status?.accounts.map((a) => <div className="gt-row" key={a.advertiserId}>
          <span className="pd-mono">{a.advertiserId}</span>
          <span>{a.name ?? "—"}</span>
          <span>{a.status ?? "—"}</span>
          <span className="gt-num">{a.balance != null ? `${a.balance} ${a.currency ?? ""}` : "—"}</span>
          <span className="pd-actions"><button type="button" className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => probe(a.advertiserId)}>{tt("admin.tiktok.probe")}</button>{isAdmin && <button type="button" className="btn btn-outline btn-sm" disabled={!!busy} onClick={() => startAssign(a.advertiserId, null)}>{tt("admin.tiktok.assign")}</button>}</span>
        </div>)}
      </div>
      {!!status?.accountsOmitted && <p className="pd-muted">{tt("admin.tiktok.accountsOmitted", { n: status.accountsOmitted })}</p>}
      {status?.probe && <div className="pd-revnote" style={{ marginTop: 10 }}>
        <span>{status.probe.advertiserId} · {status.probe.state}{status.probe.status ? ` · ${status.probe.status}` : ""}</span>
        {status.probe.reasons.map((r) => <p key={r}>{r}</p>)}
        <p>{tt("admin.tiktok.identity")}: {status.probe.identities.length ? status.probe.identities.map((i) => `${i.name ?? i.id} (${i.type})`).join(", ") : tt("admin.tiktok.identityNone")}</p>
      </div>}
      {assigning && <form className="pd-revise" style={{ marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); void assign(); }}>
        <h3 style={{ margin: 0 }}>{tt("admin.tiktok.assignTitle", { id: assigning.advertiserId })}</h3>
        <div className="field"><label className="label">{tt("admin.tiktok.producer")}</label><select className="input" value={assigning.producerId} onChange={(e) => setAssigning({ ...assigning, producerId: e.target.value })}>{status?.producers.map((p) => <option key={p.id} value={p.id}>{p.name_en || p.name_zh}</option>)}</select></div>
        <div className="field"><label className="label">{tt("admin.tiktok.accountName")}</label><input className="input" required value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="field"><label className="label">{tt("admin.tiktok.identity")}</label>
          {status?.probe?.advertiserId === assigning.advertiserId ? (
            status.probe.identities.length ? <select className="input" value={identity} onChange={(e) => setIdentity(e.target.value)}><option value="">—</option>{status.probe.identities.map((i) => <option key={i.id} value={i.id}>{i.name ?? i.id} ({i.type})</option>)}</select> : <p className="pd-muted">{tt("admin.tiktok.identityNone")}</p>
          ) : <p className="pd-muted">{tt("admin.tiktok.loading")}</p>}
        </div>
        <div className="field"><label className="label">{tt("ws.accounts.note")}</label><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></div>
        <div className="pd-actions"><button className="btn btn-primary" disabled={!!busy || !assigning.producerId || !name.trim()}>{busy === "assign" ? tt("common.loading") : tt("admin.tiktok.assign")}</button><button type="button" className="btn btn-ghost" onClick={() => setAssigning(null)}>{tt("admin.promote.revise.cancel")}</button></div>
      </form>}
    </section>

    <section className="card pd-panel">
      <h2 className="section-title">{tt("admin.tiktok.requests")} <span className="pd-count">{openRequests.length}</span></h2>
      {!openRequests.length && <p className="pd-muted">{tt("admin.tiktok.noRequests")}</p>}
      {openRequests.map((r) => {
        const producer = status?.producers.find((p) => p.id === r.producer_id);
        return <div className="pd-revnote" key={r.id} style={{ marginBottom: 10 }}>
          <span>{producer?.name_en || producer?.name_zh || r.producer_id} · {tt(`ws.launchAccount.status.${r.status}`)} · {r.created_at.slice(0, 10)}</span>
          <p>{tt("admin.tiktok.request.contact")}: {r.contact_name} · {r.contact_email}{r.note ? ` · ${r.note}` : ""}</p>
          <p>{tt("admin.tiktok.request.payment")}: {r.payment ? `${r.payment.brand} •••• ${r.payment.last4} (${r.payment.holder})` : tt("admin.tiktok.request.noPayment")}</p>
          <div className="pd-actions pd-wrap">
            {r.status === "requested" && <button type="button" className="btn btn-outline btn-sm" disabled={!!busy} onClick={() => resolve(r.id, "provisioning")}>{tt("admin.tiktok.request.provisioning")}</button>}
            {isAdmin && status?.accounts.length ? <select className="input" style={{ maxWidth: 260 }} value="" disabled={!!busy} onChange={(e) => { if (e.target.value) startAssign(e.target.value, r.id, r.producer_id); }}><option value="">{tt("admin.tiktok.request.fulfil")}</option>{status.accounts.map((a) => <option key={a.advertiserId} value={a.advertiserId}>{a.advertiserId}{a.name ? ` · ${a.name}` : ""}</option>)}</select> : null}
            <button type="button" className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => resolve(r.id, "declined")}>{tt("admin.tiktok.request.decline")}</button>
          </div>
        </div>;
      })}
    </section>

    <section className="card pd-panel">
      <h2 className="section-title">{tt("admin.tiktok.scheduler")}</h2>
      <p className="pd-muted">{status?.scheduler.started ? tt("admin.tiktok.scheduler.running", { at: status.scheduler.lastTickAt ? status.scheduler.lastTickAt.slice(0, 16).replace("T", " ") + " UTC" : "—" }) : tt("admin.tiktok.scheduler.stopped")}</p>
      {status?.scheduler.lastSummary?.errors.length ? <ul className="pd-list pd-muted">{status.scheduler.lastSummary.errors.slice(0, 5).map((e) => <li key={e}>{e}</li>)}</ul> : null}
      <div className="pd-actions"><button type="button" className="btn btn-outline btn-sm" disabled={!!busy} onClick={sync}>{busy === "sync" ? tt("common.loading") : tt("admin.promote.launch.sync")}</button></div>
    </section>
  </div>;
}
