"use client";

import { useEffect, useState } from "react";
import { useT } from "@/components/locale";
import { call } from "@/components/tiktok/api";
import { connectionLabel } from "@/lib/launch/connection-label";
import type { LaunchConnection } from "@/lib/launch/types";

type Account = { id: string; name: string; account_status: number; currency: string; timezone_name: string; business?: { id: string; name: string } };
type Page = { id: string; name: string; instagram_business_account?: { id: string; username: string } };
type Inventory = { accounts: Account[]; pages: Page[]; instagram: { id: string; username: string; account_id: string }[] };
type Producer = { id: string; name_zh: string; name_en: string };
/** `embedded` is the Connections page (plan §5.3): the same panels under an h2, no page heading. */
export default function MetaSetup({ embedded = false }: { embedded?: boolean } = {}) {
  const { tt } = useT();
  const [inventory, setInventory] = useState<Inventory>({ accounts: [], pages: [], instagram: [] });
  const [producers, setProducers] = useState<Producer[]>([]);
  const [assigned, setAssigned] = useState<LaunchConnection[]>([]);
  const [producerId, setProducerId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [pageId, setPageId] = useState("");
  const [instagramId, setInstagramId] = useState("");
  const [autoPost, setAutoPost] = useState(true);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  const instagramOptions = inventory.instagram.filter(i => i.account_id === accountId);
  // Organic posts go out through the Page, so the Page's own Instagram account
  // is the one to assign; choosing a Page preselects it when the ad account can use it.
  const linkedInstagram = inventory.pages.find(p => p.id === pageId)?.instagram_business_account?.id ?? null;
  const choosePage = (id: string) => {
    setPageId(id);
    const linked = inventory.pages.find(p => p.id === id)?.instagram_business_account?.id;
    if (linked && instagramOptions.some(i => i.id === linked)) setInstagramId(linked);
  };
  // The auto-poster uses one account per company (decision 2026-10-25): on by
  // default for a company's first Meta account, off for any further one.
  const chooseProducer = (id: string) => { setProducerId(id); setAutoPost(!assigned.some(c => c.producer_id === id && c.enabled)); };
  const refresh = async () => { const r = await call<{ inventory: Inventory; producers: Producer[]; assigned?: LaunchConnection[] }>("/api/admin/meta"); setInventory(r.inventory); setProducers(r.producers); setAssigned(r.assigned ?? []); };
  useEffect(() => { void refresh().catch((e) => setError(e instanceof Error ? e.message : String(e))); }, []);
  async function assign() {
    setBusy(true); setError(""); setSaved("");
    try { await call("/api/admin/meta", "POST", { producer_id: producerId, advertiser_id: accountId, page_id: pageId, ...(instagramId ? { instagram_id: instagramId } : {}), auto_post: autoPost }); setSaved(tt("lv2.meta.saved")); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  async function turnOff(c: LaunchConnection) {
    setBusy(true); setError(""); setSaved("");
    try { await call("/api/admin/meta", "POST", { producer_id: c.producer_id, advertiser_id: c.advertiser_id, page_id: c.page_id, enabled: false }); setSaved(tt("lv2.meta.turnedOff")); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  const producerName = (id: string) => { const p = producers.find(x => x.id === id); return p ? p.name_en || p.name_zh : id; };
  return <div className="launch-flow"><div className="page-head"><div>{embedded ? <h2>{tt("lv2.meta.title")}</h2> : <h1>{tt("lv2.meta.title")}</h1>}<p className="page-sub">{tt("lv2.meta.sub")}</p></div><button className="btn btn-outline" onClick={() => void refresh()}>{tt("lv2.meta.refresh")}</button></div>
    <p className="hint">{tt("launch.metaConnectHelp")}</p>
    {error && <p className="note note-warn" role="alert">{error}</p>}{saved && <p className="note" role="status">{saved}</p>}
    <section className="rs-panel"><h2>{tt("lv2.meta.assigned")}</h2>{assigned.filter(c => c.enabled).map((c) => <p key={c.id}>{producerName(c.producer_id)} · {connectionLabel(c)} · {tt(c.auto_post === false ? "lv2.meta.autoPostOff" : "lv2.meta.autoPostOn")} <button className="btn btn-outline btn-sm" disabled={busy} onClick={() => void turnOff(c)}>{tt("lv2.meta.turnOff")}</button></p>)}{!assigned.some(c => c.enabled) && <p className="hint">{tt("lv2.meta.assignedEmpty")}</p>}</section>
    <section className="rs-panel"><h2>{tt("lv2.meta.assign")}</h2><div className="tk-field tk-row"><label>{tt("lv2.producerId")}<select className="select" value={producerId} onChange={(e) => chooseProducer(e.target.value)}><option value="">{tt("lv2.choose")}</option>{producers.map((p) => <option key={p.id} value={p.id}>{p.name_en || p.name_zh}</option>)}</select></label><label>{tt("lv2.account")}<select className="select" value={accountId} onChange={(e) => { setAccountId(e.target.value); setPageId(""); setInstagramId(""); }}><option value="">{tt("lv2.choose")}</option>{inventory.accounts.filter(a => a.account_status === 1 && a.currency === "USD").map((a) => <option key={a.id} value={a.id}>{a.name} · {a.id} · {a.currency} · {a.business?.name || "Direct"}</option>)}</select></label><label>Facebook Page<select className="select" value={pageId} onChange={(e) => choosePage(e.target.value)}><option value="">{tt("lv2.choose")}</option>{inventory.pages.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.id}</option>)}</select></label><label>Instagram<select className="select" value={instagramId} onChange={(e) => setInstagramId(e.target.value)}><option value="">{tt("lv2.none")}</option>{instagramOptions.map((i) => <option key={i.id} value={i.id}>@{i.username} · {i.id}{i.id === linkedInstagram ? ` · ${tt("lv2.meta.linkedToPage")}` : ""}</option>)}</select>{linkedInstagram && instagramId && instagramId !== linkedInstagram && <span className="hint">{tt("lv2.meta.instagramMismatch")}</span>}</label></div><label className="tk-check"><input type="checkbox" checked={autoPost} onChange={(e) => setAutoPost(e.target.checked)} /> {tt("lv2.meta.autoPost")}</label><p className="hint">{tt("lv2.meta.autoPostHint")}</p><button className="btn btn-primary" disabled={busy || !producerId || !accountId || !pageId} onClick={() => void assign()}>{tt("lv2.meta.assign")}</button></section>
    <section className="rs-panel"><h2>{tt("lv2.meta.available")}</h2>{inventory.accounts.map((a) => <p key={a.id}>{a.name} · {a.id} · {a.currency} · {a.timezone_name} · {a.business?.name || tt("lv2.meta.noBusiness")}</p>)}{!inventory.accounts.length && <p className="hint">{tt("lv2.meta.empty")}</p>}</section>
  </div>;
}
