import AdsTable, { AdsFilter, type AdsViewRow } from "@/components/admin/cd-stats/AdsTable";
import { KpiCard } from "@/components/admin/cd-stats/Overview";
import type { Session } from "@/lib/auth";
import { fakeAdVideo } from "@/lib/crazydramas/fake-stats";
import { adCreatives, type CreativeClip } from "@/lib/crazydramas/stats-ads";
import {
  adSpans,
  benchmark,
  changeOf,
  creativeRows,
  dailyTotals,
  EARLY_IMPRESSIONS,
  fmtPct,
  numbersIn,
  RATE_KEYS,
  totalsOf,
  versusMedian,
  type CreativeRow,
} from "@/lib/crazydramas/stats-creatives";
import { fmtUsdCents, MIN_COMPARE, type StatsRange } from "@/lib/crazydramas/stats-summary";
import { mediaUrl } from "@/lib/data/storage";
import { t, type Locale } from "@/lib/i18n";
import type { LaunchRun } from "@/lib/launch/types";
import { readTikTokAdVideo, type AdVideoRead } from "@/lib/tiktok/ad-video";

// The Ads tab of /crazydramas/stats (decision 2026-09-28, "Ad video stats"; Ruobin: "lets build those tiktok stats
// into pulsar studio, this seems super useful"): six headline numbers against the period before, with a line of
// their days, then one table, a row per ad creative. TikTok's own numbers (lib/tiktok/ad-video.ts), summed per
// creative by lib/crazydramas/stats-creatives.ts. "All" is each ad's whole life. The crazydramas report is not
// needed here, so the tab still works when crazydramas does not answer.

const n0 = (v: number) => v.toLocaleString("en-US");

/** Two reads as one (the fixture's invented ads laid over the transport's). */
function merge(a: AdVideoRead, b: ReturnType<typeof fakeAdVideo> | null): AdVideoRead {
  if (!b) return a;
  return { covered: [...a.covered, ...b.covered], failed: [...a.failed, ...b.failed], ads: { ...a.ads, ...b.ads }, days: { ...(a.days ?? {}), ...(b.days ?? {}) }, from: a.from, to: a.to };
}

export type AdsTabProps = {
  session: Session;
  locale: Locale;
  range: StatsRange;
  /** The last day of the period (crazydramas' today, else Pacific today). */
  today: string;
  fresh: boolean;
  /** Studio's own launch records (read from TikTok) and, in fixture mode, the invented ones with their numbers. */
  launched: LaunchRun[];
  invented: LaunchRun[] | null;
  clips: Map<string, CreativeClip>;
  titleNames: Map<string, string>;
  filter: { title: string | null; type: string | null };
  vs: string | null;
};

/** The creatives the filter keeps. */
export function filterRows(rows: CreativeRow[], filter: AdsTabProps["filter"]): CreativeRow[] {
  return rows.filter((r) => (!filter.title || r.title_id === filter.title) && (!filter.type || (filter.type === "none" ? !r.ad_format : r.ad_format === filter.type)));
}

export default async function AdsTab(p: AdsTabProps) {
  const tt = (k: string, v?: Record<string, string | number>) => t(p.locale, k, v);
  const spans = adSpans(p.range, p.today);
  const runs = p.invented ? [...p.launched, ...p.invented] : p.launched;
  const [lifeRead, daysRead] = await Promise.all([
    p.range === "all" ? readTikTokAdVideo(p.launched, "lifetime", { fresh: p.fresh }) : Promise.resolve(null),
    readTikTokAdVideo(p.launched, spans.read, { fresh: p.fresh }),
  ]);
  const life = lifeRead ? merge(lifeRead, p.invented ? fakeAdVideo("lifetime") : null) : null;
  const days = merge(daysRead, p.invented ? fakeAdVideo(spans.read) : null);
  const failed = [...new Map([...(life?.failed ?? []), ...days.failed].map((f) => [f.advertiser_id, f])).values()];

  const creatives = adCreatives(runs, p.clips);
  const numbers = life ? life.ads : numbersIn(days.days ?? {}, days.covered, spans.span!);
  const every = creativeRows(creatives, numbers);
  const all = filterRows(every, p.filter);
  const titleOptions = [...new Set(every.map((r) => r.title_id).filter((id): id is string => !!id))]
    .map((id) => ({ id, name: p.titleNames.get(id) ?? id }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const typeOptions = [...new Set(every.map((r) => r.ad_format ?? "none"))].sort((a, b) => Number(a === "none") - Number(b === "none") || a.localeCompare(b));
  const shown = all.filter((r) => r.sums.impressions !== 0);
  const hidden = all.length - shown.length;
  const before = spans.prev ? filterRows(creativeRows(creatives, numbersIn(days.days ?? {}, days.covered, spans.prev)), p.filter) : null;

  const now = totalsOf(shown);
  const prev = before ? totalsOf(before) : null;
  const ads = shown.flatMap((r) => r.ad_ids);
  const line = dailyTotals(days.days ?? {}, ads, spans.chart);
  const rateChange = (k: "ctr" | "hold_6s") => (prev && (prev.sums.impressions ?? 0) >= EARLY_IMPRESSIONS ? changeOf(now.rates[k], prev.rates[k]) : null);
  const unread = now.unknown ? tt("cda.unread", { n: now.unknown }) : null;

  const bench = benchmark(shown);
  const viewRows: AdsViewRow[] = shown.map((r) => ({
    key: r.key,
    title: (r.title_id && p.titleNames.get(r.title_id)) || tt("cda.noTitle"),
    ad_format: r.ad_format,
    words: r.text ?? r.file_name ?? (r.kind === "spark" ? tt("cda.spark") : r.kind === "tiktok_post" ? tt("cda.post") : r.key),
    sub: [r.ad_ids.length === 1 && r.launches === 1 ? tt("cda.runs1") : tt("cda.runs", { ads: r.ad_ids.length, launches: r.launches }), r.file_name ?? (r.kind === "spark" ? r.key.slice(0, 12) : null)].filter(Boolean).join(" · "),
    media_url: r.file_path ? mediaUrl(r.file_path) : null,
    early: r.early,
    spend_cents: r.sums.spend_cents,
    impressions: r.sums.impressions,
    checkouts: r.sums.conversions,
    rates: r.rates,
    marks: Object.fromEntries(RATE_KEYS.map((k) => [k, versusMedian(r.rates[k], bench.rates[k], k, r.early)]).filter(([, m]) => m)),
  }));

  return (
    <>
      <AdsFilter range={p.range} value={p.filter} titles={titleOptions} types={typeOptions} />
      {failed.map((f) => (
        <p key={f.advertiser_id} className="note note-warn" role="alert">
          {tt("cda.failed", { id: f.advertiser_id, error: f.error })}
        </p>
      ))}
      <div className="cdx-kpis" data-testid="ads-kpis">
        <KpiCard label={tt("cda.spend")} info={tt("cda.spendInfo")} value={now.sums.spend_cents === null ? "–" : fmtUsdCents(now.sums.spend_cents)} sub={unread} change={changeOf(now.sums.spend_cents, prev?.sums.spend_cents ?? null, 1000)} vs={p.vs} upIsGood={false} spark={line.map((d) => d.sums.spend_cents ?? 0)} />
        <KpiCard label={tt("cda.impressions")} info={tt("cda.impressionsInfo")} value={now.sums.impressions === null ? "–" : n0(now.sums.impressions)} change={changeOf(now.sums.impressions, prev?.sums.impressions ?? null, EARLY_IMPRESSIONS)} vs={p.vs} spark={line.map((d) => d.sums.impressions ?? 0)} />
        <KpiCard label={tt("cda.ctr")} info={tt("cda.ctrInfo")} value={fmtPct(now.rates.ctr)} change={rateChange("ctr")} vs={p.vs} spark={line.map((d) => d.rates.ctr ?? 0)} />
        <KpiCard label={tt("cda.hold6")} info={tt("cda.hold6Info")} value={fmtPct(now.rates.hold_6s)} change={rateChange("hold_6s")} vs={p.vs} spark={line.map((d) => d.rates.hold_6s ?? 0)} />
        <KpiCard label={tt("cda.checkouts")} info={tt("cda.checkoutsInfo")} value={now.sums.conversions === null ? "–" : n0(now.sums.conversions)} change={changeOf(now.sums.conversions, prev?.sums.conversions ?? null, MIN_COMPARE)} vs={p.vs} spark={line.map((d) => d.sums.conversions ?? 0)} />
        <KpiCard
          label={tt("cda.perCheckout")}
          info={tt("cda.perCheckoutInfo")}
          value={now.rates.cost_per_checkout_cents === null ? "–" : fmtUsdCents(now.rates.cost_per_checkout_cents)}
          change={prev && (prev.sums.conversions ?? 0) >= MIN_COMPARE ? changeOf(now.rates.cost_per_checkout_cents, prev.rates.cost_per_checkout_cents) : null}
          vs={p.vs}
          upIsGood={false}
        />
      </div>
      <section className="rs-panel cdx-card">
        <div className="cdx-card-head">
          <h2>{tt("cda.table")}</h2>
          <span className="cdx-muted">{tt(p.range === "all" ? "cda.tableSub" : "cda.tableSubPeriod", { n: shown.length })}</span>
        </div>
        {shown.length ? <AdsTable rows={viewRows} bench={bench} /> : <p className="rs-empty">{tt("cda.none")}</p>}
        {hidden > 0 && <p className="cdx-note">{tt(p.range === "all" ? "cda.hiddenAll" : "cda.hidden", { n: hidden })}</p>}
      </section>
    </>
  );
}
