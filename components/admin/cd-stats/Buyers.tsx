import { Thumb } from "@/components/admin/cd-stats/Creative";
import type { AdCreative } from "@/lib/crazydramas/stats-ads";
import { fmtDuration, timelineRows, type Person, type TimelineRow } from "@/lib/crazydramas/stats-buyers";
import { countryName, fmtUsdCents, regionName } from "@/lib/crazydramas/stats-summary";
import type { CdStatsPurchase } from "@/lib/crazydramas/stats-types";
import { t, type Locale } from "@/lib/i18n";

// The Buyers tab (decision 2026-09-26). Ruobin: "I dont know if the 6 buyers are different for the same people
// ... perhaps i can click on buyers? see where they came from?" Every payment, newest first, under the buyer's
// person code (one code across their browsers); a click opens that person: where they first came from, their
// phone and place, how long they took to pay, what they spent, and their way through the site as a timeline.
// Server components.

const TZ = "America/Los_Angeles";
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: TZ });
const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ });

/** What names a campaign, an ad and a series on these screens. */
export type Names = {
  campaign: (id: string) => string;
  ad: (id: string) => AdCreative | null;
  media: (ad: AdCreative | null) => string | null;
  adHref: (id: string) => string;
  series: (id: string | null) => string;
};

/** Where a landing came from, in words: the campaign and its ad's words, TikTok with no campaign tag, TikTok's stored copy, or the platform. */
function sourceWords(src: { platform: string; campaign: string | null; ad: string | null; stored_copy?: boolean } | null, names: Names, tt: (k: string, v?: Record<string, string | number>) => string): { head: string; ad: AdCreative | null; adId: string | null } {
  if (!src) return { head: tt("cdb.src.unknown"), ad: null, adId: null };
  if (src.stored_copy) return { head: tt("cds.ads.storedCopy"), ad: null, adId: null };
  if (src.campaign || src.ad) return { head: src.campaign ? names.campaign(src.campaign) : tt("cdb.src.tiktok"), ad: src.ad ? names.ad(src.ad) : null, adId: src.ad };
  if (src.platform === "tiktok") return { head: tt("cdb.src.untagged"), ad: null, adId: null };
  return { head: tt(`cdb.src.${src.platform === "direct" ? "direct" : "other"}`, { platform: src.platform }), ad: null, adId: null };
}

function SourceCell({ src, names, locale }: { src: CdStatsPurchase["source"]; names: Names; locale: Locale }) {
  const tt = (k: string, v?: Record<string, string | number>) => t(locale, k, v);
  const w = sourceWords(src, names, tt);
  return (
    <span className="cdb-src">
      {w.adId && <Thumb src={names.media(w.ad)} className="cdc-thumb cdc-thumb-sm" />}
      <span>
        <span className="cdb-src-head">{w.head}</span>
        {w.adId && (
          <a className="cds-sub" href={names.adHref(w.adId)}>
            {w.ad?.text ?? tt("cdc.ad.id", { id: w.adId })}
          </a>
        )}
      </span>
    </span>
  );
}

/** Every payment of the period, newest first. */
export function BuyersTable({ list, browsers, names, personHref, current, locale }: { list: CdStatsPurchase[]; browsers: Map<string, number>; names: Names; personHref: (p: string) => string; current: string | null; locale: Locale }) {
  const tt = (k: string, v?: Record<string, string | number>) => t(locale, k, v);
  if (!list.length) return <p className="cdx-empty">{tt("cdb.noneInPeriod")}</p>;
  return (
    <div className="an-scroll" tabIndex={0} role="region" aria-label={tt("cdb.list")}>
      <table className="an-table cds-table cdb-table">
        <caption className="sr-only">{tt("cdb.list")}</caption>
        <thead>
          <tr>
            <th scope="col">{tt("cdb.col.time")}</th>
            <th scope="col">{tt("cdb.col.person")}</th>
            <th scope="col">{tt("cdb.col.series")}</th>
            <th scope="col" className="gt-num">{tt("cdb.col.amount")}</th>
            <th scope="col">{tt("cdb.col.from")}</th>
            <th scope="col">{tt("cdb.col.phone")}</th>
            <th scope="col">{tt("cdb.col.state")}</th>
          </tr>
        </thead>
        <tbody>
          {list.map((p) => {
            const n = browsers.get(p.person) ?? 1;
            const place = p.source?.country ? (p.source.region ? regionName(p.source.country, p.source.region) : countryName(p.source.country, locale)) : "–";
            return (
              <tr key={p.id} className={p.person === current ? "cdc-this" : undefined}>
                <td className="cdp-nowrap">
                  <a href={personHref(p.person)}>{when(p.at)}</a>
                </td>
                <th scope="row" className="cdp-nowrap">
                  <a href={personHref(p.person)}><code>{p.person}</code></a>
                  {n > 1 && <span className="cdb-badge">{tt("cdb.browsers", { n })}</span>}
                </th>
                <td className="cdb-series">{names.series(p.drama_id)}</td>
                <td className="gt-num">
                  {fmtUsdCents(p.amount_cents)}
                  {p.renewal && <span className="cds-sub">{tt("cdb.renewal")}</span>}
                </td>
                <td><SourceCell src={p.source} names={names} locale={locale} /></td>
                <td className="cdp-nowrap">{p.source ? tt(`cds.dev.${p.source.device}`) : "–"}</td>
                <td className="cdp-nowrap">{place}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TimelineText({ r, names, locale }: { r: TimelineRow; names: Names; locale: Locale }) {
  const tt = (k: string, v?: Record<string, string | number>) => t(locale, k, v);
  const series = names.series(r.drama_id);
  switch (r.kind) {
    case "landing": {
      const w = sourceWords({ platform: r.platform ?? "unknown", campaign: r.campaign, ad: r.ad }, names, tt);
      return (
        <>
          <strong>{tt("cdb.tl.landing", { series })}</strong>
          <span className="cdb-tl-sub">
            {w.head}
            {w.adId && (
              <>
                {" · "}
                <a href={names.adHref(w.adId)}>{w.ad?.text ?? tt("cdc.ad.id", { id: w.adId })}</a>
              </>
            )}
          </span>
        </>
      );
    }
    case "episodes":
      return (
        <>
          <strong>{r.from === r.to ? tt("cdb.tl.episode", { n: r.from }) : tt("cdb.tl.episodes", { from: r.from, to: r.to })}</strong>
          <span className="cdb-tl-sub">{tt("cdb.tl.finished", { n: r.finished, of: r.started })}</span>
        </>
      );
    case "paid":
      return <strong>{tt("cdb.tl.paid", { amount: r.amount_cents === null ? "" : fmtUsdCents(r.amount_cents), n: r.episode ?? "–" })}</strong>;
    default:
      return <strong>{tt(`cdb.tl.${r.kind}`, { n: r.episode ?? "–" })}</strong>;
  }
}

/** One person: the header facts, then their steps as a vertical timeline. */
export function PersonPanel({ person, names, closeHref, locale }: { person: Person; names: Names; closeHref: string; locale: Locale }) {
  const tt = (k: string, v?: Record<string, string | number>) => t(locale, k, v);
  const rows = timelineRows(person.steps);
  const touch = person.first_touch;
  const w = touch ? sourceWords(touch, names, tt) : null;
  const place = person.country ? [person.region ? regionName(person.country, person.region) : null, countryName(person.country, locale)].filter(Boolean).join(", ") : "–";
  let day = "";
  return (
    <section className="rs-panel cdx-card cdb-person" aria-labelledby="cdb-person-title">
      <div className="cdx-card-head">
        <h2 id="cdb-person-title">
          {tt("cdb.person.title")} <code>{person.person}</code>
          {person.browsers > 1 && <span className="cdb-badge">{tt("cdb.browsersLong", { n: person.browsers })}</span>}
        </h2>
        <a href={closeHref}>← {tt("cdb.person.back")}</a>
      </div>
      <dl className="cdb-facts">
        <div className="cdb-fact-wide">
          <dt>{tt("cdb.person.first")}</dt>
          <dd>
            {w ? (
              <span className="cdb-src">
                {w.adId && <Thumb src={names.media(w.ad)} className="cdc-thumb cdc-thumb-sm" />}
                <span>
                  <span className="cdb-src-head">{w.head}</span>
                  {w.adId && <a className="cds-sub" href={names.adHref(w.adId)}>{w.ad?.text ?? tt("cdc.ad.id", { id: w.adId })}</a>}
                </span>
              </span>
            ) : (
              "–"
            )}
          </dd>
        </div>
        <div>
          <dt>{tt("cdb.col.phone")}</dt>
          <dd>{person.device ? tt(`cds.dev.${person.device}`) : "–"}</dd>
        </div>
        <div>
          <dt>{tt("cdb.person.place")}</dt>
          <dd>{place}</dd>
        </div>
        <div>
          <dt>{tt("cdb.person.toPay")}</dt>
          <dd>{fmtDuration(person.to_pay_s)}</dd>
        </div>
        <div>
          <dt>{tt("cdb.person.spent")}</dt>
          <dd>{fmtUsdCents(person.total_cents)}</dd>
        </div>
        <div>
          <dt>{tt("cdb.person.purchases")}</dt>
          <dd>{person.purchases.length}</dd>
        </div>
      </dl>
      {rows.length ? (
        <ol className="cdb-timeline">
          {rows.map((r, i) => {
            const d = new Date(r.at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: TZ });
            const newDay = d !== day;
            day = d;
            return (
              <li key={i} className={`cdb-tl cdb-tl-${r.kind}`}>
                <span className="cdb-tl-time">
                  {newDay && <span className="cdb-tl-day">{d}</span>}
                  {clock(r.at)}
                </span>
                <span className="cdb-tl-dot" aria-hidden />
                <span className="cdb-tl-body">
                  <TimelineText r={r} names={names} locale={locale} />
                  {r.gap_s !== null && r.gap_s >= 60 && <span className="cdb-tl-gap">{tt("cdb.tl.after", { t: fmtDuration(r.gap_s) })}</span>}
                </span>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="cdx-empty">{tt("cdb.person.noSteps")}</p>
      )}
    </section>
  );
}
