"use client";

import { useEffect, useState } from "react";
import { useT } from "@/components/locale";
import { call } from "@/components/tiktok/api";

type Account = { id: string; name: string; account_status: number; currency: string; timezone_name: string; business?: { id: string; name: string } };
type Page = { id: string; name: string; instagram_business_account?: { id: string; username: string } };
type Inventory = { accounts: Account[]; pages: Page[]; instagram: { id: string; username: string; account_id: string }[] };
type Producer = { id: string; name_zh: string; name_en: string };
/** `embedded` is the Connections page (plan §5.3): the same panels under an h2, no page heading. */
export default function MetaSetup({ embedded = false }: { embedded?: boolean } = {}) {
  const { tt } = useT();
  const [inventory, setInventory] = useState<Inventory>({ accounts: [], pages: [], instagram: [] });
  const [producers, setProducers] = useState<Producer[]>([]);
  const [producerId, setProducerId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [pageId, setPageId] = useState("");
  const [instagramId, setInstagramId] = useState("");
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
  const refresh = async () => { const r = await call<{ inventory: Inventory; producers: Producer[] }>("/api/admin/meta"); setInventory(r.inventory); setProducers(r.producers); };
  useEffect(() => { void refresh().catch((e) => setError(e instanceof Error ? e.message : String(e))); }, []);
  async function assign() {
    setBusy(true); setError(""); setSaved("");
    try { await call("/api/admin/meta", "POST", { producer_id: producerId, advertiser_id: accountId, page_id: pageId, ...(instagramId ? { instagram_id: instagramId } : {}) }); setSaved(tt("lv2.meta.saved")); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  return <div className="launch-flow"><div className="page-head"><div>{embedded ? <h2>{tt("lv2.meta.title")}</h2> : <h1>{tt("lv2.meta.title")}</h1>}<p className="page-sub">{tt("lv2.meta.sub")}</p></div><button className="btn btn-outline" onClick={() => void refresh()}>{tt("lv2.meta.refresh")}</button></div>
    <p className="hint">{tt("launch.metaConnectHelp")}</p>
    {error && <p className="note note-warn" role="alert">{error}</p>}{saved && <p className="note" role="status">{saved}</p>}
    <section className="rs-panel"><h2>{tt("lv2.meta.assign")}</h2><div className="tk-field tk-row"><label>{tt("lv2.producerId")}<select className="select" value={producerId} onChange={(e) => setProducerId(e.target.value)}><option value="">{tt("lv2.choose")}</option>{producers.map((p) => <option key={p.id} value={p.id}>{p.name_en || p.name_zh}</option>)}</select></label><label>{tt("lv2.account")}<select className="select" value={accountId} onChange={(e) => { setAccountId(e.target.value); setPageId(""); setInstagramId(""); }}><option value="">{tt("lv2.choose")}</option>{inventory.accounts.filter(a => a.account_status === 1 && a.currency === "USD").map((a) => <option key={a.id} value={a.id}>{a.name} · {a.id} · {a.currency} · {a.business?.name || "Direct"}</option>)}</select></label><label>Facebook Page<select className="select" value={pageId} onChange={(e) => choosePage(e.target.value)}><option value="">{tt("lv2.choose")}</option>{inventory.pages.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.id}</option>)}</select></label><label>Instagram<select className="select" value={instagramId} onChange={(e) => setInstagramId(e.target.value)}><option value="">{tt("lv2.none")}</option>{instagramOptions.map((i) => <option key={i.id} value={i.id}>@{i.username} · {i.id}{i.id === linkedInstagram ? ` · ${tt("lv2.meta.linkedToPage")}` : ""}</option>)}</select>{linkedInstagram && instagramId && instagramId !== linkedInstagram && <span className="hint">{tt("lv2.meta.instagramMismatch")}</span>}</label></div><button className="btn btn-primary" disabled={busy || !producerId || !accountId || !pageId} onClick={() => void assign()}>{tt("lv2.meta.assign")}</button></section>
    <section className="rs-panel"><h2>{tt("lv2.meta.available")}</h2>{inventory.accounts.map((a) => <p key={a.id}>{a.name} · {a.id} · {a.currency} · {a.timezone_name} · {a.business?.name || tt("lv2.meta.noBusiness")}</p>)}{!inventory.accounts.length && <p className="hint">{tt("lv2.meta.empty")}</p>}</section>
  </div>;
}
