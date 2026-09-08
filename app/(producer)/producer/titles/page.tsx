import { portalSession, producerLocale } from "@/components/producer/server";
import { AdChip, PlatformChip, titleName } from "@/components/producer/TitleShell";
import { BandPill, ScoreDial } from "@/components/producer/research/workspace-ui";
import { fmtCount, fmtPct } from "@/components/producer/research/ui";
import { RangeControl, fmtUsd } from "@/components/producer/analytics/bits";
import PerformanceTable, { PERF_SORTS, type PerfSort } from "@/components/producer/analytics/PerformanceTable";
import { IconPlus } from "@/components/producer/icons";
import { getData } from "@/lib/data";
import { t } from "@/lib/i18n";
import { parseRange, type AnalyticsRange, type TitlePerformanceRow } from "@/lib/analytics/types";
import { ASSESSMENT_VERSION, BAND_ORDER, BENCHMARK, type Band } from "@/lib/research/assessment";
import { TROPES } from "@/lib/research/taxonomy";
import { QUICK_FILTERS, adCtr, adSpend, adStatus, matchesQuickFilter, platformStatus, type QuickFilter } from "@/lib/research/title-status";
import { loadWorkspace, type WorkspaceTitle } from "@/lib/research/workspace";
import { campaignWorkflow } from "@/lib/research/workflow";

// /producer/titles — My catalog, the portfolio home (decision 2026-09-09).
// One concise row per title answers: where is it on TikTok, is advertising
// happening, what has it earned, what have we spent, how are the ads doing,
// and where to go next. Two other views keep the cross-title comparisons
// that used to compete for the same screen: the TikTok comparison (viewers,
// conversion, cohort value) and the preparation checklist (US potential,
// rights, subtitles, video). The assessment score is not a headline here.

export const dynamic = "force-dynamic";

type View = "portfolio" | "tiktok" | "preparation";
type Search = { view?: string; filter?: string; sort?: string; band?: string; q?: string; trope?: string; range?: string };
type PrepSort = "score" | "readiness" | "name" | "episodes";
type PfSort = "earnings" | "spend" | "name";

function viewOf(raw: string | undefined): View {
  if (raw === "performance" || raw === "tiktok") return "tiktok";
  if (raw === "launch" || raw === "preparation" || raw === "readiness") return "preparation";
  return "portfolio";
}

function sortPrep(rows: WorkspaceTitle[], sort: PrepSort): WorkspaceTitle[] {
  const readiness = (x: WorkspaceTitle) => x.assessment.components.find((c) => c.key === "readiness")?.points ?? 0;
  return [...rows].sort((a, b) => {
    if (sort === "readiness") return readiness(b) - readiness(a) || b.assessment.score - a.assessment.score;
    if (sort === "name") return a.summary.name_zh.localeCompare(b.summary.name_zh, "zh");
    if (sort === "episodes") return b.summary.episode_count - a.summary.episode_count;
    return b.assessment.score - a.assessment.score;
  });
}

export default async function MyCatalog({ searchParams }: { searchParams: Search }) {
  const session = await portalSession("/producer/titles");
  const locale = producerLocale();
  const data = getData();
  const view = viewOf(searchParams.view);
  const range: AnalyticsRange = parseRange(searchParams.range);
  const [ws, perf] = await Promise.all([loadWorkspace(session), data.listTitlePerformance(session, { range })]);
  const perfById = new Map(perf.map((r) => [r.title_id, r]));
  const q = searchParams.q?.trim().toLowerCase() ?? "";
  const trope = TROPES.find((item) => item.id === searchParams.trope);
  const filter: QuickFilter = QUICK_FILTERS.includes(searchParams.filter as QuickFilter) ? (searchParams.filter as QuickFilter) : "all";
  const band = BAND_ORDER.includes(searchParams.band as Band) ? (searchParams.band as Band) : null;
  const prepSort: PrepSort = (["score", "readiness", "name", "episodes"] as PrepSort[]).includes(searchParams.sort as PrepSort) ? (searchParams.sort as PrepSort) : "score";
  const perfSort: PerfSort = PERF_SORTS.includes(searchParams.sort as PerfSort) ? (searchParams.sort as PerfSort) : "revenue";
  const pfSort: PfSort = (["earnings", "spend", "name"] as PfSort[]).includes(searchParams.sort as PfSort) ? (searchParams.sort as PfSort) : "earnings";

  // Rows carry both statuses; every view filters on the same search and story scope.
  const all = ws.titles.map((x) => {
    const tiktok = perfById.get(x.summary.id) ?? null;
    return { x, tiktok, platform: platformStatus(tiktok?.analytics_state), ads: adStatus(x.campaigns, x.results), spend: adSpend(x.results), ctr: adCtr(x.results) };
  });
  const scoped = all.filter(({ x }) => (!trope || x.assessment.tropes.includes(trope.id)) && (!q || x.summary.name_zh.toLowerCase().includes(q) || (x.summary.name_en ?? "").toLowerCase().includes(q)));
  const quickCounts = Object.fromEntries(QUICK_FILTERS.map((f) => [f, scoped.filter((r) => matchesQuickFilter(f, r.platform, r.ads.status)).length])) as Record<QuickFilter, number>;
  let rows = scoped.filter((r) => matchesQuickFilter(filter, r.platform, r.ads.status));
  if (view === "preparation" && band) rows = rows.filter((r) => r.x.assessment.band === band);

  const href = (patch: Partial<Search>) => {
    const p = new URLSearchParams();
    const current: Partial<Search> = { view: view === "portfolio" ? undefined : view, filter: filter === "all" ? undefined : filter, q: q || undefined, trope: trope?.id, sort: searchParams.sort, band: band ?? undefined, range: searchParams.range };
    for (const [k, v] of Object.entries({ ...current, ...patch })) if (v) p.set(k, String(v));
    const s = p.toString();
    return s ? `/producer/titles?${s}` : "/producer/titles";
  };

  // Portfolio ordering; titles without a value sort last.
  const val = (n: number | null | undefined) => (n == null ? -Infinity : n);
  const earnings = (r: TitlePerformanceRow | null) => (r && r.revenue.value != null ? r.revenue.value : null);
  const portfolio = [...rows].sort((a, b) => {
    if (pfSort === "name") return a.x.summary.name_zh.localeCompare(b.x.summary.name_zh, "zh");
    if (pfSort === "spend") return val(b.spend) - val(a.spend) || val(earnings(b.tiktok)) - val(earnings(a.tiktok));
    return val(earnings(b.tiktok)) - val(earnings(a.tiktok)) || val(b.spend) - val(a.spend) || a.x.summary.name_zh.localeCompare(b.x.summary.name_zh, "zh");
  });
  const anyGross = portfolio.some((r) => r.tiktok?.revenue.basis === "iap_gross" && r.tiktok.revenue.value != null);
  const anyDemo = portfolio.some((r) => r.tiktok?.source === "demo" || r.x.results.some((res) => res.source === "demo"));
  const benchCtr = (BENCHMARK.ctr * 100).toFixed(1);

  const emptyState = (
    <section className="pf-table-wrap pf-empty ps-catalog-empty">
      <h2>{t(locale, ws.titles.length ? "redesign.catalog.noMatches" : "redesign.catalog.start")}</h2>
      <p>{t(locale, ws.titles.length ? "redesign.catalog.resetHelp" : "ws.catalog.empty")}</p>
      <a className="btn btn-primary" href={ws.titles.length ? "/producer/titles" : "/producer/titles/new"}>{t(locale, ws.titles.length ? "pf.reset" : "research.nav.addTitle")}</a>
    </section>
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t(locale, "pf.title")}</h1>
          <p className="page-sub">{t(locale, "pf.sub")}</p>
        </div>
        <span className="rs-tool-row">
          <a className="btn btn-outline" href="/producer/company?tab=reports">{t(locale, "research.reports.title")}</a>
          <a className="btn btn-primary" href="/producer/titles/new"><IconPlus /> {t(locale, "research.nav.addTitle")}</a>
        </span>
      </div>

      <nav className="pf-views" aria-label={t(locale, "pf.views")}>
        {(["portfolio", "tiktok", "preparation"] as View[]).map((v) => (
          <a key={v} href={href({ view: v === "portfolio" ? undefined : v, sort: undefined, band: undefined })} aria-current={v === view ? "page" : undefined}>{t(locale, `pf.view.${v}`)}</a>
        ))}
      </nav>

      <div className="pf-filters">
        <form action="/producer/titles" method="get" role="search" aria-label={t(locale, "pf.title")}>
          <input className="input" type="search" name="q" defaultValue={q} placeholder={t(locale, "redesign.catalog.search")} aria-label={t(locale, "redesign.catalog.search")} />
          {view === "portfolio" && (
            <select className="select" name="sort" defaultValue={pfSort} aria-label={t(locale, "ws.catalog.sort")}>
              {(["earnings", "spend", "name"] as PfSort[]).map((s) => <option key={s} value={s}>{t(locale, "ws.catalog.sort")}: {t(locale, `pf.sort.${s}`)}</option>)}
            </select>
          )}
          {view === "tiktok" && (
            <select className="select" name="sort" defaultValue={perfSort} aria-label={t(locale, "ws.catalog.sort")}>
              {PERF_SORTS.map((s) => <option key={s} value={s}>{t(locale, "ws.catalog.sort")}: {t(locale, `an.catalog.sort.${s}`)}</option>)}
            </select>
          )}
          {view === "preparation" && (
            <select className="select" name="sort" defaultValue={prepSort} aria-label={t(locale, "ws.catalog.sort")}>
              {(["score", "readiness", "name", "episodes"] as PrepSort[]).map((s) => <option key={s} value={s}>{t(locale, "ws.catalog.sort")}: {t(locale, `ws.catalog.sort.${s}`)}</option>)}
            </select>
          )}
          {view !== "portfolio" && <input type="hidden" name="view" value={view} />}
          {filter !== "all" && <input type="hidden" name="filter" value={filter} />}
          {searchParams.range && <input type="hidden" name="range" value={range} />}
          {band && <input type="hidden" name="band" value={band} />}
          {trope && <input type="hidden" name="trope" value={trope.id} />}
          <button className="btn btn-outline btn-sm" type="submit">{t(locale, "research.search.go")}</button>
        </form>
        <div className="pf-quick" role="group" aria-label={t(locale, "pf.quick.all")}>
          {QUICK_FILTERS.map((f) => <a key={f} className={`filter-chip${filter === f ? " on" : ""}`} aria-current={filter === f ? "true" : undefined} href={href({ filter: f === "all" ? undefined : f })}>{t(locale, `pf.quick.${f}`)} <span className="n">{quickCounts[f]}</span></a>)}
        </div>
        {view === "preparation" && (
          <div className="pf-quick" role="group" aria-label={t(locale, "ws.catalog.band")}>
            {BAND_ORDER.map((b) => <a key={b} className={`filter-chip${band === b ? " on" : ""}`} aria-current={band === b ? "true" : undefined} href={href({ band: band === b ? undefined : b })}>{t(locale, `ws.band.${b}`)}</a>)}
          </div>
        )}
        {(view === "portfolio" || view === "tiktok") && <RangeControl range={range} hrefFor={(r) => href({ range: r })} locale={locale} />}
      </div>
      {trope && <div className="cc-active-scope"><span>{t(locale, "catalogRefinement.tropeScope", { trope: trope[locale] })}</span><a href={href({ trope: undefined })}>{t(locale, "catalogRefinement.removeTrope")}</a></div>}
      <p className="pf-legend">{t(locale, "pf.legend")} {ws.truncated && <span className="ev ev-inferred">{t(locale, "research.mine.truncated", { shown: ws.titles.length, total: ws.total })}</span>}</p>

      {rows.length === 0 ? emptyState : view === "tiktok" ? (
        <PerformanceTable rows={rows.map((r) => r.x.summary.id)} perf={perf} range={range} sort={perfSort} locale={locale} hrefFor={(r) => href({ range: r })} />
      ) : view === "preparation" ? (
        <section className="ps-catalog cc-catalog">
          <table className="ps-catalog-table" role="table">
            <caption className="sr-only">{t(locale, "pf.view.preparation")}</caption>
            <thead role="rowgroup"><tr role="row">
              <th scope="col">{t(locale, "pf.col.title")}</th>
              <th scope="col">{t(locale, "ws.catalog.col.score")}</th>
              <th scope="col">{t(locale, "redesign.catalog.materials")}</th>
              <th scope="col">{t(locale, "ws.catalog.col.next")}</th>
            </tr></thead>
            <tbody role="rowgroup">
              {sortPrep(rows.map((r) => r.x), prepSort).map((x) => {
                const a = x.assessment;
                const f = x.facts;
                const { primary, secondary, lang } = titleName(locale, x.summary.name_zh, x.summary.name_en);
                const prepHref = `/producer/titles/${x.summary.id}/preparation`;
                const chinaViews = (x.detail?.title.china_metrics as { views?: number } | null)?.views;
                return (
                  <tr key={x.summary.id} role="row">
                    <th className="ps-catalog-identity" scope="row" role="rowheader">
                      <a className="ps-catalog-name" href={`/producer/titles/${x.summary.id}`} lang={lang}>{primary}</a>
                      {secondary && <span className="ps-catalog-secondary" lang={lang === "en" ? "zh-CN" : "en"}>{secondary}</span>}
                      <span className="ps-catalog-titlemeta">{x.summary.episode_count} {t(locale, "research.col.episodes")}</span>
                      {chinaViews != null && <span className="cc-china">{t(locale, "redesign.catalog.chinaViews", { n: fmtCount(chinaViews) })}</span>}
                    </th>
                    <td className="cc-score" role="cell" data-label={t(locale, "ws.catalog.col.score")}><ScoreDial score={a.score} band={a.band} locale={locale} size="sm" /><BandPill band={a.band} locale={locale} /><a className="cc-evidence" href={prepHref}>{t(locale, "catalogRefinement.evidence")} →</a></td>
                    <td role="cell" data-label={t(locale, "redesign.catalog.materials")}><dl className="ps-catalog-facts">
                      <div><dt>{t(locale, "ws.catalog.col.rights")}</dt><dd className={f.rights === "outside" ? "delta-down" : ""}>{t(locale, `ws.catalog.rights.${f.rights}`)}</dd></div>
                      <div><dt>{t(locale, "ws.catalog.col.subs")}</dt><dd>{f.approved_episodes > 0 ? t(locale, "ws.catalog.subs.approved", { n: f.approved_episodes }) : x.summary.percent_adapted > 0 ? t(locale, "redesign.catalog.partialSubs", { pct: x.summary.percent_adapted }) : t(locale, "ws.catalog.subs.none")}</dd></div>
                      <div><dt>{t(locale, "ws.catalog.col.video")}</dt><dd>{f.episodes_with_video > 0 ? t(locale, "ws.catalog.video.n", { n: f.episodes_with_video }) : t(locale, "ws.catalog.video.none")}</dd></div>
                    </dl></td>
                    <td className="cc-next" role="cell" data-label={t(locale, "ws.catalog.col.next")}>
                      <p className="ps-catalog-next">{a.next[0] ? t(locale, a.next[0]) : t(locale, "tw.prep.checklist")}</p>
                      <a className="btn btn-outline btn-sm" href={prepHref}>{t(locale, "tw.nav.preparation")} →</a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="rs-panel-foot">{t(locale, "ws.score.note", { version: ASSESSMENT_VERSION })} · {t(locale, "ws.catalog.chinaNote")}</div>
        </section>
      ) : (
        <div className="pf-table-wrap">
          <table className="pf-table">
            <caption className="sr-only">{t(locale, "pf.sub")}</caption>
            <thead><tr>
              <th scope="col">{t(locale, "pf.col.title")}</th>
              <th scope="col">{t(locale, "pf.col.platform")}</th>
              <th scope="col">{t(locale, "pf.col.ads")}</th>
              <th scope="col" className="pf-num">{t(locale, "pf.col.earnings")}<small>{t(locale, "an.basis.publisher_earnings")} · USD · {t(locale, `an.range.${range}`)}</small></th>
              <th scope="col" className="pf-num">{t(locale, "pf.col.spend")}<small>USD · {t(locale, "pf.toDate")}</small></th>
              <th scope="col" className="pf-num">{t(locale, "pf.col.ctr")}<small>{t(locale, "pf.ctrBench", { n: benchCtr })} · {t(locale, "pf.toDate")}</small></th>
              <th scope="col" />
            </tr></thead>
            <tbody>
              {portfolio.map(({ x, tiktok, platform, ads, spend, ctr }) => {
                const { primary, secondary, lang } = titleName(locale, x.summary.name_zh, x.summary.name_en);
                const open = `/producer/titles/${x.summary.id}`;
                const rev = tiktok?.revenue ?? null;
                const step = ads.flow ? t(locale, `workflow.step.${ads.flow.step}`) : null;
                const budget = ads.campaign?.experiment?.budget_usd ?? null;
                return (
                  <tr key={x.summary.id}>
                    <th scope="row" className="pf-title"><a href={open} lang={lang}>{primary}</a>{secondary && <small lang={lang === "en" ? "zh-CN" : "en"}>{secondary}</small>}</th>
                    <td><PlatformChip status={platform} locale={locale} /></td>
                    <td><AdChip status={ads.status} locale={locale} step={step} /></td>
                    <td className="pf-num">{rev && rev.value != null ? <><b>{fmtUsd(rev.value, 0)}</b>{rev.basis === "iap_gross" && <span className="pf-basis" title={t(locale, "pf.basisGrossNote")}>{t(locale, "pf.basisGross")}</span>}{tiktok?.freshness.data_through && <small>{t(locale, "an.dataThrough", { date: tiktok.freshness.data_through, lag: tiktok.freshness.lag_days ?? 0 })}</small>}</> : <span className="pf-missing">{t(locale, rev?.reason ?? "an.reason.needsLink")}</span>}</td>
                    <td className="pf-num">{spend != null ? <><b>{fmtUsd(spend, 0)}</b><small>{t(locale, "tw.ads.roundN", { n: ads.rounds })}</small></> : budget != null ? <><span className="pf-missing">–</span><small>{fmtUsd(budget, 0)} {t(locale, ads.campaign?.experiment?.approved_at ? "workflow.budgetApproved" : "workflow.budgetUnapproved").toLowerCase()}</small></> : <span className="pf-missing">–</span>}</td>
                    <td className="pf-num">{ctr ? <><b className={ctr.ctr >= BENCHMARK.ctr ? "delta-up" : "delta-down"}>{fmtPct(ctr.ctr, 2)}</b><small>{ctr.ctr >= BENCHMARK.ctr ? "✓" : "✗"} {fmtCount(ctr.clicks)} / {fmtCount(ctr.impressions)}</small></> : <span className="pf-missing">{t(locale, ads.status === "none" ? "tw.ads.none" : "tw.ads.noResults")}</span>}</td>
                    <td className="pf-num"><a className="btn btn-outline btn-sm" href={ads.flow && !ads.flow.waiting ? ads.flow.href : open} aria-label={`${t(locale, "pf.col.open")}: ${primary}`}>{ads.flow && !ads.flow.waiting ? t(locale, ads.flow.action) : t(locale, "pf.col.open")} →</a></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="pf-foot">
            <span>{t(locale, "pf.count", { n: portfolio.length })}</span>
            {anyGross && <span>{t(locale, "pf.basisGrossNote")}</span>}
            {anyDemo && <span>{t(locale, "pf.demoNote")}</span>}
          </div>
        </div>
      )}
    </>
  );
}
