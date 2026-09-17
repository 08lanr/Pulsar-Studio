"use client";

// The launch-settings editor — overlord's ad group settings editor and its
// Mass Launch campaign settings, as one form on Studio's tokens (decision
// 2026-09-16). Used by the producer's campaign page (customize for this
// launch) and by the staff presets panel. Pure: `value` in, `onChange` out;
// the money math is shown live against the budget the caller passes.

import { useEffect, useRef, useState } from "react";
import { useT } from "@/components/locale";
import { AGE_OPTIONS, BID_STRATEGY_OPTIONS, BUDGET_MODE_OPTIONS, COMMON_LANGUAGES, CTA_OPTIONS, GENDER_OPTIONS, GOAL_OPTIONS, MAX_DURATION_DAYS, MAX_DUPLICATE_COPIES, MIN_ADGROUP_BUDGET_USD, OS_OPTIONS, PACING_OPTIONS, PLACEMENT_OPTIONS, goalOption } from "@/lib/tiktok/options";
import { defaultSalesLaunchSettings, planAdGroup, type LaunchSettings } from "@/lib/tiktok/settings";
import InstantPageTemplatePicker from "@/components/launch/InstantPageTemplatePicker";
import { call } from "./api";

type Region = { id: string; name: string; level: string; regionCode: string };

export default function LaunchSettingsEditor({ value, onChange, budgetUsd, regionsEndpoint, disabled = false }: { value: LaunchSettings; onChange: (next: LaunchSettings) => void; budgetUsd: number; regionsEndpoint: string; disabled?: boolean }) {
  const { tt } = useT();
  const set = <K extends keyof LaunchSettings>(key: K, v: LaunchSettings[K]) => onChange({ ...value, [key]: v });
  const toggle = (key: "age_groups" | "languages", v: string) => set(key, value[key].includes(v) ? value[key].filter((x) => x !== v) : [...value[key], v]);

  // Locations: names for the chosen ids, and a search box for more.
  const [names, setNames] = useState<Record<string, string>>({ "6252001": "United States" });
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Region[]>([]);
  const [searching, setSearching] = useState(false);
  const [customLang, setCustomLang] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const missing = value.location_ids.filter((id) => !names[id]);
    if (!missing.length) return;
    void call<{ names: Record<string, string> }>(`${regionsEndpoint}?ids=${missing.join(",")}`).then((r) => setNames((n) => ({ ...n, ...r.names }))).catch(() => {});
  }, [value.location_ids, names, regionsEndpoint]);
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!q.trim()) { setHits([]); return; }
    timer.current = setTimeout(() => {
      setSearching(true);
      void call<{ hits: Region[] }>(`${regionsEndpoint}?q=${encodeURIComponent(q.trim())}`).then((r) => setHits(r.hits)).catch(() => setHits([])).finally(() => setSearching(false));
    }, 250);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [q, regionsEndpoint]);
  const addLocation = (r: Region) => { if (!value.location_ids.includes(r.id)) set("location_ids", [...value.location_ids, r.id]); setNames((n) => ({ ...n, [r.id]: r.name })); setQ(""); setHits([]); };

  const goal = goalOption(value.optimization_goal);
  const plan = planAdGroup(value, budgetUsd || 0);
  const groups = value.duplicate_copies + 1;
  const noCap = value.bid_strategy === "LOWEST_COST";
  const lifetime = value.budget_mode === "BUDGET_MODE_TOTAL";
  const shareTooSmall = lifetime && budgetUsd > 0 && plan.budget < MIN_ADGROUP_BUDGET_USD;

  return <div className={`tk-editor${disabled ? " is-disabled" : ""}`}>
    <fieldset disabled={disabled} className="tk-fieldset"><legend>{tt("salesLaunch.objective")}</legend><div className="seg tk-seg"><button type="button" className={`seg-btn${value.objective_type === "WEB_CONVERSIONS" ? " on" : ""}`} aria-pressed={value.objective_type === "WEB_CONVERSIONS"} onClick={() => onChange({ ...defaultSalesLaunchSettings(), start_paused: value.start_paused, budget_mode: value.budget_mode, daily_budget_usd: value.daily_budget_usd })}>{tt("salesLaunch.sales")}</button><button type="button" className={`seg-btn${value.objective_type !== "WEB_CONVERSIONS" ? " on" : ""}`} aria-pressed={value.objective_type !== "WEB_CONVERSIONS"} onClick={() => onChange({ ...value, objective_type: "TRAFFIC", optimization_goal: "CLICK", instant_page_template: undefined })}>{tt("salesLaunch.traffic")}</button></div>{value.objective_type === "WEB_CONVERSIONS" && <InstantPageTemplatePicker value={value.instant_page_template} onChange={template => set("instant_page_template", template)} />}</fieldset>
    <fieldset disabled={disabled} className="tk-fieldset">
      <legend>{tt("tk.targeting")}</legend>
      <div className="tk-field">
        <span className="tk-label">{tt("tk.locations")}</span>
        <div className="tk-chips">{value.location_ids.map((id) => <button type="button" key={id} className="filter-chip on" onClick={() => set("location_ids", value.location_ids.filter((x) => x !== id))} title={tt("tk.remove")}>{names[id] ?? id} ×</button>)}</div>
        <div className="tk-search">
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tt("tk.locationsSearch")} aria-label={tt("tk.locationsSearch")} />
          {(hits.length > 0 || searching) && <ul className="tk-hits" role="listbox">{searching && !hits.length && <li className="gt-muted">{tt("common.loading")}</li>}{hits.map((r) => <li key={r.id}><button type="button" onClick={() => addLocation(r)}>{r.name} <small className="gt-muted">{r.level === "COUNTRY" ? r.regionCode : `${r.level.toLowerCase()} · ${r.regionCode}`}</small></button></li>)}</ul>}
        </div>
        <p className="hint">{tt("tk.locationsHint")}</p>
      </div>
      <div className="tk-field"><span className="tk-label">{tt("tk.age")}</span><div className="tk-chips">{AGE_OPTIONS.map((a) => <button type="button" key={a.value} className={`filter-chip${value.age_groups.includes(a.value) ? " on" : ""}`} onClick={() => toggle("age_groups", a.value)}>{a.label}</button>)}<span className="gt-muted tk-inline-note">{value.age_groups.length ? "" : tt("tk.allAges")}</span></div></div>
      <div className="tk-field"><span className="tk-label">{tt("tk.gender")}</span><div className="seg tk-seg" role="radiogroup">{GENDER_OPTIONS.map((g) => <button type="button" key={g.value} className={`seg-btn${value.gender === g.value ? " on" : ""}`} role="radio" aria-checked={value.gender === g.value} onClick={() => set("gender", g.value)}>{tt(`tk.gender.${g.value}`)}</button>)}</div></div>
      <div className="tk-field"><span className="tk-label">{tt("tk.languages")}</span><div className="tk-chips">{COMMON_LANGUAGES.map((l) => <button type="button" key={l.value} className={`filter-chip${value.languages.includes(l.value) ? " on" : ""}`} onClick={() => toggle("languages", l.value)}>{l.label}</button>)}{value.languages.filter((l) => !COMMON_LANGUAGES.some((c) => c.value === l)).map((l) => <button type="button" key={l} className="filter-chip on" onClick={() => toggle("languages", l)}>{l} ×</button>)}<input className="input tk-mini" value={customLang} placeholder={tt("tk.languageCode")} onChange={(e) => setCustomLang(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); const code = customLang.trim().toLowerCase(); if (/^[a-z]{2,3}(-[a-z]{2,4})?$/.test(code)) { toggle("languages", code); setCustomLang(""); } } }} /><span className="gt-muted tk-inline-note">{value.languages.length ? "" : tt("tk.allLanguages")}</span></div></div>
      <div className="tk-field"><span className="tk-label">{tt("tk.os")}</span><div className="seg tk-seg" role="radiogroup"><button type="button" className={`seg-btn${value.operating_systems.length === 0 ? " on" : ""}`} onClick={() => set("operating_systems", [])}>{tt("tk.osAll")}</button>{OS_OPTIONS.map((o) => <button type="button" key={o.value} className={`seg-btn${value.operating_systems[0] === o.value ? " on" : ""}`} onClick={() => set("operating_systems", [o.value])}>{o.label}</button>)}</div></div>
      <div className="tk-field"><span className="tk-label">{tt("tk.placement")}</span><div className="seg tk-seg" role="radiogroup">{PLACEMENT_OPTIONS.map((p) => <button type="button" key={p.value} className={`seg-btn${value.placement === p.value ? " on" : ""}`} onClick={() => set("placement", p.value as LaunchSettings["placement"])}>{tt(`tk.placement.${p.value}`)}</button>)}</div><p className="hint">{tt("tk.placementHint")}</p></div>
    </fieldset>

    <fieldset disabled={disabled} className="tk-fieldset">
      <legend>{tt("tk.budgetSchedule")}</legend>
      <div className="tk-field"><span className="tk-label">{tt("tk.budgetMode")}</span><div className="seg tk-seg" role="radiogroup">{BUDGET_MODE_OPTIONS.map((b) => <button type="button" key={b.value} className={`seg-btn${value.budget_mode === b.value ? " on" : ""}`} onClick={() => set("budget_mode", b.value)}>{tt(`tk.budgetMode.${b.value}`)}</button>)}</div></div>
      {!lifetime && <div className="tk-field tk-row">
        <label className="tk-label" htmlFor="tk-daily">{tt("tk.dailyBudget")}</label>
        <input id="tk-daily" className="input tk-num" type="number" min={MIN_ADGROUP_BUDGET_USD} step={1} value={value.daily_budget_usd ?? ""} onChange={(e) => set("daily_budget_usd", e.target.value === "" ? null : Number(e.target.value))} />
        <span className="gt-muted">{tt("tk.dailyBudgetHint", { min: MIN_ADGROUP_BUDGET_USD })}</span>
      </div>}
      {lifetime && <div className="tk-field tk-row">
        <label className="tk-label" htmlFor="tk-days">{tt("tk.duration")}</label>
        <input id="tk-days" className="input tk-num" type="number" min={1} max={MAX_DURATION_DAYS} step={1} value={value.duration_days ?? ""} placeholder={String(plan.schedule_end_time ? Math.max(1, Math.round((new Date(plan.schedule_end_time).getTime() - new Date(plan.schedule_start_time).getTime()) / 86_400_000)) : "")} onChange={(e) => set("duration_days", e.target.value === "" ? null : Number(e.target.value))} />
        <span className="gt-muted">{tt("tk.durationHint", { max: MAX_DURATION_DAYS })}</span>
      </div>}
      <div className="tk-field tk-row">
        <label className="tk-label" htmlFor="tk-start">{tt("tk.scheduleStart")}</label>
        <input id="tk-start" className="input tk-date" type="date" value={value.schedule_start ?? ""} onChange={(e) => set("schedule_start", e.target.value || null)} />
        <label className="tk-label" htmlFor="tk-end">{tt("tk.scheduleEnd")}</label>
        <input id="tk-end" className="input tk-date" type="date" value={value.schedule_end ?? ""} onChange={(e) => set("schedule_end", e.target.value || null)} />
        <span className="gt-muted">{tt("tk.scheduleHint")}</span>
      </div>
      <p className={`tk-money${shareTooSmall ? " is-bad" : ""}`}>
        {budgetUsd > 0
          ? lifetime
            ? tt("tk.moneyLifetime", { budget: budgetUsd, share: plan.budget, groups, days: plan.schedule_end_time ? Math.max(1, Math.round((new Date(plan.schedule_end_time).getTime() - new Date(plan.schedule_start_time).getTime()) / 86_400_000)) : "?" })
            : tt("tk.moneyDaily", { budget: budgetUsd, daily: value.daily_budget_usd ?? MIN_ADGROUP_BUDGET_USD, groups })
          : tt("tk.moneyNoBudget")}
        {shareTooSmall && <> {tt("tk.shareTooSmall", { min: MIN_ADGROUP_BUDGET_USD })}</>}
      </p>
    </fieldset>

    <fieldset disabled={disabled} className="tk-fieldset">
      <legend>{tt("tk.bidding")}</legend>
      <div className="tk-field tk-row">
        <label className="tk-label" htmlFor="tk-goal">{tt("tk.goal")}</label>
        <select id="tk-goal" className="select" value={value.optimization_goal} onChange={(e) => set("optimization_goal", e.target.value)}>{GOAL_OPTIONS.filter(g => value.objective_type === "WEB_CONVERSIONS" ? g.value === "CONVERT" : g.value !== "CONVERT").map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}</select>
        <span className="gt-muted">{goal.billingLabel}</span>
      </div>
      <div className="tk-field"><span className="tk-label">{tt("tk.bidStrategy")}</span><div className="seg tk-seg" role="radiogroup">{BID_STRATEGY_OPTIONS.map((b) => <button type="button" key={b.value} className={`seg-btn${value.bid_strategy === b.value ? " on" : ""}`} onClick={() => set("bid_strategy", b.value as LaunchSettings["bid_strategy"])}>{tt(`tk.bid.${b.value}`)}</button>)}</div></div>
      {value.bid_strategy === "COST_CAP" && <div className="tk-field tk-row">
        <label className="tk-label" htmlFor="tk-bid">{tt("tk.bidAmount")}</label>
        <input id="tk-bid" className="input tk-num" type="number" min={0.01} step={0.01} value={value.bid_usd ?? ""} onChange={(e) => set("bid_usd", e.target.value === "" ? null : Number(e.target.value))} />
        <span className="gt-muted">{tt(goal.billing === "CPC" ? "tk.bidAmountCpc" : "tk.bidAmountOcpm")}</span>
      </div>}
      {noCap && <p className="note note-warn tk-nocap"><strong>{tt("tk.noCapTitle")}</strong> {tt("tk.noCapBody", { budget: lifetime ? plan.budget : value.daily_budget_usd ?? MIN_ADGROUP_BUDGET_USD, per: lifetime ? tt("tk.perGroup") : tt("tk.perDayPerGroup") })}{value.duplicate_copies > 0 && <> {tt("tk.noCapCopies", { n: value.duplicate_copies, total: lifetime ? budgetUsd : (value.daily_budget_usd ?? MIN_ADGROUP_BUDGET_USD) * groups })}</>} {tt("tk.noCapFix")}</p>}
      <div className="tk-field tk-row">
        <label className="tk-label" htmlFor="tk-pacing">{tt("tk.pacing")}</label>
        <select id="tk-pacing" className="select" value={value.pacing} onChange={(e) => set("pacing", e.target.value)}>{PACING_OPTIONS.map((p) => <option key={p.value} value={p.value}>{tt(`tk.pacing.${p.value}`)}</option>)}</select>
      </div>
      <label className="tk-check"><input type="checkbox" checked={value.comments_disabled} onChange={(e) => set("comments_disabled", e.target.checked)} /> {tt("tk.commentsOff")}</label>
    </fieldset>

    <fieldset disabled={disabled} className="tk-fieldset">
      <legend>{tt("tk.launch")}</legend>
      <div className="tk-field tk-row">
        <label className="tk-label" htmlFor="tk-cta">{tt("tk.cta")}</label>
        <select id="tk-cta" className="select" value={value.call_to_action} onChange={(e) => set("call_to_action", e.target.value)}>{CTA_OPTIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</select>
      </div>
      <div className="tk-field"><span className="tk-label">{tt("tk.launchState")}</span><div className="seg tk-seg" role="radiogroup"><button type="button" className={`seg-btn${!value.start_paused ? " on" : ""}`} onClick={() => set("start_paused", false)}>▶ {tt("tk.live")}</button><button type="button" className={`seg-btn${value.start_paused ? " on" : ""}`} onClick={() => set("start_paused", true)}>⏸ {tt("tk.paused")}</button></div><p className="hint">{tt(value.start_paused ? "tk.pausedHint" : "tk.liveHint")}</p></div>
      <div className="tk-field tk-row">
        <label className="tk-label" htmlFor="tk-dup">{tt("tk.autoDup")}</label>
        <input id="tk-dup" className="input tk-num" type="number" min={0} max={MAX_DUPLICATE_COPIES} step={1} value={value.duplicate_copies} onChange={(e) => set("duplicate_copies", Math.max(0, Math.min(MAX_DUPLICATE_COPIES, Math.round(Number(e.target.value) || 0))))} />
        <span className="gt-muted">{tt("tk.autoDupHint", { max: MAX_DUPLICATE_COPIES })}</span>
      </div>
      {value.duplicate_copies > 0 && <p className="hint">{tt(lifetime ? "tk.autoDupLifetime" : "tk.autoDupDaily", { n: value.duplicate_copies, groups, share: plan.budget })}</p>}
      <div className="tk-field tk-row">
        <label className="tk-label" htmlFor="tk-prefix">{tt("tk.namePrefix")}</label>
        <input id="tk-prefix" className="input" maxLength={40} value={value.campaign_name_prefix ?? ""} placeholder="studio" onChange={(e) => set("campaign_name_prefix", e.target.value.trim() ? e.target.value : null)} />
      </div>
    </fieldset>
  </div>;
}
