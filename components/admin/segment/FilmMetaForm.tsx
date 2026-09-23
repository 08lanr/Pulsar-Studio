"use client";

// The film-meta form (plan B2 stage 8): the one hand-written file per
// film, `cut/film-meta.json` — the English display title, the crazydramas
// slug, where spoilers begin (default half the runtime), the film windows
// an ad may never use, and the live poster's stem. The worker's default
// (`stage_view.film_meta.default`) seeds it; saving it is what ends the
// film-meta wait, after the QA sheets above it were looked at.

import { useState } from "react";
import { useT } from "@/components/locale";
import type { FilmMetaDecision, FilmMetaForm as FormValues } from "@/lib/segment/api-types";
import { titleFromSlug } from "./model";

type Props = {
  slug: string;
  /** The worker's proposal (the current file's values, else its defaults). */
  initial: FormValues | null;
  busy: boolean;
  onSubmit: (decision: FilmMetaDecision) => void;
};

type Row = { from_s: string; to_s: string; why: string; kind: string };

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export default function FilmMetaForm({ slug, initial, busy, onSubmit }: Props) {
  const { tt } = useT();
  const [title, setTitle] = useState(initial?.display_title_en ?? titleFromSlug(slug));
  const [cdSlug, setCdSlug] = useState(initial?.crazydramas_slug ?? slug.replace(/_/g, "-"));
  const [spoiler, setSpoiler] = useState<string>(initial?.spoiler_from_s !== null && initial?.spoiler_from_s !== undefined ? String(initial.spoiler_from_s) : "");
  const [poster, setPoster] = useState(initial?.live_poster ?? "");
  const [rows, setRows] = useState<Row[]>(() => (initial?.exclusions ?? []).map((x) => ({ from_s: String(x.from_s), to_s: String(x.to_s), why: x.why, kind: x.kind ?? "" })));

  const slugOk = cdSlug.trim() === "" || SLUG.test(cdSlug.trim());
  const rowsOk = rows.every((r) => r.why.trim().length > 0 && Number(r.to_s) > Number(r.from_s) && Number(r.from_s) >= 0);
  const ok = title.trim().length > 0 && slugOk && rowsOk && !busy;

  function submit() {
    if (!ok) return;
    const spoilerN = spoiler.trim() === "" ? null : Math.max(0, Number(spoiler));
    onSubmit({
      kind: "film_meta",
      display_title_en: title.trim(),
      crazydramas_slug: cdSlug.trim() === "" ? null : cdSlug.trim(),
      spoiler_from_s: spoilerN !== null && Number.isFinite(spoilerN) ? spoilerN : null,
      exclusions: rows.map((r) => ({ from_s: Number(r.from_s), to_s: Number(r.to_s), why: r.why.trim(), kind: r.kind.trim() || null })),
      live_poster: poster.trim() || null,
    });
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }} aria-label={tt("seg.meta.title")}>
      <label className="field field-key">
        <span className="label">{tt("seg.meta.displayTitle")}</span>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} lang="en" />
      </label>
      <label className="field">
        <span className="label">{tt("seg.meta.cdSlug")}</span>
        <input className="input" value={cdSlug} onChange={(e) => setCdSlug(e.target.value)} lang="en" spellCheck={false} aria-invalid={!slugOk} />
        {!slugOk && <span className="err">{tt("seg.intake.slugBad")}</span>}
      </label>
      <label className="field">
        <span className="label">{tt("seg.meta.spoiler")}</span>
        <input className="input" type="number" min={0} step={1} value={spoiler} onChange={(e) => setSpoiler(e.target.value)} />
        <span className="hint">{tt("seg.meta.spoilerHint")}</span>
      </label>
      <div className="field">
        <span className="label">{tt("seg.meta.exclusions")}</span>
        {rows.length === 0 && <p className="hint">{tt("seg.meta.noExclusions")}</p>}
        <div style={{ display: "grid", gap: 8 }}>
          {rows.map((r, i) => (
            <div className="sgm-exclusion" key={i}>
              <input className="input" type="number" min={0} value={r.from_s} onChange={(e) => setRows((x) => x.map((y, j) => (j === i ? { ...y, from_s: e.target.value } : y)))} aria-label={tt("seg.meta.from")} />
              <input className="input" type="number" min={0} value={r.to_s} onChange={(e) => setRows((x) => x.map((y, j) => (j === i ? { ...y, to_s: e.target.value } : y)))} aria-label={tt("seg.meta.to")} />
              <input className="input" value={r.why} onChange={(e) => setRows((x) => x.map((y, j) => (j === i ? { ...y, why: e.target.value } : y)))} placeholder={tt("seg.meta.why")} aria-label={tt("seg.meta.why")} />
              <input className="input" value={r.kind} onChange={(e) => setRows((x) => x.map((y, j) => (j === i ? { ...y, kind: e.target.value } : y)))} placeholder={tt("seg.meta.kind")} aria-label={tt("seg.meta.kind")} />
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRows((x) => x.filter((_, j) => j !== i))}>{tt("seg.meta.remove")}</button>
            </div>
          ))}
        </div>
        <button type="button" className="btn btn-outline btn-sm" style={{ marginTop: 8 }} onClick={() => setRows((x) => [...x, { from_s: "0", to_s: "1", why: "", kind: "" }])}>{tt("seg.meta.addExclusion")}</button>
      </div>
      <label className="field">
        <span className="label">{tt("seg.meta.poster")}</span>
        <input className="input" value={poster} onChange={(e) => setPoster(e.target.value)} lang="en" spellCheck={false} />
        <span className="hint">{tt("seg.meta.posterHint")}</span>
      </label>
      <div className="form-actions" style={{ marginTop: 16 }}>
        <button type="submit" className="btn btn-primary" disabled={!ok}>{busy ? <><span className="spinner" /> {tt("seg.saving")}</> : tt("seg.meta.save")}</button>
      </div>
    </form>
  );
}
