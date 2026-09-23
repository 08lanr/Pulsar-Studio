"use client";

// The CrazyDramas section of a title (plan A4.2): the series header as
// crazydramas.com shows it (live or not, the title there, the public link,
// the free/paid split, the price, whether an IAP product is set, the poster
// with a placeholder warning), the per-episode table (number, Studio length,
// crazydramas length, verdict, free or paid), the "Checked <time>" line with
// its observed evidence label, and Check now. Everything shown is the
// reading lib/crazydramas/match derives from the newest snapshots; a length
// match proves the same length, never the same file (plan A0). The producer
// page and the staff mirror render this same component.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/components/locale";
import type { CrazydramasStatus } from "@/lib/crazydramas/match";
import { checkedAtText, chipReading, fmtDelta, fmtPriceCents, fmtSeconds, CrazydramasChip, VERDICT_PILL } from "./CrazydramasChip";

type Props = {
  titleId: string;
  status: CrazydramasStatus;
  /** The series' public page (crazydramasPublicUrl on the server), null without a slug. */
  publicUrl: string | null;
  /** The title came from the film workspace (its slug travels in film-meta). */
  imported: boolean;
  /** Whether this session may press Check now; when not, `reason` says why in portal words. */
  canCheck: boolean;
  reason?: "preview" | "readOnly" | null;
};

type CheckReply = { error?: string; code?: string };

export default function CrazydramasPanel({ titleId, status, publicUrl, imported, canCheck, reason = null }: Props) {
  const { tt, locale } = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);

  async function check() {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(`/api/titles/${titleId}/crazydramas/check`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      const body = (await res.json().catch(() => ({}))) as CheckReply;
      if (!res.ok) {
        // The 30-second rule (plan A5): a snapshot younger than that refuses a second read.
        const tooSoon = res.status === 429 || (res.status === 409 && /30/.test(body.error ?? ""));
        setNote({ text: tooSoon ? tt("cd.check.tooSoon") : tt("cd.check.failed", { detail: body.error ?? `HTTP ${res.status}` }), error: true });
        return;
      }
      setNote({ text: tt("cd.check.done"), error: false });
      router.refresh();
    } catch (e) {
      setNote({ text: tt("cd.check.failed", { detail: (e as Error).message }), error: true });
    } finally {
      setBusy(false);
    }
  }

  const series = status.series;
  const checked = checkedAtText(status.checked_at);
  const failedAt = checkedAtText(status.failed_at) ?? "—";
  // The failure sentence ends the note's own way; the transport's message keeps its words, not its full stop.
  const failure = (status.error ?? "—").replace(/[.。]\s*$/, "");
  const episodes = [...status.episodes].sort((a, b) => a.n - b.n);
  const publicHost = publicUrl ? publicUrl.replace(/^https?:\/\//, "") : null;
  const rule = status.frame_rule;

  return (
    <div className="cd-panel" style={{ display: "grid", gap: 16 }}>
      {status.state === "not_linked" && <p className="note note-info">{tt(imported ? "cd.notLinked.note" : "cd.notLinked.notImported")}</p>}
      {status.state === "not_checked" && <p className="note note-info">{tt("cd.notChecked.note")}</p>}
      {status.state === "not_live" && <p className="note note-info">{tt(status.note === "slug_reassigned" ? "cd.slugReassigned.note" : "cd.notLive.note")}</p>}
      {status.state === "read_failed" && <p className="note note-warn">{tt(series ? "cd.readFailed.note" : "cd.readFailed.none", { time: failedAt, error: failure })}</p>}
      {status.state === "live_unverified" && <p className="note note-info">{tt("cd.unverified.note")}</p>}

      <section className="card cd-series" aria-label={tt("cd.title")}>
        <div style={{ display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap" }}>
          <span className="cd-poster" style={{ width: 96, aspectRatio: "3 / 4", borderRadius: 6, overflow: "hidden", background: "var(--surface-3)", flexShrink: 0 }}>
            {/* eslint-disable-next-line @next/next/no-img-element -- the poster as crazydramas.com serves it (in fixture mode the fake's same-origin SVG); a plain <img>, nothing proxied */}
            {series?.poster_url ? <img src={series.poster_url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : null}
          </span>
          <dl className="tw-facts" style={{ flex: "1 1 320px" }}>
            <div>
              <dt>{tt("cd.series.live")}</dt>
              <dd><CrazydramasChip {...chipReading(status)} locale={locale} /></dd>
            </div>
            <div>
              <dt>{tt("cd.series.slug")}</dt>
              <dd>{status.slug ? <code>{status.slug}</code> : "—"}</dd>
            </div>
            <div>
              <dt>{tt("cd.series.title")}</dt>
              <dd lang="en">{series?.title ?? "—"}</dd>
            </div>
            <div>
              <dt>{tt("cd.series.link")}</dt>
              <dd>{publicUrl ? <a href={publicUrl} target="_blank" rel="noreferrer">{publicHost}</a> : "—"}</dd>
            </div>
            <div>
              <dt>{tt("cd.series.counts")}</dt>
              <dd>{series ? tt("cd.series.counts.value", { studio: status.counts.studio, cd: status.counts.live }) : "—"}</dd>
            </div>
            <div>
              <dt>{tt("cd.series.split")}</dt>
              <dd>{status.free_paid ? tt("cd.series.split.value", { free: status.free_paid.free, paid: status.free_paid.paid }) : "—"}</dd>
            </div>
            <div>
              <dt>{tt("cd.series.price")}</dt>
              <dd>{series ? fmtPriceCents(series.series_price_cents) : "—"}</dd>
            </div>
            <div>
              <dt>{tt("cd.series.iap")}</dt>
              <dd>{series ? <><span className={`pill ${series.iap_product_set ? "pill-success" : "pill-warning"}`}>{tt(series.iap_product_set ? "cd.series.iap.set" : "cd.series.iap.unset")}</span>{series.iap_product_id && <small> <code>{series.iap_product_id}</code></small>}</> : "—"}</dd>
            </div>
            <div>
              <dt>{tt("cd.series.poster")}</dt>
              <dd>{series ? (series.poster_url ? (series.poster_placeholder ? <span className="pill pill-warning">{tt("cd.series.poster.placeholderPill")}</span> : <span className="pill pill-success">{tt("cd.series.poster.ok")}</span>) : tt("cd.series.noPoster")) : "—"}</dd>
            </div>
          </dl>
        </div>
        {series?.poster_placeholder && <p className="note note-warn" style={{ marginTop: 12 }}>{tt("cd.series.poster.placeholder")}</p>}
      </section>

      <div className="cd-check" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <span className="cd-checked" role="status">
          {checked ? tt("cd.checked", { time: checked }) : status.failed_at ? tt("cd.checked.failed", { time: failedAt }) : tt("cd.checked.never")}
          {checked && <> <span className="ev ev-observed">{tt("research.evidence.observed")}</span></>}
          {status.stale && <> <span className="pill pill-warning">{tt("cd.chip.stale")}</span></>}
        </span>
        {status.state !== "not_linked" && (
          canCheck ? (
            <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => void check()}>
              {busy ? <><span className="spinner" /> {tt("cd.check.busy")}</> : tt("cd.check")}
            </button>
          ) : reason === "preview" ? (
            // Staff previewing the portal: the staff mirror is the one place they may press Check now, so the note is the way there.
            <span className="hint">{tt("cd.check.preview")} <a href={`/titles/${titleId}/crazydramas`}>{tt("cd.check.preview.link")}&nbsp;→</a></span>
          ) : reason ? (
            <span className="hint">{tt("cd.check.readOnly")}</span>
          ) : null
        )}
        {note && <span className={note.error ? "err" : "hint"} role={note.error ? "alert" : "status"}>{note.text}</span>}
      </div>

      {status.state !== "not_linked" && (
        <section className="pf-table-wrap" aria-label={tt("cd.col.episode")}>
          {episodes.length === 0 ? (
            <p className="hint" style={{ padding: 16 }}>{tt("cd.noEpisodes")}</p>
          ) : (
            <table className="tw-table cd-episodes">
              <thead>
                <tr>
                  <th scope="col">{tt("cd.col.episode")}</th>
                  <th scope="col">{tt("cd.col.studio")}</th>
                  <th scope="col">{tt("cd.col.cd")}</th>
                  <th scope="col">{tt("cd.col.verdict")}</th>
                  <th scope="col">{tt("cd.col.access")}</th>
                </tr>
              </thead>
              <tbody>
                {episodes.map((e) => {
                  const studioSeconds = fmtSeconds(e.studio?.duration_s);
                  const cdSeconds = fmtSeconds(e.live?.duration_s);
                  const delta = fmtDelta(e.d_frames);
                  return (
                    <tr key={e.n} data-episode={e.n} data-verdict={e.verdict}>
                      <th scope="row">{tt("cd.episodeN", { n: e.n })}</th>
                      <td className="tw-num">
                        {e.studio ? (e.studio.frames != null ? tt("cd.frames", { n: e.studio.frames }) : "—") : "—"}
                        {studioSeconds && <small>{tt("cd.seconds", { s: studioSeconds })}{e.studio?.fps ? ` · ${e.studio.fps} fps` : ""}</small>}
                      </td>
                      <td className="tw-num">
                        {cdSeconds ? tt("cd.seconds", { s: cdSeconds }) : "—"}
                        {e.live && e.verdict === "not_ready" && <small>{e.live.status}</small>}
                      </td>
                      <td>
                        <span className={`pill ${VERDICT_PILL[e.verdict]}`}>{tt(`cd.verdict.${e.verdict}`)}</span>
                        {delta && (e.verdict === "close" || e.verdict === "different_length") && <small>{tt("cd.delta", { d: delta })}</small>}
                      </td>
                      <td>{e.paid === null ? "—" : tt(e.paid ? "cd.access.paid" : "cd.access.free")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      )}

      <p className="tw-note">{tt("cd.lengthRule", { offset: rule.offset, film: rule.calibrated_on, files: rule.calibrated_files })}</p>
    </div>
  );
}
