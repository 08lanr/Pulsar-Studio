import { portalSession, producerLocale } from "@/components/producer/server";
import PerformanceTable, { PERF_SORTS, type PerfSort } from "@/components/producer/analytics/PerformanceTable";
import { getData } from "@/lib/data";
import { t } from "@/lib/i18n";
import { parseRange } from "@/lib/analytics/types";

// /producer/tiktok — TikTok performance across the catalog (decision
// 2026-09-08, "status board"). Every TikTok number lives here and in the
// per-title TikTok section; advertising numbers live in Ad campaigns. The
// table itself is the former catalog "TikTok comparison" view, unchanged.

export const dynamic = "force-dynamic";

type Search = { q?: string; sort?: string; range?: string };

export default async function TikTokPerformance({ searchParams }: { searchParams: Search }) {
  const session = await portalSession("/producer/tiktok");
  const locale = producerLocale();
  const range = parseRange(searchParams.range);
  const perf = await getData().listTitlePerformance(session, { range });
  const q = searchParams.q?.trim().toLowerCase() ?? "";
  const sort: PerfSort = PERF_SORTS.includes(searchParams.sort as PerfSort) ? (searchParams.sort as PerfSort) : "revenue";
  const rows = perf.filter((r) => !q || r.name_zh.toLowerCase().includes(q) || (r.name_en ?? "").toLowerCase().includes(q)).map((r) => r.title_id);

  const href = (patch: Partial<Search>) => {
    const p = new URLSearchParams();
    const current: Partial<Search> = { q: q || undefined, sort: sort === "revenue" ? undefined : sort, range: searchParams.range };
    for (const [k, v] of Object.entries({ ...current, ...patch })) if (v) p.set(k, String(v));
    const s = p.toString();
    return s ? `/producer/tiktok?${s}` : "/producer/tiktok";
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t(locale, "ws.nav.tiktok")}</h1>
          <p className="page-sub">{t(locale, "pf.tiktok.sub")}</p>
        </div>
      </div>

      <div className="pf-filters">
        <form action="/producer/tiktok" method="get" role="search" aria-label={t(locale, "ws.nav.tiktok")}>
          <input className="input" type="search" name="q" defaultValue={q} placeholder={t(locale, "redesign.catalog.search")} aria-label={t(locale, "redesign.catalog.search")} />
          <select className="select" name="sort" defaultValue={sort} aria-label={t(locale, "ws.catalog.sort")}>
            {PERF_SORTS.map((s) => <option key={s} value={s}>{t(locale, "ws.catalog.sort")}: {t(locale, `an.catalog.sort.${s}`)}</option>)}
          </select>
          {searchParams.range && <input type="hidden" name="range" value={range} />}
          <button className="btn btn-outline btn-sm" type="submit">{t(locale, "research.search.go")}</button>
        </form>
      </div>

      {rows.length === 0 ? (
        <section className="pf-table-wrap pf-empty ps-catalog-empty">
          <h2>{t(locale, perf.length ? "redesign.catalog.noMatches" : "pf.tiktok.empty")}</h2>
          <p>{t(locale, perf.length ? "redesign.catalog.resetHelp" : "pf.tiktok.emptyHint")}</p>
          <a className="btn btn-primary" href={perf.length ? "/producer/tiktok" : "/producer/titles"}>{t(locale, perf.length ? "pf.reset" : "ws.nav.catalog")}</a>
        </section>
      ) : (
        <PerformanceTable rows={rows} perf={perf} range={range} sort={sort} locale={locale} hrefFor={(r) => href({ range: r })} />
      )}
    </>
  );
}
