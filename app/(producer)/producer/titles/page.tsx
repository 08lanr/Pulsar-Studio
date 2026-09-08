import { portalSession, producerLocale } from "@/components/producer/server";
import { BandPill, ScoreDial } from "@/components/producer/research/workspace-ui";
import { TropeChip, fmtCount } from "@/components/producer/research/ui";
import { t } from "@/lib/i18n";
import { ASSESSMENT_VERSION, BAND_ORDER, type Band } from "@/lib/research/assessment";
import { loadWorkspace, type WorkspaceTitle } from "@/lib/research/workspace";
import { IconPlus } from "@/components/producer/icons";

// /producer/titles — My catalog: every title with its US-potential score,
// readiness facts, tests, and the next action. The list a studio with a
// broad catalog actually needs: sortable, filterable by recommendation,
// one line per title, the reasons one click away.

export const dynamic = "force-dynamic";

type Search = { sort?: string; band?: string; q?: string };
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
  const sort: Sort = (["score", "readiness", "name", "episodes"] as Sort[]).includes(searchParams.sort as Sort) ? (searchParams.sort as Sort) : "score";
  const band = BAND_ORDER.includes(searchParams.band as Band) ? (searchParams.band as Band) : null;
  const q = searchParams.q?.trim().toLowerCase() ?? "";
  let rows = ws.titles;
  if (band) rows = rows.filter((x) => x.assessment.band === band);
  if (q) rows = rows.filter((x) => x.summary.name_zh.toLowerCase().includes(q) || (x.summary.name_en ?? "").toLowerCase().includes(q));
  rows = sortRows(rows, sort);
  const href = (patch: Partial<Search>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ sort, band: band ?? undefined, q: q || undefined, ...patch })) if (v) p.set(k, String(v));
    const s = p.toString();
    return s ? `/producer/titles?${s}` : "/producer/titles";
  };
  const counts = new Map<Band, number>();
  for (const x of ws.titles) counts.set(x.assessment.band, (counts.get(x.assessment.band) ?? 0) + 1);

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

      <form className="ps-catalog-filters" action="/producer/titles" method="get" role="search" aria-label={t(locale, "ws.catalog.title")}>
        <div className="ps-catalog-search">
        <input className="input" type="search" name="q" defaultValue={q} placeholder={t(locale, "redesign.catalog.search")} aria-label={t(locale, "redesign.catalog.search")} />
        <select className="select" name="sort" defaultValue={sort} aria-label={t(locale, "ws.catalog.sort")}>
          {(["score", "readiness", "name", "episodes"] as Sort[]).map((s) => <option key={s} value={s}>{t(locale, "ws.catalog.sort")}: {t(locale, `ws.catalog.sort.${s}`)}</option>)}
        </select>
        <input type="hidden" name="band" value={band ?? ""} />
        <button className="btn btn-outline btn-sm" type="submit">{t(locale, "research.search.go")}</button>
        </div>
        <div className="filter-row">
          <span className="rs-toolbar-label">{t(locale, "ws.catalog.band")}</span>
          <a className={`filter-chip${!band ? " on" : ""}`} aria-current={!band ? "true" : undefined} href={href({ band: undefined })}>{t(locale, "ws.catalog.allBands")} <span className="n">{ws.titles.length}</span></a>
          {BAND_ORDER.map((b) => <a key={b} className={`filter-chip${band === b ? " on" : ""}`} aria-current={band === b ? "true" : undefined} href={href({ band: b })}>{t(locale, `ws.band.${b}`)} <span className="n">{counts.get(b) ?? 0}</span></a>)}
        </div>
      </form>
      <div className="rs-meta">
        <span>{t(locale, "ws.catalog.count", { n: rows.length })}</span>
        <span>{t(locale, "ws.score.note", { version: ASSESSMENT_VERSION })}</span>
        {ws.truncated && <span className="ev ev-inferred">{t(locale, "research.mine.truncated", { shown: ws.titles.length, total: ws.total })}</span>}
      </div>

      {rows.length === 0 ? (
        <section className="rs-panel ps-catalog-empty">
          <h2>{t(locale, ws.titles.length ? "redesign.catalog.noMatches" : "redesign.catalog.start")}</h2>
          <p>{t(locale, ws.titles.length ? "redesign.catalog.resetHelp" : "ws.catalog.empty")}</p>
          <a className="btn btn-primary" href={ws.titles.length ? "/producer/titles" : "/producer/titles/new"}>{t(locale, ws.titles.length ? "research.filter.reset" : "research.nav.addTitle")}</a>
        </section>
      ) : (
        <section className="ps-catalog">
          <table className="ps-catalog-table" role="table">
            <caption className="sr-only">{t(locale, "ws.catalog.sub")}</caption>
            <thead role="rowgroup"><tr role="row">
              <th scope="col">{t(locale, "ws.catalog.col.title")}</th>
              <th scope="col">{t(locale, "ws.catalog.col.score")}</th>
              <th scope="col">{t(locale, "redesign.catalog.materials")}</th>
              <th scope="col">{t(locale, "ws.catalog.col.tests")}</th>
              <th scope="col">{t(locale, "ws.catalog.col.next")}</th>
            </tr></thead>
            <tbody role="rowgroup">
            {rows.map((x) => {
              const a = x.assessment;
              const f = x.facts;
              const primary = locale === "en" ? x.summary.name_en || x.summary.name_zh : x.summary.name_zh;
              const secondary = locale === "en" ? (x.summary.name_en ? x.summary.name_zh : null) : x.summary.name_en;
              const detailHref = `/producer/titles/${x.summary.id}/potential`;
              const chinaViews = (x.detail?.title.china_metrics as { views?: number } | null)?.views;
              return (
                <tr key={x.summary.id} role="row">
                  <th className="ps-catalog-identity" scope="row" role="rowheader">
                    <a className="ps-catalog-name" href={detailHref} lang={locale === "en" && x.summary.name_en ? "en" : "zh-CN"}>{primary}</a>
                    {secondary && <span className="ps-catalog-secondary" lang={locale === "en" ? "zh-CN" : "en"}>{secondary}</span>}
                    <span className="ps-catalog-titlemeta"><BandPill band={a.band} locale={locale} /><span>{x.summary.episode_count} {t(locale, "research.col.episodes")}</span></span>
                    <details className="ps-catalog-details"><summary>{t(locale, "redesign.catalog.storyEvidence")}</summary>
                      <div className="rs-tropes">{a.tropes.map((id) => <TropeChip key={id} id={id} locale={locale} evidence="inferred" />)}</div>
                      <dl className="ps-catalog-facts">{a.components.map(c => <div key={c.key}><dt>{t(locale, `ws.component.${c.key}`)}</dt><dd>{c.points}/{c.max}</dd></div>)}</dl>
                      {chinaViews != null && <p>{t(locale, "redesign.catalog.chinaViews", { n: fmtCount(chinaViews) })}</p>}
                    </details>
                  </th>
                  <td role="cell" data-label={t(locale, "ws.catalog.col.score")}><ScoreDial score={a.score} band={a.band} locale={locale} size="sm" /></td>
                  <td role="cell" data-label={t(locale, "redesign.catalog.materials")}><dl className="ps-catalog-facts">
                    <div><dt>{t(locale, "ws.catalog.col.rights")}</dt><dd className={f.rights === "outside" ? "delta-down" : ""}>{t(locale, `ws.catalog.rights.${f.rights}`)}</dd></div>
                    <div><dt>{t(locale, "ws.catalog.col.subs")}</dt><dd>{f.approved_episodes > 0 ? t(locale, "ws.catalog.subs.approved", { n: f.approved_episodes }) : x.summary.percent_adapted > 0 ? t(locale, "redesign.catalog.partialSubs", { pct: x.summary.percent_adapted }) : t(locale, "ws.catalog.subs.none")}</dd></div>
                    <div><dt>{t(locale, "ws.catalog.col.video")}</dt><dd>{f.episodes_with_video > 0 ? t(locale, "ws.catalog.video.n", { n: f.episodes_with_video }) : t(locale, "ws.catalog.video.none")}</dd></div>
                  </dl></td>
                  <td role="cell" data-label={t(locale, "ws.catalog.col.tests")}><span className="ps-catalog-testcount">{x.campaigns.length}</span><span className="ps-catalog-secondary">{t(locale, x.results.length ? "redesign.catalog.resultsAvailable" : "redesign.catalog.noResults")}</span>{x.results.some(r => r.source === "demo") && <span className="state state-unavailable">{t(locale, "ws.state.demo")}</span>}</td>
                  <td role="cell" data-label={t(locale, "ws.catalog.col.next")}><p className="ps-catalog-next">{a.next[0] ? t(locale, a.next[0]) : t(locale, "ws.actions.assess")}</p><a className="ps-catalog-action" href={detailHref} aria-label={`${t(locale, "redesign.catalog.review")}: ${primary}`}>{t(locale, "redesign.catalog.review")}</a></td>
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
