"use client";

// The poster in "Upload to crazydramas" (decision 2026-09-23 "Upload
// automation: poster, slug, series text"). Studio hosts it itself: the
// default is the title's own cover (its preview beside the choice), turned
// into a 1200×1600 portrait JPG in Studio's public poster bucket when the
// series is saved; a person may pick another image instead (sent through
// Studio's route) or paste an address (checked: 200, an image). A series that
// has a poster keeps it unless another choice is made; a title with no cover
// says so and the series is made without one. On a Studio series "Set
// poster" sends the chosen poster at once, alone (a live series asks for a
// confirm first: viewers see it straight away).

import { useEffect, useMemo, useState } from "react";
import { useT } from "@/components/locale";
import type { PosterChoice, PosterReply } from "@/lib/crazydramas/publish-types";

export type PosterPick = { choice: PosterChoice; file: File | null; url: string };

type Props = {
  titleId: string;
  pick: PosterPick;
  onPick: (next: PosterPick) => void;
  /** The series' current poster, as a browser of Studio may load it (null: none, or not loadable here). */
  currentPreview: string | null;
  hasCurrent: boolean;
  /** The title's cover in Studio (mediaUrl), or null when it has none. */
  coverUrl: string | null;
  /** The person may act and writes are on. */
  canWrite: boolean;
  /** The title's Studio series exists (draft or published): "Set poster" applies at once. */
  seriesExists: boolean;
  /** The series is published: Set poster needs the confirm. */
  seriesLive: boolean;
  /** Set the chosen poster on the series now; resolves with the refusal's words, or null when it was set. */
  onSetPoster: (confirmLive: boolean) => Promise<string | null>;
  /** The last poster Studio prepared (its preview), shown after a Set poster or a save. */
  prepared: PosterReply["poster"] | null;
  /** A pasted address's check line (from the form's poster check). */
  urlLine: React.ReactNode;
  onCheckUrl: () => void;
  checkingUrl: boolean;
};

export default function PosterField({ titleId, pick, onPick, currentPreview, hasCurrent, coverUrl, canWrite, seriesExists, seriesLive, onSetPoster, prepared, urlLine, onCheckUrl, checkingUrl }: Props) {
  const { tt } = useT();
  const [setting, setSetting] = useState(false);
  const [confirmLive, setConfirmLive] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const filePreview = useMemo(() => (pick.file ? URL.createObjectURL(pick.file) : null), [pick.file]);
  useEffect(() => () => {
    if (filePreview) URL.revokeObjectURL(filePreview);
  }, [filePreview]);

  const choose = (choice: PosterChoice) => {
    onPick({ ...pick, choice });
    setResult(null);
  };
  const preview = pick.choice === "keep" ? currentPreview : pick.choice === "cover" ? coverUrl : pick.choice === "file" ? filePreview : null;
  // After a save or a Set poster, the poster as Studio made it (1200×1600) while that source is still the one chosen.
  const shown = prepared && prepared.source === pick.choice && prepared.preview_url ? prepared.preview_url : preview;
  const settable = seriesExists && canWrite && (pick.choice === "cover" ? !!coverUrl : pick.choice === "file" ? !!pick.file : pick.choice === "url" ? !!pick.url.trim() : false);

  async function setPoster() {
    setSetting(true);
    setResult(null);
    try {
      const refusal = await onSetPoster(confirmLive);
      setResult(refusal ? { ok: false, text: tt("cdp.poster.failed", { reason: refusal }) } : { ok: true, text: tt("cdp.poster.done") });
    } finally {
      setSetting(false);
    }
  }

  const option = (choice: PosterChoice, label: string, disabled = false) => (
    <label className="cdp-check cdp-poster-choice" data-poster-choice={choice}>
      <input type="radio" name={`cdp-poster-${titleId}`} value={choice} checked={pick.choice === choice} onChange={() => choose(choice)} disabled={!canWrite || disabled} />
      <span>{label}</span>
    </label>
  );

  return (
    <div className="field cdp-wide cdp-poster" data-poster-picked={pick.choice}>
      <span className="label" id={`cdp-poster-label-${titleId}`}>{tt("cdp.form.poster")}</span>
      <div className="cdp-poster-row">
        <div className="cdp-poster-field" role="radiogroup" aria-labelledby={`cdp-poster-label-${titleId}`}>
          {hasCurrent && option("keep", tt("cdp.poster.keep"))}
          {option("cover", coverUrl ? tt("cdp.poster.cover") : tt("cdp.poster.cover.none"), !coverUrl)}
          {option("file", tt("cdp.poster.file"))}
          {pick.choice === "file" && (
            <input className="input cdp-poster-file" type="file" name="poster_file" accept="image/jpeg,image/png,image/webp" disabled={!canWrite} onChange={(e) => onPick({ ...pick, file: e.target.files?.[0] ?? null })} />
          )}
          {option("url", tt("cdp.poster.url"))}
          {pick.choice === "url" && (
            <div className="cdp-inline">
              <input className="input" name="poster_url" type="url" value={pick.url} onChange={(e) => onPick({ ...pick, url: e.target.value })} disabled={!canWrite} spellCheck={false} placeholder="https://…" />
              {canWrite && pick.url.trim() && (
                <button type="button" className="btn btn-outline btn-sm" disabled={checkingUrl} onClick={onCheckUrl}>{tt("cdp.form.poster.check")}</button>
              )}
            </div>
          )}
          {pick.choice === "url" && urlLine}
          {!hasCurrent && option("none", tt("cdp.poster.none"))}
          {!coverUrl && !hasCurrent && pick.choice !== "file" && pick.choice !== "url" && <small className="hint">{tt("cdp.poster.noCover")}</small>}
          {(pick.choice === "cover" || pick.choice === "file") && <small className="hint">{tt("cdp.poster.convert")}</small>}
          {pick.choice !== "url" && <small className="hint">{tt("cdp.form.poster.hint")}</small>}
          {seriesExists && canWrite && pick.choice !== "keep" && pick.choice !== "none" && (
            <div className="cdp-actions">
              {seriesLive && (
                <label className="cdp-check">
                  <input type="checkbox" checked={confirmLive} onChange={(e) => setConfirmLive(e.target.checked)} />
                  <span>{tt("cdp.poster.liveConfirm")}</span>
                </label>
              )}
              <button type="button" className="btn btn-outline btn-sm" disabled={!settable || setting || (seriesLive && !confirmLive)} onClick={() => void setPoster()}>
                {setting ? <><span className="spinner" /> {tt("cdp.poster.setting")}</> : tt("cdp.poster.set")}
              </button>
              {result && <small className={result.ok ? "cdp-ok" : "err"} role={result.ok ? "status" : "alert"}>{result.text}</small>}
            </div>
          )}
        </div>
        <figure className="cdp-cover">
          <span className="cdp-cover-frame">
            {/* eslint-disable-next-line @next/next/no-img-element -- Studio's own cover (/api/media), the picked file (a blob URL) or the bucket's poster; nothing proxied */}
            {shown ? <img src={shown} alt="" /> : null}
          </span>
          <figcaption>
            <small className="hint">
              {pick.choice === "cover" ? (coverUrl ? tt("cdp.form.cover") : tt("cdp.form.cover.none")) : pick.choice === "keep" ? tt("cdp.poster.keep") : pick.choice === "file" && !pick.file ? tt("cdp.poster.pickFirst") : null}
              {prepared?.cropped && prepared.source === pick.choice ? <> · {tt("cdp.poster.cropped")}</> : null}
            </small>
          </figcaption>
        </figure>
      </div>
    </div>
  );
}
