"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { call } from "@/components/tiktok/api";
import { useT } from "@/components/locale";
import type { LaunchConnection, LaunchProvider } from "@/lib/launch/types";
import { accountFilterDefs as filterDefs, accountFilterCounts, accountMatches, type AccountFilter as Filter, type AccountScan } from "@/lib/launch/account-filters";
import "@/app/launch-accounts.css";

type Props = { connections: LaunchConnection[]; selectedIds: string[]; onSelectionChange: (ids: string[]) => void; provider: LaunchProvider; base: string; producerId?: string; staff?: boolean };
export default function LaunchAccountPicker({ connections, selectedIds, onSelectionChange, provider, base, producerId, staff = false }: Props) {
  const { tt } = useT();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [quickCount, setQuickCount] = useState(1);
  const [quickMode, setQuickMode] = useState<"inactive" | "warmed" | "any">("inactive");
  const [scans, setScans] = useState<Record<string, AccountScan>>({});
  const [full, setFull] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");
  const scanSequence = useRef(0);
  const idsKey = connections.map(c => c.id).join(",");
  const identity = `${base}:${producerId ?? ""}:${provider}:${idsKey}`;
  const ids = useMemo(() => idsKey ? idsKey.split(",") : [], [idsKey]);
  const scan = useCallback(async (force = false) => {
    const sequence = ++scanSequence.current;
    if (!ids.length) { setScanning(false); return; }
    setScanning(true); setError("");
    try {
      for (let i = 0; i < ids.length; i += 30) {
        const response = await call<{ results: AccountScan[]; fullCountryCount: number }>(`${base}/scan`, "POST", { connection_ids: ids.slice(i, i + 30), ...(staff && producerId ? { producer_id: producerId } : {}), force });
        if (sequence !== scanSequence.current) return;
        setScans(old => ({ ...old, ...Object.fromEntries(response.results.map(s => [s.connection_id, s])) }));
        setFull(response.fullCountryCount);
      }
    } catch (e) { if (sequence === scanSequence.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (sequence === scanSequence.current) setScanning(false); }
  }, [base, ids, producerId, staff]);
  useEffect(() => {
    const sequence = scanSequence;
    setScans({}); setFull(0); setFilter("all"); setScanning(false); setError("");
    if (ids.length) void scan();
    return () => { sequence.current++; };
  }, [identity, ids.length, scan]);
  const counts = useMemo(() => accountFilterCounts(connections, scans, full), [connections, scans, full]);
  const visible = connections.filter(c => `${c.name} ${c.advertiser_id}`.toLowerCase().includes(search.toLowerCase()) && accountMatches(filter, scans[c.id], full));
  const filters = filterDefs.filter(f => !f.tiktok || provider === "tiktok");
  const pick = () => onSelectionChange(visible.filter(c => quickMode === "any" || (quickMode === "inactive" ? scans[c.id]?.active === 0 && !scans[c.id]?.error : (scans[c.id]?.reach ?? 0) > 0 && !scans[c.id]?.error)).slice(0, quickCount).map(c => c.id));
  return <details className="launch-account-picker" open><summary>{tt("launchAccounts.choose", { selected: selectedIds.length, available: connections.length })}</summary><div className="launch-account-options">
    <div className="launch-account-tools"><button className="btn btn-outline btn-sm" type="button" onClick={() => onSelectionChange(visible.map(c => c.id))}>{tt("launchAccounts.selectShown")}</button><button className="btn btn-outline btn-sm" type="button" onClick={() => onSelectionChange([])}>{tt("launchAccounts.clear")}</button><button className="btn btn-outline btn-sm" type="button" disabled={scanning} onClick={() => void scan(true)}>{tt(scanning ? "launchAccounts.scanning" : "launchAccounts.rescan")}</button><input className="input" type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder={tt("launchAccounts.search")} aria-label={tt("launchAccounts.search")} /></div>
    <div className="launch-account-quick"><span>{tt("launchAccounts.quick")}</span><input className="input" type="number" min={1} max={connections.length || 1} value={quickCount} onChange={e => setQuickCount(Math.max(1, Number(e.target.value) || 1))} aria-label={tt("launchAccounts.quickCount")} />{(["inactive", "warmed", "any"] as const).filter(m => m !== "warmed" || provider === "tiktok").map(m => <button className={`btn btn-outline btn-sm${quickMode === m ? " is-active" : ""}`} type="button" key={m} aria-pressed={quickMode === m} onClick={() => setQuickMode(m)}>{tt(`launchAccounts.quick${m === "inactive" ? "Inactive" : m === "warmed" ? "Warmed" : "Any"}`)}</button>)}<button className="btn btn-outline btn-sm" type="button" onClick={pick} disabled={quickMode !== "any" && !Object.keys(scans).length}>{tt("launchAccounts.select")}</button></div>
    {error && <p className="note note-warn" role="alert">{error}</p>}
    <div className="launch-account-filters">{filters.map(f => <button className={`btn btn-outline btn-sm${filter === f.id ? " is-active" : ""}`} type="button" key={f.id} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{tt(`launchAccounts.filter.${f.id}`)} ({counts[f.id]})</button>)}</div>
    <div className="launch-account-list">{visible.length ? visible.map(c => { const s = scans[c.id]; return <label className="launch-account-row" key={c.id}><input type="checkbox" checked={selectedIds.includes(c.id)} onChange={() => onSelectionChange(selectedIds.includes(c.id) ? selectedIds.filter(id => id !== c.id) : [...selectedIds, c.id])} /><strong>{c.name}</strong><span className="launch-account-id">{c.advertiser_id}</span><span className="launch-account-meta">{!s ? tt("launchAccounts.pending") : s.error ? s.error : <>{tt("launchAccounts.campaigns", { n: s.campaigns ?? "—" })} · {tt("launchAccounts.active", { n: s.active ?? "—" })}{provider === "tiktok" && <> · {tt("launchAccounts.reach", { n: s.reach ?? "—" })} · {tt("launchAccounts.salesCount", { n: s.sales ?? "—" })} · {tt("launchAccounts.leadgenCount", { n: s.leadgen ?? "—" })} · {s.geoCountries ? tt("launchAccounts.geoCount", { n: s.geoCountries }) : tt("launchAccounts.geoUnknown")}</>}{s.demo && ` · ${tt("launchAccounts.demo")}`}</>}</span></label>; }) : <p className="hint">{tt(scanning ? "launchAccounts.emptyScanning" : "launchAccounts.empty")}</p>}</div>
  </div></details>;
}
