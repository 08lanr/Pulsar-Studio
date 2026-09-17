"use client";

// The producer's TikTok setup (decision 2026-09-16): the Business Center
// Pulsar linked to the company, every ad account inside it with its health
// and linked handle, which one the next launch would use, and the one the
// producer prefers. Read from TikTok on demand; nothing here is a token.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/components/locale";
import type { AccountHealth } from "@/lib/tiktok/account-health";
import type { CompanyAccount } from "@/lib/types";
import { call } from "@/components/tiktok/api";

type Account = { id: string; name?: string; status?: string; statusLabel: string; health: AccountHealth; identities: Array<{ id: string; type: string; name?: string }>; preferred: boolean; would_launch: boolean };
type Payload = { bc: CompanyAccount | null; accounts: Account[]; error: string | null; pick: { ok: true; advertiser_id: string } | { ok: false; blocker: string; reason: string } | null };

const HEALTH_CLASS: Record<AccountHealth, string> = { ready: "pill-success", blocked: "pill-error", pending: "pill-warning", unknown: "pill-neutral" };

export default function TikTokAccountPanel({ businessCenter, canAct }: { businessCenter: CompanyAccount; canAct: boolean }) {
  const { tt } = useT();
  const router = useRouter();
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (force = false) => {
    setLoading(true);
    try { setData(await call<Payload>(`/api/producer/company/tiktok${force ? "?force=1" : ""}`)); setError(null); }
    catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const prefer = async (id: string | null) => {
    setBusy(id ?? "clear"); setError(null);
    try { await call("/api/producer/company/tiktok", "POST", { advertiser_id: id }); await load(); router.refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };
  const accounts = data?.accounts ?? [];
  const pick = data?.pick ?? null;

  return <section className="rs-panel" id="tiktok-accounts">
    <div className="rs-panel-head"><div><h2>{tt("tka.title")}</h2><p>{tt("tka.sub")}</p></div><span className="rs-panel-aside"><span className={`state ${pick?.ok ? "state-available" : "state-collecting_history"}`}>{pick?.ok ? tt("tka.readyToLaunch") : loading ? tt("common.loading") : tt("tka.notReady")}</span></span></div>
    <dl className="rs-kv">
      <dt>{tt("ws.launchAccount.bc")}</dt><dd>{businessCenter.name} · <span className="pd-mono">{businessCenter.external_ref}</span></dd>
      <dt>{tt("tka.nextLaunch")}</dt><dd>{pick ? (pick.ok ? <>{accounts.find((a) => a.id === pick.advertiser_id)?.name ?? pick.advertiser_id} · <span className="pd-mono">{pick.advertiser_id}</span></> : <span className="gt-muted">{pick.reason}</span>) : <span className="gt-muted">{loading ? tt("common.loading") : "—"}</span>}</dd>
    </dl>
    {error && <p className="note note-warn" role="alert" style={{ margin: "0 16px 12px" }}>{error}</p>}
    {data?.error && <p className="gt-muted" style={{ margin: "0 16px 12px" }}>{data.error}</p>}
    <div className="gtable gtable-flush tk-accounts" style={{ "--cols": "minmax(180px,1.6fr) 130px minmax(160px,1.4fr) 150px" } as React.CSSProperties}>
      <div className="gt-head"><span>{tt("tka.account")}</span><span>{tt("ws.accounts.state")}</span><span>{tt("tka.handle")}</span><span>{tt("tka.use")}</span></div>
      {accounts.map((a) => <div className={`gt-row${a.would_launch ? " is-pick" : ""}`} key={a.id}>
        <span><strong>{a.name ?? tt("tka.unnamed")}</strong>{a.would_launch && <> · <span className="pill pill-accent">{tt("tka.willLaunch")}</span></>}<br /><small className="pd-mono gt-muted">{a.id}</small></span>
        <span><span className={`pill ${HEALTH_CLASS[a.health]}`}>{a.statusLabel}</span></span>
        <span>{a.identities.length ? a.identities.map((i) => <span key={i.id}>{i.name ?? i.id}<small className="gt-muted"> · {i.type}</small></span>) : <span className="gt-muted">{a.health === "ready" ? tt("tka.noHandle") : "—"}</span>}</span>
        <span>{canAct ? <label className="tk-radio"><input type="radio" name="preferred" checked={a.preferred} disabled={!!busy || a.health !== "ready" || !a.identities.length} onChange={() => void prefer(a.id)} /> {busy === a.id ? tt("common.loading") : tt(a.preferred ? "tka.preferred" : "tka.preferThis")}</label> : a.preferred ? tt("tka.preferred") : ""}</span>
      </div>)}
      {!loading && !accounts.length && <div className="gt-row"><span className="gt-muted" style={{ gridColumn: "1 / -1" }}>{tt("tka.noAccounts")}</span></div>}
      {loading && !accounts.length && <div className="gt-row"><span className="gt-muted" style={{ gridColumn: "1 / -1" }}>{tt("common.loading")}</span></div>}
    </div>
    <div className="rs-panel-foot tk-foot">
      <span>{tt("tka.foot")}</span>
      <span className="rs-tool-row">{canAct && businessCenter.preferred_advertiser_id && <button type="button" className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => void prefer(null)}>{tt("tka.clearPreference")}</button>}<button type="button" className="btn btn-outline btn-sm" disabled={loading} onClick={() => void load(true)}>{tt("tk.refresh")}</button></span>
    </div>
  </section>;
}
