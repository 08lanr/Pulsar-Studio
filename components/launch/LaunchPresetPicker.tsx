"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/components/locale";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { call } from "@/components/tiktok/api";
import { defaultSalesLaunchSettings, normalizeLaunchSettings, type LaunchSettings } from "@/lib/tiktok/settings";
import type { LaunchPreset } from "@/lib/types";

export default function LaunchPresetPicker({ onSelect, value }: { onSelect: (settings: LaunchSettings) => void; value: LaunchSettings }) {
  const { tt } = useT();
  const staff = usePathname().startsWith("/promote");
  const [presets, setPresets] = useState<LaunchPreset[]>([]);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const requestId = useRef(0);
  const [chosen, setChosen] = useState<{ id: string; applied: LaunchSettings } | null>(null);
  const salesDefault = defaultSalesLaunchSettings();
  const isBuiltInDefault = value.objective_type === "WEB_CONVERSIONS" && value.location_ids.join(",") === salesDefault.location_ids.join(",") && !value.age_groups.length && value.gender === salesDefault.gender && !value.languages.length && !value.operating_systems.length && value.placement === "tiktok" && value.budget_mode === "BUDGET_MODE_DAY" && value.schedule_start === null && value.schedule_end === null && value.duration_days === null && value.duplicate_copies === 0 && value.optimization_goal === "CONVERT" && value.bid_strategy === "COST_CAP" && value.bid_usd === 0.20 && value.pacing === salesDefault.pacing && value.comments_disabled && value.call_to_action === salesDefault.call_to_action;
  const activePreset = chosen && JSON.stringify(value) === JSON.stringify(chosen.applied) ? chosen.id : isBuiltInDefault ? "__default_sales__" : "";
  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    setRefreshing(true);
    try {
      const result = await call<{ presets: LaunchPreset[] }>("/api/producer/tiktok/presets");
      if (id === requestId.current) { setPresets(result.presets); setError(""); }
    } catch (e) {
      if (id === requestId.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === requestId.current) setRefreshing(false);
    }
  }, []);
  useEffect(() => {
    const requests = requestId;
    void refresh();
    const onFocus = () => { void refresh(); };
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      requests.current++;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);
  return <div className="launch-preset-row">
    <label>{tt("tk.preset")} <select className="select" value={activePreset} onFocus={() => void refresh()} onChange={e => { if (e.target.value === "__default_sales__") { setChosen(null); onSelect({ ...defaultSalesLaunchSettings(), start_paused: value.start_paused }); return; } const p = presets.find(x => x.id === e.target.value); if (p) { const settings = normalizeLaunchSettings(p.settings); setChosen({ id: p.id, applied: { ...settings, start_paused: value.start_paused } }); onSelect(settings); } else setChosen(null); }}>
      <option value="">{tt("tk.presetCustom")}</option>
      <option value="__default_sales__">{tt("salesLaunch.defaultPreset")}</option>
      {presets.map(p => <option key={p.id} value={p.id}>{p.name}{p.note ? ` — ${p.note}` : ""}</option>)}
    </select></label>
    <button type="button" className="btn btn-outline btn-sm" disabled={refreshing} onClick={() => void refresh()}>{refreshing ? tt("common.loading") : tt("tk.refresh")}</button>
    {staff && <Link className="btn btn-outline btn-sm" href="/tiktok/templates" target="_blank" rel="noopener noreferrer">{tt("launchRedesign.manageTemplates")}&nbsp;↗</Link>}
    {error && <p className="hint" role="alert">{error}</p>}
  </div>;
}
