import { redirect } from "next/navigation";
import { portalSession, producerLocale } from "@/components/producer/server";
import { AdChip, PlatformChip, titleName } from "@/components/producer/TitleShell";
import { BandPill, ScoreDial } from "@/components/producer/research/workspace-ui";
import { IconPlus } from "@/components/producer/icons";
import { getData } from "@/lib/data";
import { t } from "@/lib/i18n";
import { TropeChip } from "@/components/producer/research/ui";
import { ASSESSMENT_VERSION, BAND_ORDER, type Band } from "@/lib/research/assessment";
import { isTropeId, tropeLabel, type TropeId } from "@/lib/research/taxonomy";
import { adStatus, platformStatus } from "@/lib/research/title-status";
import { loadWorkspace } from "@/lib/research/workspace";

// /producer/titles — My catalog, the landing page (decision 2026-09-08,
// "status board"). One row per title answers three questions and nothing
// else: is it on TikTok, is it being advertised, how much US potential does
// it carry. Each cell opens the section that owns the answer. The numbers
// live where they belong: TikTok performance and Ad campaigns.

export const dynamic = "force-dynamic";

type Search = { view?: string; q?: string; sort?: string; band?: string; range?: string; trope?: string };
type Sort = "score" | "name";

export default async function MyCatalog({ searchParams }: { searchParams: Search }) {
  // Legacy views: the TikTok comparison is its own area now; preparation is this page with a band filter.
  if (searchParams.view === "performance" || searchParams.view === "tiktok") {
    const p = new URLSearchParams();
    for (const k of ["q", "sort", "range"] as const) if (searchParams[k]) p.set(k, searchParams[k]!);
    const s = p.toString();
    redirect(s ? `/producer/tiktok?${s}` : "/producer/tiktok");
  }
  const session = await portalSession("/producer/titles");
  const locale = producerLocale();
  const data = getData();
  const [ws, perf] = await Promise.all([loadWorkspace(session), data.listTitlePerformance(session, { range: "30d" })]);
  const perfById = new Map(perf.map((r) => [r.title_id, r]));
  const q = searchParams.q?.trim().toLowerCase() ?? "";
  const band = BAND_ORDER.includes(searchParams.band as Band) ? (searchParams.band as Band) : null;
  const sort: Sort = searchParams.sort === "name" ? "name" : "score";
  // What to make next links "N of your titles carry it" here with ?trope=, so the board's story type filters the catalog.
  const trope: TropeId | null = searchParams.trope && isTropeId(searchParams.trope) ? searchParams.trope : null;
  const byName = (a: string, b: string) => a.localeCompare(b, "zh");

  const rows = ws.titles
    .map((x) => ({ x, tiktok: perfById.get(x.summary.id) ?? null, platform: platformStatus(perfById.get(x.summary.id)?.analytics_state), ads: adStatus(x.campaigns, x.results) }))
    .filter(({ x }) => (!band || x.assessment.band === band) && (!trope || x.assessment.tropes.includes(trope)) && (!q || x.summary.name_zh.toLowerCase().includes(q) || (x.summary.name_en ?? "").toLowerCase().includes(q)))
    .sort((a, b) => (sort === "name" ? byName(a.x.summary.name_zh, b.x.summary.name_zh) : b.x.assessment.score - a.x.assessment.score || byName(a.x.summary.name_zh, b.x.summary.name_zh)));

  const href = (patch: Partial<Search>) => {
    const p = new URLSearchParams();
    const current: Partial<Search> = { q: q || undefined, sort: sort === "score" ? undefined : sort, band: band ?? undefined, trope: trope ?? undefined };
    for (const [k, v] of Object.entries({ ...current, ...patch })) if (v) p.set(k, String(v));
    const s = p.toString();
    return s ? `/producer/titles?${s}` : "/producer/titles";
  };
  const anyDemo = rows.some((r) => r.tiktok?.source === "demo" || r.x.results.some((res) => res.source === "demo"));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t(locale, "pf.title")}</h1>
          <p className="page-sub">{t(locale, "pf.sub")}</p>
        </div>
        <span className="rs-tool-row">
          <a className="btn btn-primary" href="/producer/titles/new"><IconPlus /> {t(locale, "research.nav.addTitle")}</a>
        </span>
      </div>

      <div className="pf-filters">
        <form action="/producer/titles" method="get" role="search" aria-label={t(locale, "pf.title")}>
          <input className="input" type="search" name="q" defaultValue={q} placeholder={t(locale, "redesign.catalog.search")} aria-label={t(locale, "redesign.catalog.search")} />
          <select className="select" name="sort" defaultValue={sort} aria-label={t(locale, "ws.catalog.sort")}>
            {(["score", "name"] as Sort[]).map((s) => <option key={s} value={s}>{t(locale, "ws.catalog.sort")}: {t(locale, `ws.catalog.sort.${s}`)}</option>)}
          </select>
          {band && <input type="hidden" name="band" value={band} />}
          {trope && <input type="hidden" name="trope" value={trope} />}
          <button className="btn btn-outline btn-sm" type="submit">{t(locale, "research.search.go")}</button>
        </form>
        <div className="pf-quick" role="group" aria-label={t(locale, "ws.catalog.band")}>
          <a className={`filter-chip${!band ? " on" : ""}`} aria-current={!band ? "true" : undefined} href={href({ band: undefined })}>{t(locale, "pf.quick.all")}</a>
          {BAND_ORDER.map((b) => <a key={b} className={`filter-chip${band === b ? " on" : ""}`} aria-current={band === b ? "true" : undefined} href={href({ band: band === b ? undefined : b })}>{t(locale, `ws.band.${b}`)}</a>)}
        </div>
      </div>
      {trope && (
        <p className="pf-trope-filter" role="status">
          <span className="trope is-hot">{t(locale, "pf.filter.trope", { name: tropeLabel(trope, locale) })}</span>
          <span>{t(locale, "pf.count", { n: rows.length })}</span>
          <a className="pf-cell-link" href={href({ trope: "" })}>{t(locale, "pf.filter.clear")}&nbsp;×</a>
        </p>
      )}
      {ws.truncated && <p className="pf-legend"><span className="ev ev-inferred">{t(locale, "research.mine.truncated", { shown: ws.titles.length, total: ws.total })}</span></p>}

      {rows.length === 0 ? (
        <section className="pf-table-wrap pf-empty ps-catalog-empty">
          <h2>{t(locale, ws.titles.length ? "redesign.catalog.noMatches" : "redesign.catalog.start")}</h2>
          <p>{t(locale, ws.titles.length ? "redesign.catalog.resetHelp" : "ws.catalog.empty")}</p>
          <a className="btn btn-primary" href={ws.titles.length ? "/producer/titles" : "/producer/titles/new"}>{t(locale, ws.titles.length ? "pf.reset" : "research.nav.addTitle")}</a>
        </section>
      ) : (
        <div className="pf-table-wrap">
          <table className="pf-table pf-status">
            <caption className="sr-only">{t(locale, "pf.sub")}</caption>
            <thead><tr>
              <th scope="col">{t(locale, "pf.col.title")}</th>
              <th scope="col">{t(locale, "pf.col.platform")}</th>
              <th scope="col">{t(locale, "pf.col.ads")}</th>
              <th scope="col">{t(locale, "ws.catalog.col.score")}</th>
              <th scope="col" />
            </tr></thead>
            <tbody>
              {rows.map(({ x, platform, ads }) => {
                const id = x.summary.id;
                const open = `/producer/titles/${id}`;
                const { primary, secondary, lang } = titleName(locale, x.summary.name_zh, x.summary.name_en);
                const step = ads.flow ? t(locale, `workflow.step.${ads.flow.step}`) : null;
                const linked = platform !== "not_linked";
                const a = x.assessment;
                return (
                  <tr key={id}>
                    <th scope="row" className="pf-title"><a href={open} lang={lang}>{primary}</a>{secondary && <small lang={lang === "en" ? "zh-CN" : "en"}>{secondary}</small>}{trope && <span className="rs-tropes pf-tropes">{a.tropes.slice(0, 4).map((id) => <TropeChip key={id} id={id} locale={locale} hot={id === trope} />)}</span>}</th>
                    <td className="pf-cell">
                      <PlatformChip status={platform} locale={locale} />
                      <a className="pf-cell-link" href={linked ? `${open}/analytics` : `${open}/analytics/link`}>{t(locale, linked ? "pf.cell.viewTiktok" : "pf.cell.link")}&nbsp;→</a>
                    </td>
                    <td className="pf-cell">
                      <AdChip status={ads.status} locale={locale} step={step} />
                      <a className="pf-cell-link" href={ads.status === "none" ? `/producer/promote/new?title=${id}` : `${open}/campaigns`}>{t(locale, ads.status === "none" ? "pf.cell.start" : "pf.cell.campaigns")}&nbsp;→</a>
                    </td>
                    <td className="pf-cell pf-score">
                      <ScoreDial score={a.score} band={a.band} locale={locale} size="sm" />
                      <div>
                        <BandPill band={a.band} locale={locale} />
                        <a className="pf-cell-link" href={`${open}/preparation`}>{t(locale, "tw.nav.preparation")}&nbsp;→</a>
                      </div>
                    </td>
                    <td className="pf-num"><a className="btn btn-outline btn-sm" href={open} aria-label={`${t(locale, "pf.col.open")}: ${primary}`}>{t(locale, "pf.col.open")}&nbsp;→</a></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="pf-foot">
            <span>{t(locale, "pf.count", { n: rows.length })}</span>
            <span>{t(locale, "ws.score.note", { version: ASSESSMENT_VERSION })}</span>
            {anyDemo && <span>{t(locale, "pf.demoNote")}</span>}
          </div>
        </div>
      )}
    </>
  );
}
