"use client";

// The series' slug in "Upload to crazydramas" (decision 2026-09-23 "Upload
// automation: poster, slug, series text"): Studio picks it itself. With no
// slug yet (`auto`), the field asks POST …/slug on its own as it opens —
// Studio derives one from the display title, checks it on crazydramas and
// saves it on the title and in the film's film-meta — and says what came of
// it. crazydramas not answering is said in words with Retry, never as a
// file to edit. Until the draft series exists the slug stays editable here
// (a typed slug is checked the same way; one another series has comes back
// with the next free one to take in one click); after that it is locked,
// with the reason: ad links depend on it.

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/components/locale";
import type { SlugReply } from "@/lib/crazydramas/publish-types";
import { cdRoute, refusalWords, sendJson, type Refusal } from "./request";

type Props = {
  titleId: string;
  slug: string | null;
  /** The slug may still change (no draft series, no upload). */
  editable: boolean;
  /** Pick one on open when there is none. */
  auto: boolean;
  /** Why a locked slug no longer changes, in words (the section's own reading); the fixed sentence when absent. */
  lockedReason?: string | null;
  /** The slug of the series the title is linked to, when its slug was changed away from it: offered as "Put the slug back". */
  restore?: string | null;
  onSaved: (reply: SlugReply) => void;
};

type Outcome = { kind: "ok"; text: string } | { kind: "error"; text: string; code: string | null; suggestion: string | null } | null;

export default function SlugField({ titleId, slug, editable, auto, lockedReason, restore, onSaved }: Props) {
  const { tt } = useT();
  const [value, setValue] = useState(slug ?? "");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const started = useRef(false);

  useEffect(() => setValue(slug ?? ""), [slug]);

  const save = useCallback(
    async (typed: string | null) => {
      setBusy(true);
      setOutcome(null);
      try {
        const r = await sendJson<SlugReply>("POST", cdRoute(titleId, "slug"), typed ? { slug: typed } : {});
        if (!r.ok) {
          const body = r.body as Refusal & { suggestion?: string | null };
          const reason = refusalWords(r.body, r.status);
          const code = typeof body.code === "string" ? body.code : null;
          setOutcome({ kind: "error", code, suggestion: typeof body.suggestion === "string" ? body.suggestion : null, text: code === "crazydramas_unreachable" || r.status === 0 ? tt("cdp.slug.unreachable", { reason }) : tt("cdp.slug.failed", { reason }) });
          return;
        }
        const reply = r.body;
        setValue(reply.slug);
        setOutcome({ kind: "ok", text: reply.outcome === "linked" ? tt("cdp.slug.linked", { slug: reply.slug, title: reply.series?.title ?? reply.slug }) : reply.outcome === "kept" ? tt("cdp.slug.kept", { slug: reply.slug }) : tt("cdp.slug.saved", { slug: reply.slug }) });
        onSaved(reply);
      } finally {
        setBusy(false);
      }
    },
    [titleId, tt, onSaved]
  );

  // No slug yet: Studio picks one as the section opens (once per mount).
  useEffect(() => {
    if (!auto || slug || started.current) return;
    started.current = true;
    void save(null);
  }, [auto, slug, save]);

  const typed = value.trim();
  const retry = outcome?.kind === "error" && (outcome.code === "crazydramas_unreachable" || outcome.code === null);
  return (
    <div className="field cdp-wide cdp-slug-field" data-slug-state={busy ? "checking" : outcome?.kind ?? (slug ? "set" : "none")}>
      <label className="label" htmlFor={`cdp-slug-${titleId}`}>{tt("cdp.form.slug")}</label>
      {editable ? (
        <>
          <div className="cdp-inline">
            <input
              id={`cdp-slug-${titleId}`}
              className="input"
              name="slug"
              value={value}
              onChange={(e) => {
                setValue(e.target.value.toLowerCase());
                setOutcome(null);
              }}
              spellCheck={false}
              maxLength={80}
              placeholder={busy && !slug ? tt("cdp.slug.picking") : "the-series-title"}
              disabled={busy}
            />
            <button type="button" className="btn btn-outline btn-sm" disabled={busy || !typed || typed === slug} onClick={() => void save(typed)}>
              {busy ? <><span className="spinner" /> {tt("cdp.slug.checking")}</> : tt("cdp.slug.check")}
            </button>
          </div>
          {busy && !slug ? (
            <small className="hint" role="status"><span className="spinner" /> {tt("cdp.slug.picking")}</small>
          ) : outcome?.kind === "ok" ? (
            <small className="cdp-ok" role="status">{outcome.text}</small>
          ) : outcome?.kind === "error" ? (
            <small className="err" role="alert">
              {outcome.text}{" "}
              {outcome.suggestion && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void save(outcome.suggestion)}>{tt("cdp.slug.use", { slug: outcome.suggestion })}</button>
              )}
              {retry && !typed && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void save(null)}>{tt("cdp.slug.retry")}</button>
              )}
              {retry && typed && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void save(typed === slug ? null : typed)}>{tt("cdp.slug.retry")}</button>
              )}
            </small>
          ) : (
            <small className="hint">{tt("cdp.slug.hint")}</small>
          )}
        </>
      ) : (
        <>
          <p className="cdp-slug"><code id={`cdp-slug-${titleId}`}>{slug ?? "—"}</code></p>
          <small className="hint" data-slug-locked="true">{lockedReason ? tt("cdp.slug.lockedBecause", { reason: lockedReason }) : tt("cdp.slug.locked")}</small>
          {restore && (
            <small className="hint" data-slug-restore={restore}>
              {tt("cdp.slug.restoreHint", { slug: restore })}{" "}
              <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => void save(restore)}>{busy ? <><span className="spinner" /> {tt("cdp.slug.checking")}</> : tt("cdp.slug.restore", { slug: restore })}</button>
            </small>
          )}
          {outcome?.kind === "ok" ? <small className="cdp-ok" role="status">{outcome.text}</small> : outcome?.kind === "error" ? <small className="err" role="alert">{outcome.text}</small> : null}
        </>
      )}
    </div>
  );
}
