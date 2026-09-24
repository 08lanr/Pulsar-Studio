"use client";

// The operator's TikTok setup — Pulsar Grow's TikTok tab (decision
// 2026-09-16): the verdict, the Connect a Business Center button, the
// Business Centers every authorization reaches with the company each one
// is linked to, one BC's ad accounts with their health and usage
// fingerprint, the authorizations held (never the tokens), the producers'
// account requests, Pulsar's launch presets and the scheduler. Linking a
// BC to a company is the primary action on every BC row; assigning one ad
// account stays as an explicit override. The link / change / override form
// opens directly under the row it belongs to (the Business Center, the ad
// account or the request), scrolls into view and takes the focus.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/components/locale";
import type { AccountHealth } from "@/lib/tiktok/account-health";
import type { AccountFingerprint } from "@/lib/tiktok/fingerprint";
import type { AccountRequest } from "@/lib/types";
import { call } from "@/components/tiktok/api";
import MetaSetup from "@/components/launch/MetaSetup";

type Bc = { bcId: string; bcName: string; company?: string; verified?: boolean };
type BcAccount = { id: string; name?: string; status?: string; health: AccountHealth; statusLabel: string };
type Status = {
  connection: { mode: "fake" | "sandbox" | "production"; appConfigured: boolean; connected: boolean; connections: Array<{ label?: string; advertiserIds: string[]; scopes: number; savedAt: string; tokenTail: string }>; reachableAccounts: number; state: "READY" | "ACTION_REQUIRED" | "BLOCKED"; reasons: string[] };
  businessCenters: Bc[];
  bcErrors: string[];
  bc: { bcId: string; accounts: BcAccount[]; error: string | null } | null;
  probe: { advertiserId: string; state: string; reasons: string[]; identities: Array<{ id: string; type: "BC_AUTH_TT" | "TT_USER"; name?: string }>; balance?: number; status?: string; currency?: string } | null;
  requests: AccountRequest[];
  producers: Array<{ id: string; name_zh: string; name_en: string | null }>;
  assignments: Record<string, { producerId: string; kind: "business_center" | "ad_account" }>;
  scheduler: { started: boolean; lastTickAt: string | null; lastSummary: { polled: number; synced: number; duplicated?: number; errors: string[] } | null };
  /** The one account launches start on and the pixel read on it (decision 2026-09-23). */
  launchDefaults?: { advertiserId: string | null; name: string | null; status: string | null; reachedBy: string[]; pixelCode: string;
    pixel: { ok: true; pixel_id: string; relation: string } | { ok: false; reason: string; message: string } | null };
};

const HEALTH_CLASS: Record<AccountHealth, string> = { ready: "pill-success", blocked: "pill-error", pending: "pill-warning", unknown: "pill-neutral" };
type Filter = "all" | "ready" | "never" | "active" | "idle" | "fullgeo" | "limitedgeo";
const FULL_GEO = 65;

export default function TikTokSetup({ isAdmin, connect, connectDetail }: { isAdmin: boolean; connect: string | null; connectDetail: string | null }) {
  const { tt } = useT();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [openBc, setOpenBc] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<{ kind: "bc" | "account"; id: string; name: string; requestId: string | null; producerId: string; anchor: string } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const anchor = assigning?.anchor ?? null;
  useEffect(() => {
    // The form opens where the button was pressed; bring it into view and put
    // the cursor in its first field, so nothing happens off-screen.
    if (!anchor) return;
    const form = formRef.current;
    form?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    form?.querySelector<HTMLElement>("select, input")?.focus({ preventScroll: true });
  }, [anchor]);
  const [name, setName] = useState("");
  const [identity, setIdentity] = useState("");
  const [note, setNote] = useState("");
  const [fingerprints, setFingerprints] = useState<Record<string, AccountFingerprint>>({});
  const [scanning, setScanning] = useState<{ done: number; total: number } | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [acctQuery, setAcctQuery] = useState("");

  const load = useCallback(async (opts: { bc?: string | null; advertiser?: string | null; force?: boolean } = {}) => {
    setError(null);
    const p = new URLSearchParams();
    if (opts.bc) p.set("bc", opts.bc);
    if (opts.advertiser) p.set("advertiser", opts.advertiser);
    if (opts.force) p.set("force", "1");
    try { setStatus(await call<Status>(`/api/admin/tiktok/status${p.toString() ? `?${p}` : ""}`)); }
    catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // One state update per action (review finding 7): `after` names the exact
  // refresh that follows `fn`, or false when `fn` already loaded what it wanted.
  // Reading `openBc` inside would use the closure's stale value and overwrite
  // the result the action just fetched.
  async function run(key: string, fn: () => Promise<string | null>, after: { bc?: string | null; advertiser?: string | null } | false = { bc: openBc, advertiser: assigning?.kind === "account" ? assigning.id : null }) {
    setBusy(key); setError(null); setInfo(null);
    try { const m = await fn(); if (m) setInfo(m); if (after) await load(after); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }
  const openAccounts = (bcId: string, force = false) => { setOpenBc(bcId); setFilter("all"); setAcctQuery(""); void run(`bc-${bcId}`, async () => { await load({ bc: bcId, force }); return null; }, false); };
  const probe = (id: string) => run(`probe-${id}`, async () => { await load({ bc: openBc, advertiser: id }); return null; }, false);
  const producerName = (id: string) => { const p = status?.producers.find((x) => x.id === id); return p?.name_en || p?.name_zh || id; };
  const startAssignBc = (bc: Bc, requestId: string | null, producerId?: string) => { setAssigning({ kind: "bc", id: bc.bcId, name: bc.bcName, requestId, producerId: producerId ?? status?.assignments[bc.bcId]?.producerId ?? status?.producers[0]?.id ?? "", anchor: requestId ? `request:${requestId}` : `bc:${bc.bcId}` }); setName(bc.company ? `${bc.company} · ${bc.bcName}` : bc.bcName || `Business Center ${bc.bcId.slice(-4)}`); setNote(""); };
  const startAssignAccount = (a: BcAccount, requestId: string | null, producerId?: string) => { setAssigning({ kind: "account", id: a.id, name: a.name ?? "", requestId, producerId: producerId ?? status?.assignments[a.id]?.producerId ?? status?.producers[0]?.id ?? "", anchor: `account:${a.id}` }); setName(a.name ?? `TikTok ad account ${a.id.slice(-4)}`); setIdentity(""); setNote(""); void load({ bc: openBc, advertiser: a.id }); };
  const assign = () => run("assign", async () => {
    if (!assigning) return null;
    if (assigning.kind === "bc") await call("/api/admin/tiktok/assign-bc", "POST", { producer_id: assigning.producerId, bc_id: assigning.id, name, note: note || null, request_id: assigning.requestId });
    else {
      const identityRow = status?.probe?.identities.find((i) => i.id === identity) ?? null;
      await call("/api/admin/tiktok/assign", "POST", { producer_id: assigning.producerId, advertiser_id: assigning.id, name, identity_id: identityRow?.id ?? null, identity_type: identityRow?.type ?? null, note: note || null, request_id: assigning.requestId });
    }
    const who = producerName(assigning.producerId);
    setAssigning(null);
    return tt("admin.tiktok.assigned", { producer: who });
  }, { bc: openBc, advertiser: null });
  const resolve = (id: string, s: "provisioning" | "declined") => run(`req-${id}`, async () => { await call(`/api/admin/tiktok/requests/${id}`, "POST", { status: s }); return null; }, { bc: openBc, advertiser: null });
  const sync = () => run("sync", async () => { const r = await call<{ summary: { polled: number; synced: number; errors: string[] } }>("/api/promote/sync", "POST", {}); return tt("admin.promote.launch.synced", { polled: r.summary.polled, synced: r.summary.synced, errors: r.summary.errors.length }); });

  // The usage scan: batches of 30 through the fingerprint route, results kept per account.
  const scan = async (ids: string[], force = false) => {
    setScanning({ done: 0, total: ids.length }); setError(null);
    try {
      for (let i = 0; i < ids.length; i += 30) {
        const batch = ids.slice(i, i + 30);
        const r = await call<{ results: AccountFingerprint[] }>("/api/admin/tiktok/account-scan", "POST", { accounts: batch, force });
        setFingerprints((fp) => ({ ...fp, ...Object.fromEntries(r.results.map((x) => [x.accountId, x])) }));
        setScanning({ done: Math.min(ids.length, i + batch.length), total: ids.length });
      }
    } catch (e) { setError((e as Error).message); }
    finally { setScanning(null); }
  };

  const bcAccounts = status?.bc?.accounts;
  const accounts = useMemo(() => bcAccounts ?? [], [bcAccounts]);
  const visible = useMemo(() => {
    const q = acctQuery.trim().toLowerCase();
    return accounts.filter((a) => {
      if (q && !(a.id.includes(q) || (a.name ?? "").toLowerCase().includes(q))) return false;
      const fp = fingerprints[a.id];
      switch (filter) {
        case "ready": return a.health === "ready";
        case "never": return !!fp && fp.campaigns === 0;
        case "active": return !!fp && fp.active > 0;
        case "idle": return !!fp && fp.active === 0;
        case "fullgeo": return !!fp && fp.geoCountries >= FULL_GEO;
        case "limitedgeo": return !!fp && fp.geoCountries > 0 && fp.geoCountries < FULL_GEO;
        default: return true;
      }
    });
  }, [accounts, fingerprints, filter, acctQuery]);
  const counts = (f: Filter) => accounts.filter((a) => { const fp = fingerprints[a.id]; switch (f) { case "ready": return a.health === "ready"; case "never": return !!fp && fp.campaigns === 0; case "active": return !!fp && fp.active > 0; case "idle": return !!fp && fp.active === 0; case "fullgeo": return !!fp && fp.geoCountries >= FULL_GEO; case "limitedgeo": return !!fp && fp.geoCountries > 0 && fp.geoCountries < FULL_GEO; default: return true; } }).length;

  if (!status && !error) return <p className="pd-muted" role="status">{tt("admin.tiktok.loading")}</p>;
  const c = status?.connection;
  const openRequests = status?.requests.filter((r) => r.status === "requested" || r.status === "provisioning") ?? [];
  const assignedTo = (id: string) => { const a = status?.assignments[id]; return a ? producerName(a.producerId) : null; };
  const scanned = Object.keys(fingerprints).length > 0;

  /** The form, drawn under the row whose anchor opened it. */
  const assignFormAt = (at: string) => assigning?.anchor === at && (
    <form ref={formRef} className="pd-revise tk-inline-form" data-testid="tiktok-assign-form" onSubmit={(e) => { e.preventDefault(); void assign(); }} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setAssigning(null); } }}>
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
      <div className="pd-section-head tk-head-row">
        <h2 className="section-title tk-verdict">{tt("admin.tiktok.connection")} <span className={`pill ${c.state === "READY" ? "status-approved" : c.state === "BLOCKED" ? "pill-error" : "pill-warning"}`}>{tt(`admin.tiktok.state.${c.state}`)}</span> <span className={`pill ${c.mode === "production" ? "pill-error" : "pill-neutral"}`}>{tt(`admin.tiktok.mode.${c.mode}`)}</span>{!c.appConfigured && c.mode !== "fake" && <span className="pill pill-warning">{tt("tks.noCredentials")}</span>}</h2>
        <span className="pd-actions pd-wrap">
          <button type="button" className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => run("refresh", async () => { await load({ bc: openBc, force: true }); return null; }, false)}>{tt("tks.rescan")}</button>
          {isAdmin && c.mode === "production" && <a className="btn btn-primary btn-sm" href="/api/admin/tiktok/connect" aria-disabled={!c.appConfigured} onClick={(e) => { if (!c.appConfigured) e.preventDefault(); }}>{tt("tks.connectBc")}</a>}
        </span>
      </div>
      <p className="pd-muted">{tt(c.mode === "fake" ? "tks.modeFake" : c.mode === "sandbox" ? "tks.modeSandbox" : "tks.modeProduction")}</p>
      {c.mode !== "fake" && c.reasons.length > 0 && <ul className="pd-list pd-muted">{c.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
      <dl className="pd-kv">
        <dt>{tt("tks.reachable")}</dt><dd>{tt("tks.reachableValue", { accounts: c.reachableAccounts, bcs: status?.businessCenters.length ?? 0 })}</dd>
        {typeof window !== "undefined" && c.mode === "production" && <><dt>{tt("admin.tiktok.redirectUri")}</dt><dd className="pd-mono">{`${window.location.origin}/api/tiktok/callback`}</dd></>}
      </dl>
    </section>}

    {status?.launchDefaults && <section className="card pd-panel" data-testid="tiktok-launch-defaults">
      <h2 className="section-title">{tt("lpx.defaultsTitle")}</h2>
      <dl className="pd-kv">
        <dt>{tt("lpx.defaultAccount")}</dt>
        <dd>{status.launchDefaults.advertiserId
          ? <><strong>{status.launchDefaults.name ?? "—"}</strong> <span className="pd-mono">{status.launchDefaults.advertiserId}</span>{status.launchDefaults.status ? <> · <span className="gt-muted">{status.launchDefaults.status}</span></> : null}<br />
            <small className="pd-muted">{status.launchDefaults.reachedBy.length ? tt("lpx.reachedBy", { companies: status.launchDefaults.reachedBy.map(producerName).join(", ") }) : tt("lpx.reachedByNone")}</small><br />
            <small className="pd-muted">{tt("lpx.defaultAccountHint")}</small></>
          : <span className="pd-muted">{tt("lpx.defaultAccountNone")}</span>}</dd>
        <dt>{tt("lpx.pixelCode")}</dt><dd className="pd-mono">{status.launchDefaults.pixelCode}</dd>
        {status.launchDefaults.pixel && <><dt>{tt("lpx.pixelOnDefault")}</dt><dd>{status.launchDefaults.pixel.ok
          ? <span className="pill pill-success">{tt("lpx.pixelOk", { id: status.launchDefaults.pixel.pixel_id, relation: status.launchDefaults.pixel.relation })}</span>
          : <span className="note note-warn" role="status">{status.launchDefaults.pixel.message}</span>}</dd></>}
      </dl>
      <p className="pd-muted">{tt("lpx.pixelServer")}</p>
    </section>}

    <section className="card pd-panel">
      <div className="pd-section-head tk-head-row">
        <h2 className="section-title">{tt("admin.tiktok.businessCenters")} <span className="pd-count">{status?.businessCenters.length ?? 0}</span></h2>
      </div>
      <p className="pd-muted">{tt("tks.bcSub")}</p>
      {status?.bcErrors.map((e) => <p className="pd-muted" key={e}>{e}</p>)}
      {!status?.businessCenters.length && <p className="pd-muted">{tt("admin.tiktok.noBusinessCenters")}</p>}
      {status && status.businessCenters.length > 0 && <div className="gtable tk-bc-table" style={{ "--cols": "minmax(200px,1.6fr) minmax(160px,1.2fr) 110px minmax(150px,1.2fr) 230px" } as React.CSSProperties}>
        <div className="gt-head"><span>{tt("tks.colBc")}</span><span>{tt("tks.colCompany")}</span><span>{tt("tks.colVerified")}</span><span>{tt("tks.colAccounts")}</span><span /></div>
        {status.businessCenters.map((bc) => {
          const owner = assignedTo(bc.bcId);
          const isOpen = openBc === bc.bcId && status.bc?.bcId === bc.bcId;
          const reach = c?.reachableAccounts ?? 0;
          return <Fragment key={bc.bcId}><div className="gt-row">
            <span><strong>{bc.bcName || bc.bcId}</strong>{bc.company && <> · {bc.company}</>}<br /><small className="pd-mono gt-muted">{bc.bcId}</small></span>
            <span>{owner ? <span className="pill pill-accent">{owner}</span> : <span className="gt-muted">{tt("tks.unlinked")}</span>}</span>
            <span>{bc.verified ? <span className="pill pill-success">{tt("tks.verified")}</span> : <span className="gt-muted">—</span>}</span>
            <span className="gt-muted">{isOpen ? tt("tks.accountsN", { n: status.bc?.accounts.length ?? 0 }) : status.businessCenters.length === 1 ? tt("tks.accountsN", { n: reach }) : "—"}</span>
            <span className="pd-actions">
              <button type="button" className="btn btn-outline btn-sm" disabled={!!busy} onClick={() => (isOpen ? setOpenBc(null) : openAccounts(bc.bcId))}>{isOpen ? tt("admin.tiktok.hideAccounts") : tt("admin.tiktok.loadAccounts")}</button>
              {isAdmin && <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} aria-expanded={assigning?.anchor === `bc:${bc.bcId}`} onClick={() => startAssignBc(bc, null)}>{owner ? tt("tks.relink") : tt("tks.link")}</button>}
            </span>
          </div>{assignFormAt(`bc:${bc.bcId}`)}</Fragment>;
        })}
      </div>}
      {openBc && status?.bc?.bcId === openBc && <div style={{ marginTop: 12 }}>
        <h3 className="section-title">{tt("tks.accountsIn", { bc: status.businessCenters.find((b) => b.bcId === openBc)?.bcName || openBc })}</h3>
        {status.bc.error && <p className="pd-muted">{status.bc.error}</p>}
        <div className="tk-scan-row">
          <input className="input" style={{ maxWidth: 240 }} placeholder={tt("tks.searchAccounts")} value={acctQuery} onChange={(e) => setAcctQuery(e.target.value)} />
          {(["all", "ready", "never", "active", "idle", "fullgeo", "limitedgeo"] as Filter[]).map((f) => <button type="button" key={f} className={`filter-chip${filter === f ? " on" : ""}`} disabled={f !== "all" && f !== "ready" && !scanned} title={f !== "all" && f !== "ready" && !scanned ? tt("tks.scanFirst") : undefined} onClick={() => setFilter(f)}>{tt(`tks.filter.${f}`)} <span className="n">{counts(f)}</span></button>)}
          <button type="button" className="btn btn-outline btn-sm" disabled={!!scanning || !accounts.length} onClick={() => void scan(accounts.map((a) => a.id), scanned)}>{scanning ? tt("tks.scanning", { done: scanning.done, total: scanning.total }) : scanned ? tt("tks.rescanUsage") : tt("tks.scanUsage", { n: accounts.length })}</button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => openAccounts(openBc, true)}>{tt("admin.tiktok.refresh")}</button>
        </div>
        {!accounts.length && !status.bc.error && <p className="pd-muted">{tt("admin.tiktok.noAccountsInBc")}</p>}
        {accounts.length > 0 && <div className="gtable" style={{ "--cols": "minmax(200px,1.6fr) 150px minmax(200px,1.6fr) 200px" } as React.CSSProperties}>
          <div className="gt-head"><span>{tt("ws.accounts.name")}</span><span>{tt("ws.accounts.state")}</span><span>{tt("tks.usage")}</span><span /></div>
          {visible.map((a) => {
            const acctOwner = assignedTo(a.id);
            const fp = fingerprints[a.id];
            return <Fragment key={a.id}><div className="gt-row">
              <span><strong>{a.name ?? "—"}</strong>{acctOwner && <> · <span className="pill pill-accent">{acctOwner}</span></>}<br /><small className="pd-mono gt-muted">{a.id}</small></span>
              <span><span className={`pill ${HEALTH_CLASS[a.health]}`}>{a.statusLabel}</span></span>
              <span className="tk-fp">{fp ? (fp.error ? fp.error : fp.campaigns === 0 ? tt("tks.fp.cold") : tt("tks.fp.used", { campaigns: fp.campaigns, active: fp.active, geo: fp.geoCountries || "?", full: FULL_GEO })) : <span className="gt-muted">{tt("tks.fp.unscanned")}</span>}</span>
              <span className="pd-actions"><button type="button" className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => probe(a.id)}>{tt("admin.tiktok.probe")}</button>{isAdmin && <button type="button" className="btn btn-outline btn-sm" disabled={!!busy} aria-expanded={assigning?.anchor === `account:${a.id}`} onClick={() => startAssignAccount(a, null)}>{tt("tks.override")}</button>}</span>
            </div>{assignFormAt(`account:${a.id}`)}</Fragment>;
          })}
          {!visible.length && <div className="gt-row"><span className="gt-muted" style={{ gridColumn: "1 / -1" }}>{tt("tks.noMatch")}</span></div>}
        </div>}
        {status.probe && accounts.some((a) => a.id === status.probe!.advertiserId) && <div className="pd-ask" style={{ marginTop: 10 }}>
          <span>{status.probe.advertiserId} · {status.probe.state}{status.probe.status ? ` · ${status.probe.status}` : ""}{status.probe.balance != null ? ` · ${tt("tks.balance")} ${status.probe.balance} ${status.probe.currency ?? ""}` : ""}</span>
          {status.probe.reasons.map((r) => <p key={r}>{r}</p>)}
          <p>{tt("admin.tiktok.identity")}: {status.probe.identities.length ? status.probe.identities.map((i) => `${i.name ?? i.id} (${i.type})`).join(", ") : tt("admin.tiktok.identityNone")}</p>
        </div>}
      </div>}
    </section>

    {c && c.mode !== "fake" && <section className="card pd-panel">
      <h2 className="section-title">{tt("tks.authorizations")} <span className="pd-count">{c.connections.length}</span></h2>
      {!c.connections.length && <p className="pd-muted">{tt("admin.tiktok.noConnections")}</p>}
      {c.connections.length > 0 && <div className="gtable" style={{ "--cols": "minmax(200px,2fr) 90px 130px 90px" } as React.CSSProperties}>
        <div className="gt-head"><span>{tt("tks.colAuthorization")}</span><span>{tt("tks.colScopes")}</span><span>{tt("tks.colSaved")}</span><span>{tt("tks.colToken")}</span></div>
        {c.connections.map((x, i) => <div className="gt-row" key={i}><span title={x.advertiserIds.join(", ")}>{x.label ? `${x.label} · ` : ""}{tt("admin.tiktok.connectionAccounts", { n: x.advertiserIds.length })}</span><span className="gt-num">{x.scopes}</span><span>{x.savedAt === "env" ? tt("tks.fromEnv") : x.savedAt.slice(0, 10)}</span><span className="pd-mono">…{x.tokenTail}</span></div>)}
      </div>}
      <p className="pd-muted" style={{ marginTop: 8 }}>{tt("admin.tiktok.reconnectHint")}</p>
    </section>}

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
        {assignFormAt(`request:${r.id}`)}
      </div>)}
    </section>

    {/* Presets and Instant Page templates have their own page (/tiktok/templates); one place for one job (UI sweep 2026-09-24). */}
    <section className="card pd-panel">
      <div className="pd-section-head tk-head-row">
        <h2 className="section-title">{tt("tkp.title")}</h2>
        <a className="btn btn-outline btn-sm" href="/tiktok/templates">{tt("launchRedesign.manageTemplates")}</a>
      </div>
      <p className="pd-muted">{tt("tks.presetsElsewhere")}</p>
    </section>

    {/* Connections covers both providers (plan §5.3); /meta keeps working on its own. */}
    <section className="card pd-panel" id="meta">
      <MetaSetup embedded />
    </section>

    <section className="card pd-panel">
      <h2 className="section-title">{tt("admin.tiktok.scheduler")}</h2>
      <p className="pd-muted">{status?.scheduler.started ? tt("admin.tiktok.scheduler.running", { at: status.scheduler.lastTickAt ? status.scheduler.lastTickAt.slice(0, 16).replace("T", " ") + " UTC" : "—" }) : tt("admin.tiktok.scheduler.stopped")}</p>
      {status?.scheduler.lastSummary && <p className="pd-muted">{tt("tks.lastTick", { polled: status.scheduler.lastSummary.polled, synced: status.scheduler.lastSummary.synced, duplicated: status.scheduler.lastSummary.duplicated ?? 0 })}</p>}
      {status?.scheduler.lastSummary?.errors.length ? <ul className="pd-list pd-muted">{status.scheduler.lastSummary.errors.slice(0, 5).map((e) => <li key={e}>{e}</li>)}</ul> : null}
      <div className="pd-actions"><button type="button" className="btn btn-outline btn-sm" disabled={!!busy} onClick={sync}>{busy === "sync" ? tt("common.loading") : tt("admin.promote.launch.sync")}</button><a className="btn btn-ghost btn-sm" href="/promote">{tt("tks.openMonitor")}</a></div>
    </section>
  </div>;
}
