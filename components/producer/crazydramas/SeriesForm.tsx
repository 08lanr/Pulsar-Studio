"use client";

// Step 1 of "Upload to crazydramas" (publish spec §1a–b, §4; decision
// 2026-09-23 "Upload automation: poster, slug, series text"): the series
// details, prefilled from the title and its film-meta (or from the draft
// crazydramas already holds), and "Create draft series" / "Save series
// details" — one PUT through Studio's route, which creates the series as a
// draft that Studio manages or updates Studio's own draft.
//
// Studio does the routine steps itself (Ruobin's rule, 2026-09-23):
//   - the slug is picked and checked by Studio (SlugField) and stays
//     editable until the draft series exists, then locked with the reason;
//   - the tagline, description and genres of a title with no series yet are
//     drafted from the film's transcript as the form opens (fields a person
//     already filled are kept), with "Draft again" for a new take;
//   - the poster defaults to the title's cover (PosterField): on Create /
//     Save, Studio stores it in its public poster bucket as a 1200×1600 JPEG,
//     checks it answers, and only then sends poster_url; a picked image goes
//     the same way, a pasted address is checked and sent as it is.
// The IAP id is suggested as `cd.series.<short_name>` and checked against
// the contract's rule as it is typed. A refusal is shown in the words it came
// with (series_title_exists names the series that has the title).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/components/locale";
import {
  IAP_PRODUCT_ID,
  suggestIapProductId,
  type CdSeries,
  type CdSeriesState,
  type FormDefaults,
  type PosterCheckReply,
  type PosterReply,
  type SeriesBody,
  type SeriesReply,
  type SeriesTextReply,
  type SlugReply,
} from "@/lib/crazydramas/publish-types";
import PosterField, { type PosterPick } from "./PosterField";
import { cdRoute, centsFromDollars, dollarsFromCents, refusalWords, sendForm, sendJson } from "./request";
import SlugField from "./SlugField";

type Props = {
  titleId: string;
  seriesState: CdSeriesState;
  defaults: FormDefaults;
  series: CdSeries | null;
  /** The person may act and writes are on; when false the fields stay readable and the button is off. */
  canWrite: boolean;
  /** Studio's own cover of the title (mediaUrl), the poster field's default source and preview. */
  coverUrl: string | null;
  onSaved: (reply: SeriesReply) => void;
  /** The slug changed (picked, typed, linked): the section reads its state again. */
  onSlugSaved?: (reply: SlugReply) => void;
  /** Something on crazydramas changed outside the Save (a Set poster): the section reads its state again. */
  onChanged?: () => void;
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
  };
}

function initialPoster(defaults: FormDefaults, coverUrl: string | null): PosterPick {
  const choice = defaults.poster_default ?? (defaults.poster_url ? "keep" : coverUrl ? "cover" : "none");
  return { choice: choice === "cover" && !coverUrl ? "none" : choice, file: null, url: "" };
}

type PosterState = { url: string; busy: boolean; reply: PosterCheckReply | null; error: string | null };
type TextState = { busy: boolean; line: { text: string; error: boolean } | null };

export default function SeriesForm({ titleId, seriesState, defaults, series, canWrite, coverUrl, onSaved, onSlugSaved, onChanged }: Props) {
  const { tt } = useT();
  const [f, setF] = useState<Fields>(() => initialFields(defaults, series));
  const [busy, setBusy] = useState(false);
  const [busyWhat, setBusyWhat] = useState<"poster" | "series" | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [poster, setPoster] = useState<PosterState>({ url: "", busy: false, reply: null, error: null });
  const [pick, setPick] = useState<PosterPick>(() => initialPoster(defaults, coverUrl));
  const [prepared, setPrepared] = useState<PosterReply["poster"] | null>(null);
  const [text, setText] = useState<TextState>({ busy: false, line: null });
  const creating = seriesState === "not_uploaded" || seriesState === "not_linked";
  const studioSeries = seriesState === "draft" || seriesState === "published";
  const drafted = useRef(false);

  // A series written elsewhere (another tab, the draft just created) re-seeds the fields once its updated_at moves.
  const seriesStamp = series ? `${series.id}:${series.updated_at ?? ""}` : "none";
  useEffect(() => {
    setF(initialFields(defaults, series));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new series version re-seeds; the defaults are the title's
  }, [seriesStamp]);
  // The poster choice follows the series' poster as the section reads it (after a Create, a Save or a Set poster the
  // series has one, and "keep" is the default from then on).
  const posterStamp = `${defaults.poster_default ?? ""}:${defaults.poster_url ?? ""}:${coverUrl ?? ""}`;
  useEffect(() => {
    setPick(initialPoster(defaults, coverUrl));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-seeded only when the poster the section reads changes
  }, [posterStamp]);

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
  const urlTrim = pick.url.trim();
  const posterChecked = poster.reply && poster.url === urlTrim ? poster.reply : null;
  const languages = useMemo(() => (LANGUAGES.includes(f.language) ? LANGUAGES : [f.language, ...LANGUAGES]), [f.language]);

  // ---- the series text Studio drafts ----

  const draftText = useCallback(
    async (again: boolean) => {
      setText({ busy: true, line: null });
      const r = await sendJson<SeriesTextReply>("POST", cdRoute(titleId, "series-text"), again ? { again: true } : {});
      if (!r.ok) {
        setText({ busy: false, line: { text: tt("cdp.text.failed", { reason: refusalWords(r.body, r.status) }), error: true } });
        return;
      }
      const d = r.body;
      if (d.status === "unavailable") {
        setText({ busy: false, line: d.note ? { text: tt("cdp.text.note", { note: d.note }), error: false } : null });
        return;
      }
      // The first draft fills only what is empty (a person's words are kept); Draft again replaces all three.
      setF((x) => ({
        ...x,
        tagline: again || !x.tagline.trim() ? d.tagline ?? x.tagline : x.tagline,
        description: again || !x.description.trim() ? d.description ?? x.description : x.description,
        genre: again || !x.genre.trim() ? (d.genres.length ? d.genres.join(", ") : x.genre) : x.genre,
      }));
      setDone(null);
      setText({ busy: false, line: { text: d.status === "demo" ? tt("cdp.text.demo") : tt("cdp.text.drafted"), error: false } });
    },
    [titleId, tt]
  );

  // A title with no Studio series yet: the draft as the form opens, when its text fields are empty.
  useEffect(() => {
    if (drafted.current || !canWrite || !creating || !slug) return;
    if (f.tagline.trim() && f.description.trim() && f.genre.trim()) return;
    drafted.current = true;
    void draftText(false);
  }, [canWrite, creating, slug, f.tagline, f.description, f.genre, draftText]);

  // ---- the poster ----

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

  /** The chosen poster made ready (stored and checked by Studio; a pasted address checked), optionally set on the series at once. */
  async function preparePoster(apply: false | { confirmLive: boolean }): Promise<{ ok: true; url: string | undefined } | { ok: false; reason: string }> {
    if (pick.choice === "keep" || pick.choice === "none") return { ok: true, url: undefined };
    if (pick.choice === "url" && !apply) {
      if (!urlTrim) return { ok: true, url: undefined };
      const checked = posterChecked ?? (await checkPoster(urlTrim));
      if (!checked?.ok) return { ok: false, reason: checked?.reason ?? tt("cdp.form.poster.noAnswer") };
      return { ok: true, url: urlTrim };
    }
    if (pick.choice === "file" && !pick.file) return { ok: false, reason: tt("cdp.poster.pickFirst") };
    const flags = apply ? { apply: true, confirm_live: apply.confirmLive } : {};
    let r;
    if (pick.choice === "file") {
      const form = new FormData();
      form.set("file", pick.file!);
      if (apply) {
        form.set("apply", "true");
        form.set("confirm_live", apply.confirmLive ? "true" : "false");
      }
      r = await sendForm<PosterReply>(cdRoute(titleId, "poster"), form);
    } else {
      r = await sendJson<PosterReply>("POST", cdRoute(titleId, "poster"), pick.choice === "url" ? { source: "url", url: urlTrim, ...flags } : { source: "cover", ...flags });
    }
    if (!r.ok) return { ok: false, reason: refusalWords(r.body, r.status) };
    setPrepared(r.body.poster);
    return { ok: true, url: r.body.poster.poster_url };
  }

  async function setPosterNow(confirmLive: boolean): Promise<string | null> {
    const r = await preparePoster({ confirmLive });
    if (!r.ok) return r.reason;
    onChanged?.();
    return null;
  }

  // ---- create / save ----

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // While the series text is being drafted the fields are about to change: the series is sent once they have.
    if (!canWrite || busy || text.busy) return;
    setRefusal(null);
    setDone(null);
    if (freeN === null) return setRefusal(tt("cdp.form.free.bad"));
    if (priceBad) return setRefusal(tt("cdp.form.price.bad"));
    setBusy(true);
    try {
      // The poster first: stored in Studio's bucket and checked (or a pasted address checked) before anything is sent.
      setBusyWhat("poster");
      const p = await preparePoster(false);
      if (!p.ok) {
        setRefusal(tt("cdp.poster.notSent", { reason: p.reason }));
        return;
      }
      setBusyWhat("series");
      const body: SeriesBody = {
        title: f.title.trim(),
        tagline: f.tagline.trim() || null,
        description: f.description.trim() || null,
        genre: f.genre.split(/[,，]/).map((g) => g.trim()).filter(Boolean),
        language: f.language,
        free_episode_count: freeN,
        ...(cents !== null ? { series_price_cents: cents } : {}),
        iap_product_id: iapTrim || null,
        ...(p.url !== undefined ? { poster_url: p.url } : {}),
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
      setBusyWhat(null);
    }
  }

  const urlLine = poster.busy && poster.url === urlTrim
    ? <small className="hint" role="status"><span className="spinner" /> {tt("cdp.form.poster.checking")}</small>
    : posterChecked
      ? <small className={posterChecked.ok ? "cdp-ok" : "err"} role="status">{posterChecked.ok ? tt("cdp.form.poster.ok", { type: posterChecked.content_type ?? "image" }) : tt("cdp.form.poster.bad", { reason: posterChecked.reason ?? `HTTP ${posterChecked.status ?? "—"}` })}{posterChecked.fake ? <> · {tt("cdp.form.poster.fake")}</> : null}</small>
      : poster.error && poster.url === urlTrim
        ? <small className="err" role="alert">{poster.error}</small>
        : null;

  return (
    <form className="cdp-form" onSubmit={(e) => void submit(e)} aria-label={tt("cdp.step.series")} noValidate>
      <div className="cdp-fields">
        <SlugField titleId={titleId} slug={slug} editable={defaults.slug_editable === true} auto={false} onSaved={(r) => onSlugSaved?.(r)} />
        <label className="field cdp-wide">
          <span className="label">{tt("cdp.form.title")}</span>
          <input className="input" name="title" lang="en" value={f.title} onChange={set("title")} required maxLength={200} disabled={!canWrite} />
          <small className="hint">{tt("cdp.form.title.hint")}</small>
        </label>
        <div className="field cdp-wide cdp-text-tools">
          <div className="cdp-actions">
            {canWrite && (
              <button type="button" className="btn btn-ghost btn-sm" disabled={text.busy} onClick={() => void draftText(true)}>
                {text.busy ? <><span className="spinner" /> {tt("cdp.text.drafting")}</> : tt("cdp.text.again")}
              </button>
            )}
            {text.line && <small className={text.line.error ? "err" : "hint"} role={text.line.error ? "alert" : "status"} data-series-text>{text.line.text}</small>}
          </div>
        </div>
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
        <PosterField
          titleId={titleId}
          pick={pick}
          onPick={(next) => {
            setPick(next);
            setDone(null);
          }}
          currentPreview={defaults.poster_preview_url ?? null}
          hasCurrent={!!(series?.poster_url ?? defaults.poster_url)}
          coverUrl={defaults.has_cover === false ? null : coverUrl}
          canWrite={canWrite}
          seriesExists={studioSeries}
          seriesLive={seriesState === "published"}
          onSetPoster={setPosterNow}
          prepared={prepared}
          urlLine={urlLine}
          onCheckUrl={() => void checkPoster(urlTrim)}
          checkingUrl={poster.busy}
        />
      </div>
      <div className="cdp-actions">
        <button type="submit" className="btn btn-primary" disabled={!canWrite || busy || text.busy || !f.title.trim() || !slug}>
          {busy ? <><span className="spinner" /> {busyWhat === "poster" ? tt("cdp.poster.preparing") : tt("cdp.form.saving")}</> : tt(creating ? "cdp.form.create" : "cdp.form.save")}
        </button>
        {creating && <small className="hint">{tt("cdp.form.create.hint")}</small>}
        {done && <span className="cdp-ok" role="status">{done}</span>}
      </div>
      {refusal && <p className="note note-warn cdp-refusal" role="alert">{refusal}</p>}
    </form>
  );
}
