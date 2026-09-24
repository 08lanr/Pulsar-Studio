"use client";

// Step 1 of "Upload to crazydramas" (publish spec §1a–b, §4): the series
// details, prefilled from the title and its film-meta (or from the draft
// crazydramas already holds), and "Create draft series" / "Save series
// details" — one PUT through Studio's route, which creates the series as a
// draft that Studio manages or updates Studio's own draft. The slug is the
// title's and is never typed here. The IAP id is suggested as
// `cd.series.<short_name>` and checked against the contract's rule as it is
// typed; the poster URL is optional, suggested as the site's own
// /posters/<slug>.jpg, and checked (200, an image) through Studio's
// poster-check route before it is sent; beside it the title's own cover in
// Studio, to hand to Jayden. A refusal is shown in the words it came with
// (series_title_exists names the series that has the title).

import { useEffect, useMemo, useState } from "react";
import { useT } from "@/components/locale";
import {
  IAP_PRODUCT_ID,
  suggestIapProductId,
  type CdSeries,
  type CdSeriesState,
  type FormDefaults,
  type PosterCheckReply,
  type SeriesBody,
  type SeriesReply,
} from "@/lib/crazydramas/publish-types";
import { cdRoute, centsFromDollars, dollarsFromCents, refusalWords, sendJson } from "./request";

type Props = {
  titleId: string;
  seriesState: CdSeriesState;
  defaults: FormDefaults;
  series: CdSeries | null;
  /** The person may act and writes are on; when false the fields stay readable and the button is off. */
  canWrite: boolean;
  /** Studio's own cover of the title (mediaUrl), for the preview beside the poster field. */
  coverUrl: string | null;
  onSaved: (reply: SeriesReply) => void;
};

type Fields = {
  title: string;
  tagline: string;
  description: string;
  genre: string;
  language: string;
  free: string;
  price: string;
  iap: string;
  poster: string;
};

const LANGUAGES = ["en", "zh", "es", "pt", "id", "th", "vi", "ja", "ko", "fr", "de"];

function initialFields(defaults: FormDefaults, series: CdSeries | null): Fields {
  const from = series
    ? {
        title: series.title,
        tagline: series.tagline ?? "",
        description: series.description ?? "",
        genre: series.genre ?? [],
        language: series.language ?? defaults.language,
        free: series.free_episode_count,
        price: series.series_price_cents,
        iap: series.iap_product_id ?? "",
        poster: series.poster_url ?? "",
      }
    : {
        title: defaults.title,
        tagline: defaults.tagline ?? "",
        description: defaults.description ?? "",
        genre: defaults.genre,
        language: defaults.language,
        free: defaults.free_episode_count,
        price: defaults.series_price_cents,
        iap: defaults.iap_product_id ?? "",
        poster: defaults.poster_url ?? "",
      };
  return {
    title: from.title,
    tagline: from.tagline,
    description: from.description,
    genre: from.genre.join(", "),
    language: from.language || "en",
    free: String(from.free),
    price: dollarsFromCents(from.price),
    iap: from.iap,
    poster: from.poster,
  };
}

type PosterState = { url: string; busy: boolean; reply: PosterCheckReply | null; error: string | null };

export default function SeriesForm({ titleId, seriesState, defaults, series, canWrite, coverUrl, onSaved }: Props) {
  const { tt } = useT();
  const [f, setF] = useState<Fields>(() => initialFields(defaults, series));
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [poster, setPoster] = useState<PosterState>({ url: "", busy: false, reply: null, error: null });
  const creating = seriesState === "not_uploaded";

  // A series written elsewhere (another tab, the draft just created) re-seeds the fields once its updated_at moves.
  const seriesStamp = series ? `${series.id}:${series.updated_at ?? ""}` : "none";
  useEffect(() => {
    setF(initialFields(defaults, series));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new series version re-seeds; the defaults are the title's
  }, [seriesStamp]);

  const set = (key: keyof Fields) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const value = e.target.value;
    setF((x) => ({ ...x, [key]: value }));
    setDone(null);
  };

  const slug = series?.slug ?? defaults.slug;
  const iapSuggestion = slug ? suggestIapProductId(slug) : null;
  const iapTrim = f.iap.trim();
  const iapBad = iapTrim !== "" && !IAP_PRODUCT_ID.test(iapTrim);
  const freeN = /^\d{1,3}$/.test(f.free.trim()) ? Number(f.free.trim()) : null;
  const cents = f.price.trim() === "" ? null : centsFromDollars(f.price);
  const priceBad = f.price.trim() !== "" && cents === null;
  const posterTrim = f.poster.trim();
  const posterChecked = poster.reply && poster.url === posterTrim ? poster.reply : null;
  const languages = useMemo(() => (LANGUAGES.includes(f.language) ? LANGUAGES : [f.language, ...LANGUAGES]), [f.language]);

  async function checkPoster(url: string): Promise<PosterCheckReply | null> {
    setPoster({ url, busy: true, reply: null, error: null });
    const r = await sendJson<PosterCheckReply>("POST", cdRoute(titleId, "poster-check"), { url });
    if (!r.ok) {
      const error = refusalWords(r.body, r.status);
      setPoster({ url, busy: false, reply: null, error });
      return null;
    }
    setPoster({ url, busy: false, reply: r.body, error: null });
    return r.body;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canWrite || busy) return;
    setRefusal(null);
    setDone(null);
    if (freeN === null) return setRefusal(tt("cdp.form.free.bad"));
    if (priceBad) return setRefusal(tt("cdp.form.price.bad"));
    setBusy(true);
    try {
      // The poster is sent only once it answers 200 with an image (spec §4).
      if (posterTrim) {
        const checked = posterChecked ?? (await checkPoster(posterTrim));
        if (!checked?.ok) {
          setRefusal(tt("cdp.form.poster.notSent", { reason: checked?.reason ?? tt("cdp.form.poster.noAnswer") }));
          return;
        }
      }
      const body: SeriesBody = {
        title: f.title.trim(),
        tagline: f.tagline.trim() || null,
        description: f.description.trim() || null,
        genre: f.genre.split(/[,，]/).map((g) => g.trim()).filter(Boolean),
        language: f.language,
        free_episode_count: freeN,
        ...(cents !== null ? { series_price_cents: cents } : {}),
        iap_product_id: iapTrim || null,
        poster_url: posterTrim || null,
      };
      const r = await sendJson<SeriesReply>("PUT", cdRoute(titleId, "series"), body);
      if (!r.ok) {
        setRefusal(refusalWords(r.body, r.status));
        return;
      }
      setDone(tt(creating ? "cdp.form.created" : "cdp.form.saved"));
      onSaved(r.body);
    } finally {
      setBusy(false);
    }
  }

  const posterLine = poster.busy && poster.url === posterTrim
    ? <small className="hint" role="status"><span className="spinner" /> {tt("cdp.form.poster.checking")}</small>
    : posterChecked
      ? <small className={posterChecked.ok ? "cdp-ok" : "err"} role="status">{posterChecked.ok ? tt("cdp.form.poster.ok", { type: posterChecked.content_type ?? "image" }) : tt("cdp.form.poster.bad", { reason: posterChecked.reason ?? `HTTP ${posterChecked.status ?? "—"}` })}{posterChecked.fake ? <> · {tt("cdp.form.poster.fake")}</> : null}</small>
      : poster.error && poster.url === posterTrim
        ? <small className="err" role="alert">{poster.error}</small>
        : <small className="hint">{tt("cdp.form.poster.hint")}</small>;

  return (
    <form className="cdp-form" onSubmit={(e) => void submit(e)} aria-label={tt("cdp.step.series")} noValidate>
      <p className="hint cdp-slug">{slug ? <>{tt("cdp.form.slug")} <code>{slug}</code></> : tt("cdp.form.noSlug")}</p>
      <div className="cdp-fields">
        <label className="field cdp-wide">
          <span className="label">{tt("cdp.form.title")}</span>
          <input className="input" name="title" lang="en" value={f.title} onChange={set("title")} required maxLength={200} disabled={!canWrite} />
          <small className="hint">{tt("cdp.form.title.hint")}</small>
        </label>
        <label className="field cdp-wide">
          <span className="label">{tt("cdp.form.tagline")}</span>
          <input className="input" name="tagline" lang="en" value={f.tagline} onChange={set("tagline")} maxLength={300} disabled={!canWrite} />
        </label>
        <label className="field cdp-wide">
          <span className="label">{tt("cdp.form.description")}</span>
          <textarea className="textarea" name="description" lang="en" rows={3} value={f.description} onChange={set("description")} maxLength={5000} disabled={!canWrite} />
        </label>
        <label className="field">
          <span className="label">{tt("cdp.form.genre")}</span>
          <input className="input" name="genre" lang="en" value={f.genre} onChange={set("genre")} disabled={!canWrite} />
          <small className="hint">{tt("cdp.form.genre.hint")}</small>
        </label>
        <label className="field">
          <span className="label">{tt("cdp.form.language")}</span>
          <select className="select" name="language" value={f.language} onChange={set("language")} disabled={!canWrite}>
            {languages.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="label">{tt("cdp.form.free")}</span>
          <input className="input" name="free_episode_count" inputMode="numeric" value={f.free} onChange={set("free")} disabled={!canWrite} aria-invalid={freeN === null} />
          <small className="hint">{tt("cdp.form.free.hint")}</small>
        </label>
        <label className="field">
          <span className="label">{tt("cdp.form.price")}</span>
          <input className="input" name="series_price" inputMode="decimal" value={f.price} onChange={set("price")} disabled={!canWrite} aria-invalid={priceBad} />
          <small className={priceBad ? "err" : "hint"}>{priceBad ? tt("cdp.form.price.bad") : tt("cdp.form.price.hint")}</small>
        </label>
        <div className="field cdp-wide">
          <label className="label" htmlFor={`cdp-iap-${titleId}`}>{tt("cdp.form.iap")}</label>
          <div className="cdp-inline">
            <input id={`cdp-iap-${titleId}`} className="input" name="iap_product_id" value={f.iap} onChange={set("iap")} disabled={!canWrite} aria-invalid={iapBad} spellCheck={false} />
            {canWrite && iapSuggestion && iapSuggestion !== iapTrim && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setF((x) => ({ ...x, iap: iapSuggestion }))}>{tt("cdp.form.iap.use", { id: iapSuggestion })}</button>
            )}
          </div>
          <small className={iapBad ? "err" : "hint"} role={iapBad ? "alert" : undefined}>{iapBad ? tt("cdp.form.iap.bad") : tt("cdp.form.iap.hint")}</small>
        </div>
        <div className="field cdp-wide">
          <label className="label" htmlFor={`cdp-poster-${titleId}`}>{tt("cdp.form.poster")}</label>
          <div className="cdp-poster-row">
            <div className="cdp-poster-field">
              <div className="cdp-inline">
                <input id={`cdp-poster-${titleId}`} className="input" name="poster_url" type="url" value={f.poster} onChange={set("poster")} disabled={!canWrite} spellCheck={false} placeholder="https://crazydramas.com/posters/…" />
                {canWrite && posterTrim && (
                  <button type="button" className="btn btn-outline btn-sm" disabled={poster.busy} onClick={() => void checkPoster(posterTrim)}>{tt("cdp.form.poster.check")}</button>
                )}
              </div>
              {posterLine}
            </div>
            <figure className="cdp-cover">
              <span className="cdp-cover-frame">
                {/* eslint-disable-next-line @next/next/no-img-element -- Studio's own cover through /api/media with the session cookie, not proxied */}
                {coverUrl ? <img src={coverUrl} alt="" /> : null}
              </span>
              <figcaption>
                <small className="hint">{coverUrl ? tt("cdp.form.cover", { slug: slug ?? "…" }) : tt("cdp.form.cover.none")}</small>
                {coverUrl && <a className="pf-cell-link" href={coverUrl} download>{tt("cdp.form.cover.download")}&nbsp;→</a>}
              </figcaption>
            </figure>
          </div>
        </div>
      </div>
      <div className="cdp-actions">
        <button type="submit" className="btn btn-primary" disabled={!canWrite || busy || !f.title.trim() || !slug}>
          {busy ? <><span className="spinner" /> {tt("cdp.form.saving")}</> : tt(creating ? "cdp.form.create" : "cdp.form.save")}
        </button>
        {creating && <small className="hint">{tt("cdp.form.create.hint")}</small>}
        {done && <span className="cdp-ok" role="status">{done}</span>}
      </div>
      {refusal && <p className="note note-warn cdp-refusal" role="alert">{refusal}</p>}
    </form>
  );
}
