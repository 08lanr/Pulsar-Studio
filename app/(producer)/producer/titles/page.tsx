import { portalSession, producerLocale } from "@/components/producer/server";
import { BandPill, ComponentBars, ScoreDial } from "@/components/producer/research/workspace-ui";
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
          <span className="page-kicker">{t(locale, "ws.nav.catalog")}</span>
          <h2>{t(locale, "ws.catalog.title")}</h2>
          <p className="page-sub">{t(locale, "ws.catalog.sub")}</p>
        </div>
        <span className="rs-tool-row">
          <a className="btn btn-outline" href="/producer/reports">{t(locale, "research.reports.title")}</a>
          <a className="btn btn-primary" href="/producer/titles/new"><IconPlus /> {t(locale, "research.nav.addTitle")}</a>
        </span>
      </div>

      <form className="rs-toolbar" action="/producer/titles" method="get">
        <input className="input" type="search" name="q" defaultValue={q} placeholder={t(locale, "research.search.placeholder")} style={{ maxWidth: 260 }} aria-label={t(locale, "research.search.go")} />
        <select className="select" name="sort" defaultValue={sort} aria-label={t(locale, "ws.catalog.sort")}>
          {(["score", "readiness", "name", "episodes"] as Sort[]).map((s) => <option key={s} value={s}>{t(locale, "ws.catalog.sort")}: {t(locale, `ws.catalog.sort.${s}`)}</option>)}
        </select>
        <input type="hidden" name="band" value={band ?? ""} />
        <button className="btn btn-outline btn-sm" type="submit">{t(locale, "research.search.go")}</button>
        <div className="filter-row">
          <span className="rs-toolbar-label">{t(locale, "ws.catalog.band")}</span>
          <a className={`filter-chip${!band ? " on" : ""}`} href={href({ band: undefined })}>{t(locale, "ws.catalog.allBands")} <span className="n">{ws.titles.length}</span></a>
          {BAND_ORDER.map((b) => <a key={b} className={`filter-chip${band === b ? " on" : ""}`} href={href({ band: b })}>{t(locale, `ws.band.${b}`)} <span className="n">{counts.get(b) ?? 0}</span></a>)}
        </div>
      </form>
      <div className="rs-meta">
        <span>{t(locale, "ws.catalog.count", { n: rows.length })}</span>
        <span>{t(locale, "ws.score.note", { version: ASSESSMENT_VERSION })}</span>
        {ws.truncated && <span className="ev ev-inferred">{t(locale, "research.mine.truncated", { shown: ws.titles.length, total: ws.total })}</span>}
      </div>

      {rows.length === 0 ? (
        <section className="rs-panel"><div className="rs-empty">{t(locale, "ws.catalog.empty")}</div></section>
      ) : (
        <section className="rs-panel">
          <div className="gtable gtable-flush rs-table ws-catalog" style={{ ["--cols" as string]: "64px minmax(0,2.4fr) minmax(0,1.8fr) 120px 90px 90px 70px 80px minmax(0,1.6fr)" }}>
            <div className="gt-head">
              <span>{t(locale, "ws.catalog.col.score")}</span>
              <span>{t(locale, "ws.catalog.col.title")}</span>
              <span>{t(locale, "ws.catalog.col.tropes")}</span>
              <span>{t(locale, "ws.catalog.col.readiness")}</span>
              <span>{t(locale, "ws.catalog.col.rights")}</span>
              <span>{t(locale, "ws.catalog.col.subs")}</span>
              <span>{t(locale, "ws.catalog.col.video")}</span>
              <span>{t(locale, "ws.catalog.col.tests")}</span>
              <span>{t(locale, "ws.catalog.col.next")}</span>
            </div>
            {rows.map((x) => {
              const a = x.assessment;
              const f = x.facts;
              return (
                <a className="gt-row" key={x.summary.id} href={`/producer/titles/${x.summary.id}/potential`}>
                  <span><ScoreDial score={a.score} band={a.band} locale={locale} size="sm" /></span>
                  <span style={{ minWidth: 0 }}>
                    <span className="rs-title-name bilingual" lang="zh-CN">{x.summary.name_zh}</span>
                    <span className="rs-title-sub" lang="en">{x.summary.name_en ?? ""} · {x.summary.episode_count} {t(locale, "research.col.episodes")}{x.detail?.title.china_metrics && (x.detail.title.china_metrics as { views?: number }).views ? ` · CN ${fmtCount((x.detail.title.china_metrics as { views?: number }).views)}` : ""}</span>
                    <span style={{ marginTop: 4, display: "block" }}><BandPill band={a.band} locale={locale} /></span>
                  </span>
                  <span className="rs-tropes clip">{a.tropes.slice(0, 3).map((id) => <TropeChip key={id} id={id} locale={locale} evidence="inferred" />)}</span>
                  <span><ComponentBars a={a} locale={locale} /></span>
                  <span className={f.rights === "outside" ? "delta-down" : f.rights === "expiring" ? "gt-muted" : ""}>{t(locale, `ws.catalog.rights.${f.rights}`)}</span>
                  <span>{f.approved_episodes > 0 ? t(locale, "ws.catalog.subs.approved", { n: f.approved_episodes }) : x.summary.percent_adapted > 0 ? t(locale, "ws.catalog.subs.partial", { pct: x.summary.percent_adapted }) : <span className="gt-muted">{t(locale, "ws.catalog.subs.none")}</span>}</span>
                  <span>{f.episodes_with_video > 0 ? t(locale, "ws.catalog.video.n", { n: f.episodes_with_video }) : <span className="gt-muted">{t(locale, "ws.catalog.video.none")}</span>}</span>
                  <span>{x.campaigns.length ? `${x.campaigns.length}${x.results.length ? " ●" : ""}` : <span className="gt-muted">{t(locale, "ws.catalog.tests.none")}</span>}</span>
                  <span className="rs-title-sub" style={{ whiteSpace: "normal" }}>{a.next[0] ? t(locale, a.next[0]) : ""}</span>
                </a>
              );
            })}
          </div>
          <div className="rs-panel-foot">{t(locale, "ws.catalog.chinaNote")}</div>
        </section>
      )}
    </>
  );
}
