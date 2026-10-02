"use client";

// Custom audiences for a TikTok launch (decisions 2026-10-01, "TikTok launches
// target custom audiences" and "Audience dropdowns"): two dropdowns, Reach only
// and Leave out, each offering the chosen ad account's audiences by name with
// what each one is for. The choices come from GET …/launch/tiktok-audiences:
// TikTok's list when it answers, else the audiences saved in Studio
// (lib/tiktok/audiences.ts SAVED_AUDIENCES). An audience neither knows can
// still be named by its ID, tucked under "Use another audience by ID".

import { useEffect, useState } from "react";
import { useT } from "@/components/locale";
import { MIN_AUDIENCE_SIZE, type AudienceChoice, type AudienceChoices } from "@/lib/tiktok/audiences";
import type { AudienceRef, LaunchSettings } from "@/lib/tiktok/settings";
import { call } from "./api";

type Side = "include" | "exclude";

export default function AudiencePicker({ value, onChange, endpoint }: { value: LaunchSettings["audiences"]; onChange: (next: LaunchSettings["audiences"]) => void; endpoint: string | null }) {
  const { tt } = useT();
  const [choices, setChoices] = useState<AudienceChoices | null>(null);
  const [failed, setFailed] = useState("");
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  useEffect(() => {
    setChoices(null);
    setFailed("");
    if (!endpoint) return;
    let live = true;
    void call<AudienceChoices>(endpoint).then((r) => { if (live) setChoices(r); }).catch((e: unknown) => { if (live) setFailed(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [endpoint]);

  const include = value?.include ?? [];
  const exclude = value?.exclude ?? [];
  const known: AudienceChoice[] = choices?.audiences ?? [];
  // A chosen audience the list does not hold (named by ID, or gone since) is still an option, so it reads as chosen.
  const extra: AudienceChoice[] = [...include, ...exclude].filter((a) => !known.some((k) => k.id === a.id))
    .map((a) => ({ id: a.id, name: a.name ?? tt("tka.byIdName", { id: a.id }), description: null, size: null, valid: true, expired: false }));
  const options = [...known, ...extra];
  const byId = new Map(options.map((a) => [a.id, a]));

  /** Several audiences per side (an ad group reaches people in ANY of the Reach-only ones): adding one puts it on
   * that side and takes it off the other; removing takes it off. */
  const write = (next: { include: AudienceRef[]; exclude: AudienceRef[] }) => onChange(next.include.length || next.exclude.length ? next : undefined);
  const choose = (side: Side, audienceId: string, ref?: AudienceRef) => {
    if (!audienceId) return;
    const picked = ref ?? { id: audienceId, name: byId.get(audienceId)?.name ?? null };
    const without = (list: AudienceRef[]) => list.filter((a) => a.id !== audienceId);
    write(side === "include" ? { include: [...without(include), picked], exclude: without(exclude) } : { include: without(include), exclude: [...without(exclude), picked] });
  };
  const drop = (side: Side, audienceId: string) =>
    write(side === "include" ? { include: include.filter((a) => a.id !== audienceId), exclude } : { include, exclude: exclude.filter((a) => a.id !== audienceId) });
  const addById = (side: Side) => {
    const v = id.trim();
    if (!/^\d{6,24}$/.test(v)) return;
    choose(side, v, { id: v, name: name.trim() || null });
    setId("");
    setName("");
  };

  const about = (a: AudienceChoice | undefined) => {
    if (!a) return null;
    const size = a.size === null ? null : tt("tka.people", { n: a.size.toLocaleString("en-US") });
    const state = a.expired ? tt("tka.expired") : !a.valid || (a.size !== null && a.size < MIN_AUDIENCE_SIZE) ? tt("tka.notReady") : null;
    const words = [a.description, size, state].filter(Boolean).join(" · ");
    return words ? <p className="hint tk-aud-about">{words}</p> : null;
  };
  const row = (side: Side) => {
    const chosen = side === "include" ? include : exclude;
    const left = options.filter((a) => !chosen.some((c) => c.id === a.id));
    return <div className="tk-aud-row">
      <label className="tk-label" htmlFor={`tk-aud-${side}`}>{tt(side === "include" ? "tka.target" : "tka.exclude")}</label>
      <div>
        {chosen.length === 0 && <p className="tk-aud-empty">{tt(side === "include" ? "tka.none" : "tka.noneExcluded")}</p>}
        {chosen.map((c) => {
          const a = byId.get(c.id);
          return <div className="tk-aud-chosen" key={c.id}>
            <div><strong>{a?.name ?? c.name ?? c.id}</strong>{about(a)}</div>
            <button type="button" className="btn btn-ghost btn-sm" aria-label={tt("tka.remove", { name: a?.name ?? c.name ?? c.id })} onClick={() => drop(side, c.id)}>×</button>
          </div>;
        })}
        {left.length > 0 && <select id={`tk-aud-${side}`} className="select tk-aud-select" value="" disabled={!endpoint} onChange={(e) => choose(side, e.target.value)}>
          <option value="">{tt(chosen.length ? "tka.addAnother" : "tka.add")}</option>
          {left.map((a) => <option key={a.id} value={a.id}>{a.description ? `${a.name} — ${a.description}` : a.name}</option>)}
        </select>}
      </div>
    </div>;
  };

  return <div className="tk-field tk-aud" data-testid="tiktok-audiences">
    <span className="tk-label">{tt("tka.audiences")}</span>
    {!endpoint ? <p className="hint">{tt("tka.chooseAccount")}</p> : <>
      {!choices && !failed && <p className="hint" role="status">{tt("tka.loading")}</p>}
      {failed && <p className="note note-warn">{failed}</p>}
      {row("include")}
      {row("exclude")}
      {choices && !choices.listed && <p className="hint">{tt(known.length ? "tka.savedNote" : "tka.noneSaved")}{choices.note && <> <details className="tk-aud-why"><summary>{tt("tka.why")}</summary>{choices.note}</details></>}</p>}
      <details className="tk-aud-byid">
        <summary>{tt("tka.byIdSummary")}</summary>
        <div className="tk-aud-byid-row">
          <input className="input" inputMode="numeric" value={id} placeholder={tt("tka.byId")} aria-label={tt("tka.byId")} onChange={(e) => setId(e.target.value)} />
          <input className="input" value={name} placeholder={tt("tka.namePlaceholder")} aria-label={tt("tka.namePlaceholder")} onChange={(e) => setName(e.target.value)} />
          <button type="button" className="btn btn-outline btn-sm" disabled={!/^\d{6,24}$/.test(id.trim())} onClick={() => addById("include")}>{tt("tka.target")}</button>
          <button type="button" className="btn btn-outline btn-sm" disabled={!/^\d{6,24}$/.test(id.trim())} onClick={() => addById("exclude")}>{tt("tka.exclude")}</button>
        </div>
        <p className="hint">{tt("tka.idHint")}</p>
      </details>
    </>}
    <p className="hint">{tt("tka.hint", { min: MIN_AUDIENCE_SIZE.toLocaleString("en-US") })}</p>
  </div>;
}
