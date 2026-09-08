import { portalSession, producerLocale } from "@/components/producer/server";
import { titleName } from "@/components/producer/TitleShell";
import { WorkflowBadge } from "@/components/producer/research/workspace-ui";
import { fmtPct } from "@/components/producer/research/ui";
import { DemoChip, fmtUsd } from "@/components/producer/analytics/bits";
import { t } from "@/lib/i18n";
import type { PromoCampaignSummary } from "@/lib/types";
import { BENCHMARK } from "@/lib/research/assessment";
import { readResults } from "@/lib/research/results";
import { adCtr } from "@/lib/research/title-status";
import { loadWorkspace } from "@/lib/research/workspace";
import { WORKFLOW_STEPS, campaignWorkflow } from "@/lib/research/workflow";

// /producer/promote — Ad campaigns (decision 2026-09-08, "status board"):
// every campaign round as one table row, framed like TikTok performance.
// Title and campaign, the current step, budget, spend to date, the result
// reading against the benchmarks, and the one next action. Tasks sort first.
// Every ad number lives here or inside a campaign; TikTok numbers do not.

export const dynamic = "force-dynamic";

type Filter = "all" | "action" | "waiting";
const FILTERS: Filter[] = ["all", "action", "waiting"];
type Search = { q?: string; filter?: string };
const RETURN_TO = encodeURIComponent("/producer/promote");

export default async function Campaigns({ searchParams }: { searchParams: Search }) {
  const session = await portalSession("/producer/promote");
  const locale = producerLocale();
  const ws = await loadWorkspace(session);
  const q = searchParams.q?.trim().toLowerCase() ?? "";
  const filter: Filter = FILTERS.includes(searchParams.filter as Filter) ? (searchParams.filter as Filter) : "all";
  const benchCtr = (BENCHMARK.ctr * 100).toFixed(1);

  // Round numbers count each title's campaigns in creation order.
  const roundOf = new Map<string, number>();
  const byTitle = new Map<string, PromoCampaignSummary[]>();
  for (const c of ws.campaigns) byTitle.set(c.title_id, [...(byTitle.get(c.title_id) ?? []), c]);
  for (const list of byTitle.values()) [...list].sort((a, b) => a.created_at.localeCompare(b.created_at)).forEach((c, i) => roundOf.set(c.id, i + 1));

  const rows = ws.campaigns.map((c) => {
    const flow = campaignWorkflow(c, ws.results);
    const own = ws.results.filter((r) => r.campaign_id === c.id);
    const reading = own.length ? readResults(own, [], BENCHMARK) : null;
    const met = reading ? reading.rows.filter((r) => r.verdict === "met_both").length : 0;
    return { c, flow, own, reading, met, ctr: adCtr(own), round: roundOf.get(c.id) ?? 1, title: titleName(locale, c.title_name_zh, c.title_name_en) };
  });
  const searched = rows.filter((r) => !q || r.title.primary.toLowerCase().includes(q) || (r.title.secondary ?? "").toLowerCase().includes(q) || r.c.name.toLowerCase().includes(q));
  const counts: Record<Filter, number> = { all: searched.length, action: searched.filter((r) => !r.flow.waiting).length, waiting: searched.filter((r) => r.flow.waiting).length };
  const shown = searched
    .filter((r) => filter === "all" || (filter === "waiting") === r.flow.waiting)
    .sort((a, b) => Number(a.flow.waiting) - Number(b.flow.waiting) || b.flow.number - a.flow.number || b.c.updated_at.localeCompare(a.c.updated_at));
  const anyDemo = shown.some((r) => r.own.some((x) => x.source === "demo"));

  const href = (patch: Partial<Search>) => {
    const p = new URLSearchParams();
    const current: Partial<Search> = { q: q || undefined, filter: filter === "all" ? undefined : filter };
    for (const [k, v] of Object.entries({ ...current, ...patch })) if (v) p.set(k, String(v));
    const s = p.toString();
    return s ? `/producer/promote?${s}` : "/producer/promote";
  };
  const detailHref = (id: string) => `/producer/promote/${id}?returnTo=${RETURN_TO}`;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t(locale, "ws.exp.title")}</h1>
          <p className="page-sub">{t(locale, "workflow.campaignsSub")}</p>
        </div>
        <span className="rs-tool-row">
          <a className="btn btn-primary" href="/producer/promote/new">{t(locale, "ws.exp.new")}</a>
        </span>
      </div>

      <div className="pf-filters">
        <form action="/producer/promote" method="get" role="search" aria-label={t(locale, "ws.exp.title")}>
          <input className="input" type="search" name="q" defaultValue={q} placeholder={t(locale, "workflow.search")} aria-label={t(locale, "workflow.search")} />
          {filter !== "all" && <input type="hidden" name="filter" value={filter} />}
          <button className="btn btn-outline btn-sm" type="submit">{t(locale, "research.search.go")}</button>
        </form>
      </div>

      {ws.campaigns.length === 0 ? (
        <section className="pf-table-wrap pf-empty ps-catalog-empty">
          <h2>{t(locale, "ws.assess.noExperiments")}</h2>
          <p>{t(locale, "workflow.noCampaigns")}</p>
          <a className="btn btn-primary" href="/producer/titles">{t(locale, "workflow.chooseTitle")}</a>
        </section>
      ) : shown.length === 0 ? (
        <section className="pf-table-wrap pf-empty ps-catalog-empty">
          <h2>{t(locale, "workflow.noMatches")}</h2>
          <a className="btn btn-primary" href="/producer/promote">{t(locale, "pf.reset")}</a>
        </section>
      ) : (
        <section className="ps-catalog cc-catalog cc-campaigns">
          <div className="rs-meta" style={{ margin: 0, padding: "12px 14px 0" }}>
            <div className="pf-quick" role="group" aria-label={t(locale, "workflow.filter.label")}>
              {FILTERS.map((f) => <a key={f} className={`filter-chip${filter === f ? " on" : ""}`} aria-current={filter === f ? "true" : undefined} href={href({ filter: f === "all" ? undefined : f })}>{t(locale, `workflow.filter.${f}`)} <span className="n">{counts[f]}</span></a>)}
            </div>
            {anyDemo && <DemoChip locale={locale} />}
          </div>
          <table className="ps-catalog-table" role="table">
            <caption className="sr-only">{t(locale, "workflow.queueSub")}</caption>
            <thead role="rowgroup"><tr role="row">
              <th scope="col">{t(locale, "ws.exp.col.experiment")}</th>
              <th scope="col">{t(locale, "workflow.colStep")}</th>
              <th scope="col" className="gt-num">{t(locale, "ws.exp.col.budget")} <small className="an-basis">USD</small></th>
              <th scope="col" className="gt-num">{t(locale, "rd.col.spend")} <small className="an-basis"><span>USD</span> · <span>{t(locale, "review.roundSpend")}</span></small></th>
              <th scope="col">{t(locale, "tw.ads.resultsCol")} <small className="an-basis"><span>{t(locale, "rd.benchHold", { n: Math.round(BENCHMARK.hook_hold_rate * 100) })}</span> · <span>{t(locale, "rd.benchCtr", { n: benchCtr })}</span></small></th>
              <th scope="col">{t(locale, "an.catalog.col.action")}</th>
            </tr></thead>
            <tbody role="rowgroup">
              {shown.map(({ c, flow, reading, met, ctr, round, title }) => (
                <tr key={c.id} role="row">
                  <th className="ps-catalog-identity" scope="row" role="rowheader">
                    <a className="ps-catalog-name" href={detailHref(c.id)} lang={title.lang}>{title.primary}</a>
                    <span className="ps-catalog-secondary">{c.name}</span>
                    <span className="ps-catalog-titlemeta">{t(locale, "tw.ads.roundN", { n: round })} · {c.created_at.slice(0, 10)}</span>
                  </th>
                  <td role="cell" data-label={t(locale, "workflow.colStep")}>
                    <WorkflowBadge step={flow.step} locale={locale} />
                    {(flow.waiting || c.status === "failed") && <span className="cc-perf-fresh">{t(locale, flow.hint)}</span>}
                  </td>
                  <td className="gt-num" role="cell" data-label={t(locale, "ws.exp.col.budget")}>
                    {c.experiment ? <><b>{fmtUsd(c.experiment.budget_usd, 0)}</b><span className="cc-perf-fresh">{t(locale, c.experiment.approved_at ? "workflow.budgetApproved" : "workflow.budgetUnapproved")}</span></> : <span className="gt-muted">–</span>}
                  </td>
                  <td className="gt-num" role="cell" data-label={t(locale, "rd.col.spend")}>
                    {reading ? <b>{fmtUsd(reading.totals.spend_usd, 2)}</b> : <span className="gt-muted">–</span>}
                  </td>
                  <td role="cell" data-label={t(locale, "tw.ads.resultsCol")}>
                    {reading ? (
                      <>
                        <b>{t(locale, "tw.ads.metCount", { met, total: reading.rows.length })}</b>
                        <span className="cc-perf-fresh">{ctr ? <>{ctr.ctr >= BENCHMARK.ctr ? "✓" : "✗"} {t(locale, "rd.col.ctr")} {fmtPct(ctr.ctr, 2)} · </> : null}{t(locale, reading.demo_only ? "rd.sourceDemo" : "rd.sourceGrow")}</span>
                      </>
                    ) : <span className="gt-muted">{t(locale, flow.waiting ? "ws.exp.waiting.results" : "tw.ads.noResults")}</span>}
                  </td>
                  <td className="cc-next" role="cell" data-label={t(locale, "an.catalog.col.action")}>
                    <a className={`btn btn-sm ${flow.waiting ? "btn-outline" : "btn-primary"}`} href={flow.href.replace("#", `?returnTo=${RETURN_TO}#`)}>{t(locale, flow.action)}&nbsp;→</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="rs-panel-foot">{t(locale, "workflow.count", { n: shown.length })} · {t(locale, "workflow.queueSub")}</div>
        </section>
      )}

      <details className="wf-guide"><summary>{t(locale, "workflow.howItWorks")}</summary><ol>{WORKFLOW_STEPS.map((step) => <li key={step}><strong>{t(locale, `workflow.step.${step}`)}</strong><p>{t(locale, `workflow.hint.${step}`)}</p></li>)}</ol></details>
    </>
  );
}
