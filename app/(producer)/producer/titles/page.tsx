import { portalSession, producerLocale } from "@/components/producer/server";
import { BandPill, ScoreDial } from "@/components/producer/research/workspace-ui";
import { fmtCount } from "@/components/producer/research/ui";
import { t } from "@/lib/i18n";
import { ASSESSMENT_VERSION, BAND_ORDER, type Band } from "@/lib/research/assessment";
import { loadWorkspace, type WorkspaceTitle } from "@/lib/research/workspace";
import { campaignWorkflow } from "@/lib/research/workflow";
import { TROPES } from "@/lib/research/taxonomy";
import { IconPlus } from "@/components/producer/icons";
import PerformanceTable, { PERF_SORTS, type PerfSort } from "@/components/producer/analytics/PerformanceTable";
import { getData } from "@/lib/data";
import { parseRange } from "@/lib/analytics/types";

// /producer/titles — My catalog: every title with its US-potential score,
// readiness facts, tests, and the next action. The list a studio with a
// broad catalog actually needs: sortable, filterable by recommendation,
// one line per title, the reasons one click away.

export const dynamic = "force-dynamic";

type Search = { sort?: string; band?: string; q?: string; trope?: string; view?: string; range?: string };
type CatalogView = "launch" | "performance";
type Sort = "score" | "readiness" | "name" | "episodes";

function sortRows(rows: WorkspaceTitle[], sort: Sort): WorkspaceTitle[] {
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
  const ws = await loadWorkspace(session);
  // ?view=performance is the analytics comparison (decision: Title Analytics, 2026-09-08); the launch table is untouched.
  const view: CatalogView = searchParams.view === "performance" ? "performance" : "launch";
  const range = parseRange(searchParams.range);
  const perfSort: PerfSort = PERF_SORTS.includes(searchParams.sort as PerfSort) ? (searchParams.sort as PerfSort) : "revenue";
  const sort: Sort = (["score", "readiness", "name", "episodes"] as Sort[]).includes(searchParams.sort as Sort) ? (searchParams.sort as Sort) : "score";
  const band = BAND_ORDER.includes(searchParams.band as Band) ? (searchParams.band as Band) : null;
  const q = searchParams.q?.trim().toLowerCase() ?? "";
  const trope = TROPES.find((item) => item.id === searchParams.trope);
  const scopeRows = ws.titles.filter((x) => (!trope || x.assessment.tropes.includes(trope.id)) && (!q || x.summary.name_zh.toLowerCase().includes(q) || (x.summary.name_en ?? "").toLowerCase().includes(q)));
  let rows = scopeRows;
  if (band) rows = rows.filter((x) => x.assessment.band === band);
  rows = sortRows(rows, sort);
  const perfRows = view === "performance" ? await getData().listTitlePerformance(session, { range }) : [];
  const href = (patch: Partial<Search>) => {
    const p = new URLSearchParams();
    const current = view === "performance" ? { view, range, sort: perfSort } : { sort };
    for (const [k, v] of Object.entries({ ...current, band: band ?? undefined, q: q || undefined, trope: trope?.id, ...patch })) if (v) p.set(k, String(v));
    const s = p.toString();
    return s ? `/producer/titles?${s}` : "/producer/titles";
  };
  const counts = new Map<Band, number>();
  for (const x of scopeRows) counts.set(x.assessment.band, (counts.get(x.assessment.band) ?? 0) + 1);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t(locale, "ws.catalog.title")}</h1>
          <p className="page-sub">{t(locale, "ws.catalog.sub")}</p>
        </div>
        <span className="rs-tool-row">
          <a className="btn btn-outline" href="/producer/company?tab=reports">{t(locale, "research.reports.title")}</a>
          <a className="btn btn-primary" href="/producer/titles/new"><IconPlus /> {t(locale, "research.nav.addTitle")}</a>
        </span>
      </div>

      <nav className="tabs rs-tabs cc-view-switch" aria-label={t(locale, "an.catalog.views")}>
        <a className={`tab${view === "launch" ? " on" : ""}`} aria-current={view === "launch" ? "page" : undefined} href={href({ view: undefined, range: undefined, sort: "score" })}>{t(locale, "an.catalog.viewLaunch")}</a>
        <a className={`tab${view === "performance" ? " on" : ""}`} aria-current={view === "performance" ? "page" : undefined} href={href({ view: "performance", range, sort: "revenue" })}>{t(locale, "an.catalog.viewPerformance")}</a>
      </nav>

      <form className="ps-catalog-filters" action="/producer/titles" method="get" role="search" aria-label={t(locale, "ws.catalog.title")}>
        <div className="ps-catalog-search">
        <input className="input" type="search" name="q" defaultValue={q} placeholder={t(locale, "redesign.catalog.search")} aria-label={t(locale, "redesign.catalog.search")} />
        {view === "performance" ? (
          <select className="select" name="sort" defaultValue={perfSort} aria-label={t(locale, "ws.catalog.sort")}>
            {PERF_SORTS.map((s) => <option key={s} value={s}>{t(locale, "ws.catalog.sort")}: {t(locale, `an.catalog.sort.${s}`)}</option>)}
          </select>
        ) : (
          <select className="select" name="sort" defaultValue={sort} aria-label={t(locale, "ws.catalog.sort")}>
            {(["score", "readiness", "name", "episodes"] as Sort[]).map((s) => <option key={s} value={s}>{t(locale, "ws.catalog.sort")}: {t(locale, `ws.catalog.sort.${s}`)}</option>)}
          </select>
        )}
        {view === "performance" && <input type="hidden" name="view" value="performance" />}
        {view === "performance" && <input type="hidden" name="range" value={range} />}
        <input type="hidden" name="band" value={band ?? ""} />
        {trope && <input type="hidden" name="trope" value={trope.id} />}
        <button className="btn btn-outline btn-sm" type="submit">{t(locale, "research.search.go")}</button>
        </div>
        <div className="filter-row">
          <span className="rs-toolbar-label">{t(locale, "ws.catalog.band")}</span>
          <a className={`filter-chip${!band ? " on" : ""}`} aria-current={!band ? "true" : undefined} href={href({ band: undefined })}>{t(locale, "ws.catalog.allBands")} <span className="n">{scopeRows.length}</span></a>
          {BAND_ORDER.map((b) => <a key={b} className={`filter-chip${band === b ? " on" : ""}`} aria-current={band === b ? "true" : undefined} href={href({ band: b })}>{t(locale, `ws.band.${b}`)} <span className="n">{counts.get(b) ?? 0}</span></a>)}
        </div>
        {trope && <div className="cc-active-scope"><span>{t(locale, "catalogRefinement.tropeScope", { trope: trope[locale] })}</span><a href={href({ trope: undefined })}>{t(locale, "catalogRefinement.removeTrope")}</a></div>}
      </form>
      <div className="rs-meta">
        <span>{t(locale, "ws.catalog.count", { n: rows.length })}</span>
        <span>{t(locale, "ws.score.note", { version: ASSESSMENT_VERSION })}</span>
        {ws.truncated && <span className="ev ev-inferred">{t(locale, "research.mine.truncated", { shown: ws.titles.length, total: ws.total })}</span>}
      </div>

      {view === "performance" && rows.length > 0 ? (
        <PerformanceTable rows={rows.map((x) => x.summary.id)} perf={perfRows} range={range} sort={perfSort} locale={locale} hrefFor={(r) => href({ view: "performance", range: r })} />
      ) : rows.length === 0 ? (
        <section className="rs-panel ps-catalog-empty">
          <h2>{t(locale, ws.titles.length ? "redesign.catalog.noMatches" : "redesign.catalog.start")}</h2>
          <p>{t(locale, ws.titles.length ? "redesign.catalog.resetHelp" : "ws.catalog.empty")}</p>
          <a className="btn btn-primary" href={ws.titles.length ? "/producer/titles" : "/producer/titles/new"}>{t(locale, ws.titles.length ? "research.filter.reset" : "research.nav.addTitle")}</a>
        </section>
      ) : (
        <section className="ps-catalog cc-catalog">
          <table className="ps-catalog-table" role="table">
            <caption className="sr-only">{t(locale, "ws.catalog.sub")}</caption>
            <thead role="rowgroup"><tr role="row">
              <th scope="col">{t(locale, "ws.catalog.col.title")}</th>
              <th scope="col">{t(locale, "ws.catalog.col.score")}</th>
              <th scope="col">{t(locale, "redesign.catalog.materials")}</th>
              <th scope="col">{t(locale, "catalogRefinement.campaigns")}</th>
              <th scope="col">{t(locale, "ws.catalog.col.next")}</th>
            </tr></thead>
            <tbody role="rowgroup">
            {rows.map((x) => {
              const a = x.assessment;
              const f = x.facts;
              const primary = locale === "en" ? x.summary.name_en || x.summary.name_zh : x.summary.name_zh;
              const secondary = locale === "en" ? (x.summary.name_en ? x.summary.name_zh : null) : x.summary.name_en;
              const detailHref = `/producer/titles/${x.summary.id}/potential`;
              const campaign = [...x.campaigns].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
              const flow = campaign ? campaignWorkflow(campaign, x.results) : null;
              const chinaViews = (x.detail?.title.china_metrics as { views?: number } | null)?.views;
              return (
                <tr key={x.summary.id} role="row">
                  <th className="ps-catalog-identity" scope="row" role="rowheader">
                    <a className="ps-catalog-name" href={detailHref} lang={locale === "en" && x.summary.name_en ? "en" : "zh-CN"}>{primary}</a>
                    {secondary && <span className="ps-catalog-secondary" lang={locale === "en" ? "zh-CN" : "en"}>{secondary}</span>}
                    <span className="ps-catalog-titlemeta">{x.summary.episode_count} {t(locale, "research.col.episodes")}</span>
                    <a className="cc-evidence" href={detailHref}>{t(locale, "catalogRefinement.evidence")} →</a>
                    {chinaViews != null && <span className="cc-china">{t(locale, "redesign.catalog.chinaViews", { n: fmtCount(chinaViews) })}</span>}
                  </th>
                  <td className="cc-score" role="cell" data-label={t(locale, "ws.catalog.col.score")}><ScoreDial score={a.score} band={a.band} locale={locale} size="sm" /><BandPill band={a.band} locale={locale} /></td>
                  <td role="cell" data-label={t(locale, "redesign.catalog.materials")}><dl className="ps-catalog-facts">
                    <div><dt>{t(locale, "ws.catalog.col.rights")}</dt><dd className={f.rights === "outside" ? "delta-down" : ""}>{t(locale, `ws.catalog.rights.${f.rights}`)}</dd></div>
                    <div><dt>{t(locale, "ws.catalog.col.subs")}</dt><dd>{f.approved_episodes > 0 ? t(locale, "ws.catalog.subs.approved", { n: f.approved_episodes }) : x.summary.percent_adapted > 0 ? t(locale, "redesign.catalog.partialSubs", { pct: x.summary.percent_adapted }) : t(locale, "ws.catalog.subs.none")}</dd></div>
                    <div><dt>{t(locale, "ws.catalog.col.video")}</dt><dd>{f.episodes_with_video > 0 ? t(locale, "ws.catalog.video.n", { n: f.episodes_with_video }) : t(locale, "ws.catalog.video.none")}</dd></div>
                  </dl></td>
                  <td className="cc-campaigns" role="cell" data-label={t(locale, "catalogRefinement.campaigns")}>
                    <span className="ps-catalog-testcount">{t(locale, x.campaigns.length === 1 ? "catalogRefinement.campaignOne" : "catalogRefinement.campaignCount", { n: x.campaigns.length })}</span>
                    {flow ? <a className="cc-workflow" href={flow.href}>{t(locale, `workflow.step.${flow.step}`)}</a> : <span className="ps-catalog-secondary">{t(locale, "ws.catalog.tests.none")}</span>}
                    <span className="ps-catalog-secondary">{t(locale, x.results.length ? "redesign.catalog.resultsAvailable" : "redesign.catalog.noResults")}</span>
                    {x.results.some(r => r.source === "demo") && <span className="state state-unavailable">{t(locale, "ws.state.demo")}</span>}
                  </td>
                  <td className="cc-next" role="cell" data-label={t(locale, "ws.catalog.col.next")}>
                    {!flow && <p className="ps-catalog-next">{a.next[0] ? t(locale, a.next[0]) : t(locale, "ws.actions.assess")}</p>}
                    <a className="btn btn-outline btn-sm" href={flow?.href ?? detailHref} aria-label={`${t(locale, flow?.action ?? "ws.actions.assess")}: ${primary}`}>{t(locale, flow?.action ?? "ws.actions.assess")} →</a>
                    {flow?.waiting && <span className="ps-catalog-secondary">{t(locale, flow.hint)}</span>}
                  </td>
                </tr>
              );
            })}
            </tbody>
          </table>
          <div className="rs-panel-foot">{t(locale, "ws.catalog.chinaNote")}</div>
        </section>
      )}
    </>
  );
}
