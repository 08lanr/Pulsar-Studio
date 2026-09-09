"use client";

// The operator's TikTok setup, Pulsar Grow's model: authorizations reach
// Business Centers; a BC is a folder of ad accounts; a vendor is assigned a
// BC and their launches pick a ready account inside it. Accounts load per
// BC on demand (never the whole estate). Assigning one ad account stays as
// an explicit override.

import { useCallback, useEffect, useState } from "react";
import { useT } from "@/components/locale";
import { postJson } from "@/lib/api-client";
import type { AccountHealth } from "@/lib/tiktok/account-health";
import type { AccountRequest } from "@/lib/types";

type Bc = { bcId: string; bcName: string; company?: string; verified?: boolean };
type BcAccount = { id: string; name?: string; status?: string; health: AccountHealth; statusLabel: string };
type Status = {
  connection: { mode: "fake" | "sandbox" | "production"; appConfigured: boolean; connected: boolean; connections: Array<{ label?: string; advertiserIds: string[]; scopes: number; savedAt: string; tokenTail: string }>; reachableAccounts: number; state: "READY" | "ACTION_REQUIRED" | "BLOCKED"; reasons: string[] };
  businessCenters: Bc[];
  bcErrors: string[];
  bc: { bcId: string; accounts: BcAccount[]; error: string | null } | null;
  probe: { advertiserId: string; state: string; reasons: string[]; identities: Array<{ id: string; type: "BC_AUTH_TT" | "TT_USER"; name?: string }>; balance?: number; status?: string } | null;
  requests: AccountRequest[];
  producers: Array<{ id: string; name_zh: string; name_en: string | null }>;
  assignments: Record<string, { producerId: string; kind: "business_center" | "ad_account" }>;
  scheduler: { started: boolean; lastTickAt: string | null; lastSummary: { polled: number; synced: number; errors: string[] } | null };
};

const HEALTH_CLASS: Record<AccountHealth, string> = { ready: "status-approved", blocked: "pill-error", pending: "pill-warning", unknown: "pill-neutral" };

export default function TikTokSetup({ isAdmin, connect, connectDetail }: { isAdmin: boolean; connect: string | null; connectDetail: string | null }) {
  const { tt } = useT();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [openBc, setOpenBc] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<{ kind: "bc" | "account"; id: string; name: string; requestId: string | null; producerId: string } | null>(null);
  const [name, setName] = useState("");
  const [identity, setIdentity] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async (opts: { bc?: string | null; advertiser?: string | null; force?: boolean } = {}) => {
    setError(null);
    const p = new URLSearchParams();
    if (opts.bc) p.set("bc", opts.bc);
    if (opts.advertiser) p.set("advertiser", opts.advertiser);
    if (opts.force) p.set("force", "1");
    try {
      const res = await fetch(`/api/admin/tiktok/status${p.toString() ? `?${p}` : ""}`, { cache: "no-store" });
      const body = (await res.json()) as Status & { error?: string };
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setStatus(body);
    } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function run(key: string, fn: () => Promise<string | null>) {
    setBusy(key); setError(null); setInfo(null);
    try { const m = await fn(); if (m) setInfo(m); await load({ bc: openBc, advertiser: assigning?.kind === "account" ? assigning.id : null }); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }
  const openAccounts = (bcId: string, force = false) => { setOpenBc(bcId); void run(`bc-${bcId}`, async () => { await load({ bc: bcId, force }); return null; }); };
  const probe = (id: string) => run(`probe-${id}`, async () => { await load({ bc: openBc, advertiser: id }); return null; });
  const producerName = (id: string) => { const p = status?.producers.find((x) => x.id === id); return p?.name_en || p?.name_zh || id; };
  const startAssignBc = (bc: Bc, requestId: string | null, producerId?: string) => { setAssigning({ kind: "bc", id: bc.bcId, name: bc.bcName, requestId, producerId: producerId ?? status?.producers[0]?.id ?? "" }); setName(bc.company ? `${bc.company} · ${bc.bcName}` : bc.bcName || `Business Center ${bc.bcId.slice(-4)}`); setNote(""); };
  const startAssignAccount = (a: BcAccount, requestId: string | null, producerId?: string) => { setAssigning({ kind: "account", id: a.id, name: a.name ?? "", requestId, producerId: producerId ?? status?.producers[0]?.id ?? "" }); setName(a.name ?? `TikTok ad account ${a.id.slice(-4)}`); setIdentity(""); setNote(""); void load({ bc: openBc, advertiser: a.id }); };
  const assign = () => run("assign", async () => {
    if (!assigning) return null;
    if (assigning.kind === "bc") {
      await postJson("/api/admin/tiktok/assign-bc", { producer_id: assigning.producerId, bc_id: assigning.id, name, note: note || null, request_id: assigning.requestId });
    } else {
      const identityRow = status?.probe?.identities.find((i) => i.id === identity) ?? null;
      await postJson("/api/admin/tiktok/assign", { producer_id: assigning.producerId, advertiser_id: assigning.id, name, identity_id: identityRow?.id ?? null, identity_type: identityRow?.type ?? null, note: note || null, request_id: assigning.requestId });
    }
    const who = producerName(assigning.producerId);
    setAssigning(null);
    return tt("admin.tiktok.assigned", { producer: who });
  });
  const resolve = (id: string, s: "provisioning" | "declined") => run(`req-${id}`, async () => { await postJson(`/api/admin/tiktok/requests/${id}`, { status: s }); return null; });
  const sync = () => run("sync", async () => { const r = await postJson<{ summary: { polled: number; synced: number; errors: string[] } }>("/api/promote/sync", {}); return tt("admin.promote.launch.synced", { polled: r.summary.polled, synced: r.summary.synced, errors: r.summary.errors.length }); });

  if (!status && !error) return <p className="pd-muted" role="status">{tt("admin.tiktok.loading")}</p>;
  const c = status?.connection;
  const openRequests = status?.requests.filter((r) => r.status === "requested" || r.status === "provisioning") ?? [];
  const assignedTo = (id: string) => { const a = status?.assignments[id]; return a ? producerName(a.producerId) : null; };

  const assignForm = assigning && (
    <form className="pd-revise" style={{ marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); void assign(); }}>
      <h3 style={{ margin: 0 }}>{tt(assigning.kind === "bc" ? "admin.tiktok.assignBcTitle" : "admin.tiktok.assignTitle", { id: assigning.id })}</h3>
      {assigning.kind === "bc" && <p className="pd-muted">{tt("admin.tiktok.assignBcHint")}</p>}
      <div className="field"><label className="label">{tt("admin.tiktok.producer")}</label><select className="input" value={assigning.producerId} onChange={(e) => setAssigning({ ...assigning, producerId: e.target.value })}>{status?.producers.map((p) => <option key={p.id} value={p.id}>{p.name_en || p.name_zh}</option>)}</select></div>
      <div className="field"><label className="label">{tt("admin.tiktok.accountName")}</label><input className="input" required value={name} onChange={(e) => setName(e.target.value)} /></div>
      {assigning.kind === "account" && <div className="field"><label className="label">{tt("admin.tiktok.identity")}</label>
        {status?.probe?.advertiserId === assigning.id ? (
          status.probe.identities.length ? <select className="input" value={identity} onChange={(e) => setIdentity(e.target.value)}><option value="">—</option>{status.probe.identities.map((i) => <option key={i.id} value={i.id}>{i.name ?? i.id} ({i.type})</option>)}</select> : <p className="pd-muted">{tt("admin.tiktok.identityNone")}</p>
        ) : <p className="pd-muted">{tt("admin.tiktok.loading")}</p>}
      </div>}
      <div className="field"><label className="label">{tt("ws.accounts.note")}</label><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></div>
      <div className="pd-actions"><button className="btn btn-primary" disabled={!!busy || !assigning.producerId || !name.trim()}>{busy === "assign" ? tt("common.loading") : tt("admin.tiktok.assign")}</button><button type="button" className="btn btn-ghost" onClick={() => setAssigning(null)}>{tt("admin.promote.revise.cancel")}</button></div>
    </form>
  );

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
        <dt>{tt("admin.tiktok.connections")}</dt><dd>{c.connections.length ? <ul className="pd-list">{c.connections.map((x, i) => <li key={i}><span className="pd-mono">…{x.tokenTail}</span> · {tt("admin.tiktok.connectionAccounts", { n: x.advertiserIds.length })} · {x.savedAt.slice(0, 10)}</li>)}</ul> : <span className="pd-muted">{tt("admin.tiktok.noConnections")}</span>}</dd>
        {typeof window !== "undefined" && c.mode === "production" && <><dt>{tt("admin.tiktok.redirectUri")}</dt><dd className="pd-mono">{`${window.location.origin}/api/tiktok/callback`}</dd></>}
      </dl>
      {c.reasons.length > 0 && <ul className="pd-list pd-muted">{c.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
      <p className="pd-muted" style={{ marginTop: 8 }}>{tt("admin.tiktok.reconnectHint")}</p>
    </section>}

    <section className="card pd-panel">
      <div className="pd-section-head" style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
        <h2 className="section-title">{tt("admin.tiktok.businessCenters")} <span className="pd-count">{status?.businessCenters.length ?? 0}</span></h2>
        <button type="button" className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => run("refresh", async () => { await load({ bc: openBc, force: true }); return null; })}>{tt("admin.tiktok.refresh")}</button>
      </div>
      <p className="pd-muted">{tt("admin.tiktok.businessCentersSub")}</p>
      {status?.bcErrors.map((e) => <p className="pd-muted" key={e}>{e}</p>)}
      {!status?.businessCenters.length && <p className="pd-muted">{tt("admin.tiktok.noBusinessCenters")}</p>}
      {status?.businessCenters.map((bc) => {
        const owner = assignedTo(bc.bcId);
        const isOpen = openBc === bc.bcId && status.bc?.bcId === bc.bcId;
        return <div className="pd-revnote" key={bc.bcId} style={{ marginTop: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <div><strong>{bc.bcName || bc.bcId}</strong>{bc.company && <> · {bc.company}</>}{bc.verified && <> · <span className="pill status-approved">verified</span></>}<br /><span className="pd-mono pd-muted">{bc.bcId}</span>{owner && <> · <span className="pill pill-accent">{tt("admin.tiktok.assignedPill", { producer: owner })}</span></>}</div>
            <span className="pd-actions">
              <button type="button" className="btn btn-outline btn-sm" disabled={!!busy} onClick={() => (isOpen ? setOpenBc(null) : openAccounts(bc.bcId))}>{isOpen ? tt("admin.tiktok.hideAccounts") : tt("admin.tiktok.loadAccounts")}</button>
              {isAdmin && <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => startAssignBc(bc, null)}>{tt("admin.tiktok.assignBc")}</button>}
            </span>
          </div>
          {isOpen && status.bc && <div style={{ marginTop: 10 }}>
            {status.bc.error && <p className="pd-muted">{status.bc.error}</p>}
            {!status.bc.accounts.length && <p className="pd-muted">{tt("admin.tiktok.noAccountsInBc")}</p>}
            {status.bc.accounts.length > 0 && <div className="gtable" style={{ "--cols": "minmax(160px,1fr) minmax(160px,1.4fr) 150px 190px" } as React.CSSProperties}>
              <div className="gt-head"><span>ID</span><span>{tt("ws.accounts.name")}</span><span>{tt("ws.accounts.state")}</span><span /></div>
              {status.bc.accounts.map((a) => {
                const acctOwner = assignedTo(a.id);
                return <div className="gt-row" key={a.id}>
                  <span className="pd-mono">{a.id}</span>
                  <span>{a.name ?? "—"}{acctOwner && <><br /><small className="gt-muted">{tt("admin.tiktok.assignedPill", { producer: acctOwner })}</small></>}</span>
                  <span><span className={`pill ${HEALTH_CLASS[a.health]}`}>{a.statusLabel}</span></span>
                  <span className="pd-actions"><button type="button" className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => probe(a.id)}>{tt("admin.tiktok.probe")}</button>{isAdmin && <button type="button" className="btn btn-outline btn-sm" disabled={!!busy} onClick={() => startAssignAccount(a, null)}>{tt("admin.tiktok.assignAccount")}</button>}</span>
                </div>;
              })}
            </div>}
            {status.probe && status.bc.accounts.some((a) => a.id === status.probe!.advertiserId) && <div className="pd-ask" style={{ marginTop: 10 }}>
              <span>{status.probe.advertiserId} · {status.probe.state}{status.probe.status ? ` · ${status.probe.status}` : ""}{status.probe.balance != null ? ` · ${status.probe.balance}` : ""}</span>
              {status.probe.reasons.map((r) => <p key={r}>{r}</p>)}
              <p>{tt("admin.tiktok.identity")}: {status.probe.identities.length ? status.probe.identities.map((i) => `${i.name ?? i.id} (${i.type})`).join(", ") : tt("admin.tiktok.identityNone")}</p>
            </div>}
          </div>}
        </div>;
      })}
      {assignForm}
    </section>

    <section className="card pd-panel">
      <h2 className="section-title">{tt("admin.tiktok.requests")} <span className="pd-count">{openRequests.length}</span></h2>
      {!openRequests.length && <p className="pd-muted">{tt("admin.tiktok.noRequests")}</p>}
      {openRequests.map((r) => <div className="pd-revnote" key={r.id} style={{ marginBottom: 10 }}>
        <span>{producerName(r.producer_id)} · {tt(`ws.launchAccount.status.${r.status}`)} · {r.created_at.slice(0, 10)}</span>
        <p>{tt("admin.tiktok.request.contact")}: {r.contact_name} · {r.contact_email}{r.note ? ` · ${r.note}` : ""}</p>
        <p>{tt("admin.tiktok.request.payment")}: {r.payment ? `${r.payment.brand} •••• ${r.payment.last4} (${r.payment.holder})` : tt("admin.tiktok.request.noPayment")}</p>
        <div className="pd-actions pd-wrap">
          {r.status === "requested" && <button type="button" className="btn btn-outline btn-sm" disabled={!!busy} onClick={() => resolve(r.id, "provisioning")}>{tt("admin.tiktok.request.provisioning")}</button>}
          {isAdmin && status?.businessCenters.length ? <select className="input" style={{ maxWidth: 280 }} value="" disabled={!!busy} onChange={(e) => { const bc = status.businessCenters.find((x) => x.bcId === e.target.value); if (bc) startAssignBc(bc, r.id, r.producer_id); }}><option value="">{tt("admin.tiktok.request.fulfilBc")}</option>{status.businessCenters.map((bc) => <option key={bc.bcId} value={bc.bcId}>{bc.bcName || bc.bcId}{bc.company ? ` · ${bc.company}` : ""}</option>)}</select> : null}
          <button type="button" className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => resolve(r.id, "declined")}>{tt("admin.tiktok.request.decline")}</button>
        </div>
      </div>)}
    </section>

    <section className="card pd-panel">
      <h2 className="section-title">{tt("admin.tiktok.scheduler")}</h2>
      <p className="pd-muted">{status?.scheduler.started ? tt("admin.tiktok.scheduler.running", { at: status.scheduler.lastTickAt ? status.scheduler.lastTickAt.slice(0, 16).replace("T", " ") + " UTC" : "—" }) : tt("admin.tiktok.scheduler.stopped")}</p>
      {status?.scheduler.lastSummary?.errors.length ? <ul className="pd-list pd-muted">{status.scheduler.lastSummary.errors.slice(0, 5).map((e) => <li key={e}>{e}</li>)}</ul> : null}
      <div className="pd-actions"><button type="button" className="btn btn-outline btn-sm" disabled={!!busy} onClick={sync}>{busy === "sync" ? tt("common.loading") : tt("admin.promote.launch.sync")}</button></div>
    </section>
  </div>;
}
