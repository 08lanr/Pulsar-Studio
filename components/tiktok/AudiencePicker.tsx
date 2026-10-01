"use client";

// Custom audiences for a TikTok launch (decision 2026-10-01): the chosen ad
// account's audiences, each one either reached only, left out, or neither.
// They come from TikTok (GET …/launch/tiktok-audiences); while TikTok refuses
// that read (the app's Audience Management permission) the server's sentence
// shows and an audience can still be named by its ID.

import { useEffect, useState } from "react";
import { useT } from "@/components/locale";
import { MIN_AUDIENCE_SIZE, type AudienceList, type CustomAudience } from "@/lib/tiktok/audiences";
import type { AudienceRef, LaunchSettings } from "@/lib/tiktok/settings";
import { call } from "./api";

type Side = "include" | "exclude";

export default function AudiencePicker({ value, onChange, endpoint }: { value: LaunchSettings["audiences"]; onChange: (next: LaunchSettings["audiences"]) => void; endpoint: string | null }) {
  const { tt } = useT();
  const [list, setList] = useState<AudienceList | null>(null);
  const [id, setId] = useState("");
  useEffect(() => {
    setList(null);
    if (!endpoint) return;
    let live = true;
    void call<AudienceList>(endpoint).then((r) => { if (live) setList(r); }).catch((e: unknown) => { if (live) setList({ ok: false, reason: "unreadable", message: e instanceof Error ? e.message : String(e) }); });
    return () => { live = false; };
  }, [endpoint]);

  const include = value?.include ?? [];
  const exclude = value?.exclude ?? [];
  const sideOf = (audienceId: string): Side | null => (include.some((a) => a.id === audienceId) ? "include" : exclude.some((a) => a.id === audienceId) ? "exclude" : null);
  /** Put an audience on one side (off the other), or take it off when it is already there. */
  const put = (ref: AudienceRef, side: Side) => {
    const on = sideOf(ref.id) === side;
    const next = { include: include.filter((a) => a.id !== ref.id), exclude: exclude.filter((a) => a.id !== ref.id) };
    if (!on) next[side] = [...next[side], ref];
    onChange(next.include.length || next.exclude.length ? next : undefined);
  };
  const audiences: CustomAudience[] = list?.ok ? list.audiences : [];
  // Chosen audiences TikTok did not list (named by ID, or gone since) still show, so they can be taken off.
  const unlisted = [...include, ...exclude].filter((a) => !audiences.some((x) => x.id === a.id));
  const detail = (a: CustomAudience) => [a.size === null ? null : tt("tka.people", { n: a.size.toLocaleString("en-US") }), a.expired ? tt("tka.expired") : !a.valid || (a.size !== null && a.size < MIN_AUDIENCE_SIZE) ? tt("tka.notReady") : null].filter(Boolean).join(" · ");
  const row = (side: Side) => <div className="tk-chips">
    {audiences.map((a) => <button type="button" key={a.id} className={`filter-chip${sideOf(a.id) === side ? " on" : ""}`} aria-pressed={sideOf(a.id) === side} onClick={() => put({ id: a.id, name: a.name }, side)}>{a.name}{detail(a) && <small className="gt-muted"> · {detail(a)}</small>}</button>)}
    {unlisted.filter((a) => sideOf(a.id) === side).map((a) => <button type="button" key={a.id} className="filter-chip on" onClick={() => put(a, side)} title={tt("tk.remove")}>{a.name ?? a.id} ×</button>)}
    {!(side === "include" ? include : exclude).length && <span className="gt-muted tk-inline-note">{tt(side === "include" ? "tka.none" : "tka.noneExcluded")}</span>}
  </div>;
  const addById = (side: Side) => { const v = id.trim(); if (!/^\d{6,24}$/.test(v)) return; put({ id: v, name: null }, side); setId(""); };

  return <div className="tk-field" data-testid="tiktok-audiences">
    <span className="tk-label">{tt("tka.audiences")}</span>
    {!endpoint && <p className="hint">{tt("tka.chooseAccount")}</p>}
    {endpoint && !list && <p className="hint" role="status">{tt("tka.loading")}</p>}
    {list && !list.ok && <p className="note note-warn">{list.message}</p>}
    {list?.ok && !audiences.length && <p className="hint">{tt("tka.empty")}</p>}
    {(list || include.length + exclude.length > 0) && <>
      <div className="tk-field"><span className="tk-label">{tt("tka.target")}</span>{row("include")}</div>
      <div className="tk-field"><span className="tk-label">{tt("tka.exclude")}</span>{row("exclude")}</div>
    </>}
    {list && !list.ok && <div className="tk-field tk-row">
      <input className="input tk-mini" inputMode="numeric" value={id} placeholder={tt("tka.byId")} aria-label={tt("tka.byId")} onChange={(e) => setId(e.target.value)} />
      <button type="button" className="btn btn-outline" onClick={() => addById("include")}>{tt("tka.addTarget")}</button>
      <button type="button" className="btn btn-outline" onClick={() => addById("exclude")}>{tt("tka.addExclude")}</button>
      <span className="gt-muted">{tt("tka.idHint")}</span>
    </div>}
    <p className="hint">{tt("tka.hint", { min: MIN_AUDIENCE_SIZE.toLocaleString("en-US") })}</p>
  </div>;
}
