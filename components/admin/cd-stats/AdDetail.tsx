import { FormatPill } from "@/components/admin/cd-stats/Creative";
import Info from "@/components/admin/cd-stats/Info";
import type { AdTypeRow, CompareAd } from "@/lib/crazydramas/stats-ads";
import { fmtUsdCents } from "@/lib/crazydramas/stats-summary";
import type { CdStatsPurchase } from "@/lib/crazydramas/stats-types";
import { t, type Locale } from "@/lib/i18n";

// The Campaigns tab's ad panel and its "By ad type" table (decision 2026-09-26). Ruobin: "I'm not entirely sure
// which one is which (e.g. hook vs narration). I need to see which clip it is so I can recreate more". Server
// components: the exact file that ran, what kind of ad it is, its words and file name, every campaign the same
// clip ran in with its results there, and the buyers it brought.

const n0 = (v: number) => v.toLocaleString("en-US");
const cents = (v: number | null) => (v == null ? "–" : v < 100 ? `${v}¢` : fmtUsdCents(v));

/** Every ad type's totals side by side: spend, clicks, visitors, finishers, buyers, and what each cost. */
export function AdTypeTable({ rows, locale }: { rows: AdTypeRow[]; locale: Locale }) {
  const tt = (k: string, v?: Record<string, string | number>) => t(locale, k, v);
  if (!rows.length) return <p className="cdx-empty">{tt("cdx.empty")}</p>;
  return (
    <div className="an-scroll" tabIndex={0} role="region" aria-label={tt("cdc.types.title")}>
      <table className="an-table cds-table cdx-table">
        <caption className="sr-only">{tt("cdc.types.title")}</caption>
        <thead>
          <tr>
            <th scope="col" />
            <th scope="col" className="gt-num">{tt("cdc.types.ads")}</th>
            <th scope="col" className="gt-num">{tt("cds.ads.col.spend")}</th>
            <th scope="col" className="gt-num">{tt("cds.ads.col.clicks")}</th>
            <th scope="col" className="gt-num">{tt("cdx.kpi.visitors")}</th>
            <th scope="col" className="gt-num">{tt("cdx.kpi.finished")}</th>
            <th scope="col" className="gt-num">{tt("cdx.kpi.buyers")}</th>
            <th scope="col" className="gt-num">{tt("cds.ads.col.perFinisher")}</th>
            <th scope="col" className="gt-num">{tt("cdc.types.perBuyer")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.format}>
              <th scope="row">
                <FormatPill format={r.format === "none" ? null : r.format} tt={tt} />
              </th>
              <td className="gt-num">{n0(r.ads)}</td>
              <td className="gt-num">{r.spend_cents == null ? "–" : fmtUsdCents(r.spend_cents)}</td>
              <td className="gt-num">{r.clicks == null ? "–" : n0(r.clicks)}</td>
              <td className="gt-num">{n0(r.opened)}</td>
              <td className="gt-num">{n0(r.finished_ep1)}</td>
              <td className="gt-num">{n0(r.buyers)}</td>
              <td className="gt-num">{cents(r.cost_per_finisher_cents)}</td>
              <td className="gt-num"><strong>{cents(r.cost_per_buyer_cents)}</strong></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export type AdRun = CompareAd & { launch_name: string; campaign_name: string; href: string };

/** One ad's panel: the video that ran, its type, words and file, each campaign the same clip ran in, and its buyers. */
export function AdDetail({
  ad,
  media,
  runs,
  buyers,
  personHref,
  seriesTitle,
  closeHref,
  locale,
}: {
  ad: CompareAd;
  media: string | null;
  runs: AdRun[];
  buyers: CdStatsPurchase[] | null;
  personHref: (person: string) => string;
  seriesTitle: (id: string | null) => string;
  closeHref: string;
  locale: Locale;
}) {
  const tt = (k: string, v?: Record<string, string | number>) => t(locale, k, v);
  const c = ad.creative;
  const time = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" });
  return (
    <section className="rs-panel cdx-card cdc-detail" aria-labelledby="cdc-detail-title">
      <div className="cdx-card-head">
        <h2 id="cdc-detail-title">{tt("cdc.detail.title")}</h2>
        <a href={closeHref}>← {tt("cdc.detail.back")}</a>
      </div>
      <div className="cdc-detail-top">
        {media ? (
          <video className="cdc-player" src={media} controls playsInline preload="metadata" />
        ) : (
          <div className="cdc-player is-empty">{tt("cdc.detail.noFile")}</div>
        )}
        <dl className="cdc-facts">
          <div>
            <dt>{tt("cdc.detail.type")}</dt>
            <dd><FormatPill format={c?.ad_format ?? null} tt={tt} /></dd>
          </div>
          <div>
            <dt>{tt("cdc.detail.text")}</dt>
            <dd>{c?.text ?? "–"}</dd>
          </div>
          <div>
            <dt>{tt("cdc.detail.file")}</dt>
            <dd><code>{c?.file_name ?? "–"}</code></dd>
          </div>
          <div>
            <dt>{tt("cdc.detail.series")}</dt>
            <dd>{ad.titles.length ? ad.titles.slice(0, 3).join(", ") + (ad.titles.length > 3 ? ` ${tt("cds.ads.moreTitles", { n: ad.titles.length - 3 })}` : "") : "–"}</dd>
          </div>
          <div>
            <dt>{tt("cdc.detail.tiktokId")}</dt>
            <dd className="cdc-id">{ad.ad_id}</dd>
          </div>
        </dl>
      </div>
      <h3 className="cdc-h3">{tt(runs.length === 1 ? "cdc.detail.ranIn1" : "cdc.detail.ranIn", { n: runs.length })}</h3>
      <div className="an-scroll" tabIndex={0} role="region" aria-label={tt("cdc.detail.ranIn", { n: runs.length })}>
        <table className="an-table cds-table cdx-table">
          <thead>
            <tr>
              <th scope="col">{tt("cds.ads.col.campaign")}</th>
              <th scope="col" className="gt-num">{tt("cds.ads.col.spend")}</th>
              <th scope="col" className="gt-num">{tt("cds.ads.col.clicks")}</th>
              <th scope="col" className="gt-num">{tt("cdx.kpi.visitors")}</th>
              <th scope="col" className="gt-num">{tt("cds.col.playedEp1")}</th>
              <th scope="col" className="gt-num">{tt("cds.col.finishedEp1")}</th>
              <th scope="col" className="gt-num">{tt("cds.col.watchedEp", { n: 2 })}</th>
              <th scope="col" className="gt-num">
                {tt("cdc.detail.paid")} <Info text={tt("cdc.col.oursInfo")} label={tt("cdx.about", { what: tt("cdc.detail.paid") })} />
              </th>
              <th scope="col" className="gt-num">{tt("cds.ads.col.perFinisher")}</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.ad_id} className={r.ad_id === ad.ad_id ? "cdc-this" : undefined}>
                <th scope="row" className="cds-title">
                  <a href={r.href}>{r.launch_name}</a>
                  <span className="cds-sub">{r.campaign_name} · {tt("cdc.ad.id", { id: r.ad_id })}</span>
                </th>
                <td className="gt-num">{r.spend_cents == null ? "–" : fmtUsdCents(r.spend_cents)}</td>
                <td className="gt-num">{r.clicks == null ? "–" : n0(r.clicks)}</td>
                <td className="gt-num">{n0(r.opened)}</td>
                <td className="gt-num">{n0(r.started_ep1)}</td>
                <td className="gt-num">{n0(r.finished_ep1)}</td>
                <td className="gt-num">{n0(r.watched_ep2)}</td>
                <td className="gt-num">{n0(r.ours.people)}</td>
                <td className="gt-num">{cents(r.cost_per_finisher_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3 className="cdc-h3">{tt("cdc.detail.buyers")}</h3>
      {buyers === null ? (
        <p className="cdx-empty">{tt("cdb.none")}</p>
      ) : buyers.length === 0 ? (
        <p className="cdx-empty">{tt("cdc.detail.noBuyers")}</p>
      ) : (
        <ul className="cdx-list">
          {buyers.map((p) => (
            <li key={p.id}>
              <span>
                <a href={personHref(p.person)}><code>{p.person}</code></a> · {seriesTitle(p.drama_id)} · <span className="cdx-muted">{time(p.at)}</span>
              </span>
              <strong>{fmtUsdCents(p.amount_cents)}</strong>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
