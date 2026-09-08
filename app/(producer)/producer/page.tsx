import { portalSession, producerLocale } from "@/components/producer/server";
import { BandPill, ComponentBars, ScoreDial, StageStrip } from "@/components/producer/research/workspace-ui";
import { StateBadge, TropeChip, fmtCount, fmtUtc } from "@/components/producer/research/ui";
import { getData } from "@/lib/data";
import { t } from "@/lib/i18n";
import { BENCHMARK } from "@/lib/research/assessment";
import { experimentStage, loadWorkspace } from "@/lib/research/workspace";

// /producer — Overview of the US launch workspace (decision 2026-09-08):
// recommended titles to test (highest US-potential scores), experiments
// waiting on a decision, results needing a next-spend call, and setup gaps.
// Every card links to the page where the decision is made.

export const dynamic = "force-dynamic";

export default async function Overview() {
  const session = await portalSession();
  const locale = producerLocale();
  const ws = await loadWorkspace(session);
  const company = await getData().getCompanyIdentity(session);
  const recommended = ws.titles.filter((x) => x.assessment.band === "test_first" || x.assessment.band === "prepare").slice(0, 4);
  const staged = ws.campaigns.map((c) => ({ c, ...experimentStage(c, ws.results) }));
  const waiting = staged.filter((x) => x.waiting !== "none" && x.waiting !== "results" && x.waiting !== "decide");
  const withResults = staged.filter((x) => x.stage === "decide");
  const gaps: string[] = [];
  if (!ws.profile) gaps.push("ws.raise.profile");
  if (!ws.accounts.some((a) => a.kind === "ad_account" && a.state === "connected")) gaps.push("ws.raise.adAccount");
  if (!ws.reports.length) gaps.push("ws.raise.reports");
  const snapshot = ws.market.latest;

  return (
    <>
      <div className="page-head">
        <div>
          <span className="page-kicker">{t(locale, "ws.overview.kicker")}{company ? ` · ${locale === "en" ? company.name_en || company.name_zh : company.name_zh}` : ""}</span>
          <h2>{t(locale, "ws.overview.title")}</h2>
          <p className="page-sub">{t(locale, "ws.overview.sub")}</p>
        </div>
        <a className="btn btn-outline" href="/producer/insights">{t(locale, "ws.nav.insights")} →</a>
      </div>

      <div className="rs-scope">
        {ws.profile?.goal && <span><b>{t(locale, "ws.overview.goal")}</b> {ws.profile.goal}</span>}
        {ws.profile?.monthly_test_budget_usd != null && <span><b>{t(locale, "ws.overview.budget")}</b> ${ws.profile.monthly_test_budget_usd}</span>}
        {snapshot && <span><b>{t(locale, "research.freshness")}</b> {fmtUtc(snapshot.platforms.map((p) => p.fetched_at).sort().at(-1))}</span>}
        <span className="spacer" />
        <a href="/producer/company">{t(locale, "ws.nav.company")} ›</a>
      </div>

      <div className="rs-grid">
        <section className="rs-panel rs-span">
          <div className="rs-panel-head">
            <div>
              <h3>{t(locale, "ws.overview.recommended")}</h3>
              <p>{t(locale, "ws.overview.recommendedSub")}</p>
            </div>
            <a className="rs-panel-aside" href="/producer/titles">{t(locale, "ws.overview.viewCatalog")} ›</a>
          </div>
          {recommended.length === 0 ? (
            <div className="rs-empty">{t(locale, "ws.catalog.empty")} <a className="btn btn-primary btn-sm" href="/producer/titles/new">{t(locale, "research.nav.addTitle")}</a></div>
          ) : (
            <div className="ws-rec-grid">
              {recommended.map((x) => (
                <article className="ws-rec" key={x.summary.id}>
                  <ScoreDial score={x.assessment.score} band={x.assessment.band} locale={locale} size="sm" />
                  <div className="ws-rec-body">
                    <a className="rs-title-name bilingual" lang="zh-CN" href={`/producer/titles/${x.summary.id}/potential`}>{x.summary.name_zh}</a>
                    {x.summary.name_en && <span className="rs-title-sub" lang="en">{x.summary.name_en}</span>}
                    <div className="rs-tropes clip" style={{ marginTop: 4 }}>{x.assessment.tropes.slice(0, 3).map((id) => <TropeChip key={id} id={id} locale={locale} evidence="inferred" />)}</div>
                    <div className="ws-rec-foot">
                      <BandPill band={x.assessment.band} locale={locale} />
                      <ComponentBars a={x.assessment} locale={locale} />
                    </div>
                    <p className="ws-rec-next">{x.assessment.next[0] ? t(locale, x.assessment.next[0]) : ""}</p>
                    <div className="rs-tool-row">
                      <a className="btn btn-primary btn-sm" href={`/producer/titles/${x.summary.id}/potential`}>{t(locale, "ws.actions.assess")}</a>
                      {x.campaigns.length === 0 && x.assessment.band === "test_first" && <a className="btn btn-outline btn-sm" href={`/producer/titles/${x.summary.id}/potential#experiment`}>{t(locale, "ws.actions.test")}</a>}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="rs-panel">
          <div className="rs-panel-head">
            <div>
              <h3>{t(locale, "ws.overview.decisions")}</h3>
              <p>{t(locale, "ws.overview.decisionsSub")}</p>
            </div>
            <a className="rs-panel-aside" href="/producer/promote">{t(locale, "ws.overview.viewLaunch")} ›</a>
          </div>
          {waiting.length === 0 ? (
            <div className="rs-empty">{t(locale, "ws.overview.noDecisions")}</div>
          ) : (
            <ul className="rs-list">
              {waiting.map(({ c, stage, waiting: w }) => (
                <li key={c.id} style={{ flexWrap: "wrap" }}>
                  <a className="rs-title-name" href={`/producer/promote/${c.id}`}>{c.name}</a>
                  <span className="spacer" />
                  <span className="state state-collecting_history">{t(locale, `ws.exp.waiting.${w}`)}</span>
                  <span style={{ flexBasis: "100%" }}><StageStrip stage={stage} locale={locale} /></span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rs-panel">
          <div className="rs-panel-head">
            <div>
              <h3>{t(locale, "ws.overview.results")}</h3>
              <p>{t(locale, "ws.exp.benchmark", { hold: Math.round(BENCHMARK.hook_hold_rate * 100), ctr: (BENCHMARK.ctr * 100).toFixed(1) })}</p>
            </div>
          </div>
          {withResults.length === 0 ? (
            <div className="rs-empty">{t(locale, "ws.exp.noResults")}</div>
          ) : (
            <ul className="rs-list">
              {withResults.map(({ c }) => {
                const rows = ws.results.filter((r) => r.campaign_id === c.id);
                const best = rows.reduce((b, r) => (r.hook_hold_rate > b.hook_hold_rate ? r : b), rows[0]);
                const ctr = best.impressions ? best.clicks / best.impressions : 0;
                return (
                  <li key={c.id} style={{ flexWrap: "wrap" }}>
                    <a className="rs-title-name" href={`/producer/promote/${c.id}#results`}>{c.name}</a>
                    {best.source === "demo" && <span className="state state-unavailable">{t(locale, "ws.state.demo")}</span>}
                    <span className="spacer" />
                    <span>{t(locale, "ws.exp.col.hold")} <b>{Math.round(best.hook_hold_rate * 100)}%</b> · {t(locale, "ws.exp.col.ctr")} <b>{(ctr * 100).toFixed(2)}%</b> · {t(locale, "ws.exp.col.spend")} <b>${rows.reduce((a, r) => a + r.spend_usd, 0).toFixed(0)}</b></span>
                    <a className="btn btn-primary btn-sm" href={`/producer/promote/${c.id}#decide`}>{t(locale, "ws.exp.waiting.decide")}</a>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="rs-panel rs-span">
          <div className="rs-panel-head">
            <div><h3>{t(locale, "ws.overview.setup")}</h3></div>
            <a className="rs-panel-aside" href="/producer/company">{t(locale, "ws.nav.company")} ›</a>
          </div>
          <ul className="rs-list">
            {gaps.length === 0 && <li className="gt-muted">{t(locale, "ws.overview.noDecisions")}</li>}
            {gaps.map((k) => <li key={k}><StateBadge status="requires_connection" locale={locale} /> {t(locale, k)}</li>)}
            {ws.accounts.map((a) => (
              <li key={a.id}><span className="rs-platform">{a.provider}</span> {a.name} <span className="gt-muted">· {t(locale, `ws.accounts.kind.${a.kind}`)}</span><span className="spacer" /><StateBadge status={a.state === "connected" ? "available" : a.state === "invited" ? "collecting_history" : a.state === "revoked" ? "failed" : "requires_connection"} locale={locale} /></li>
            ))}
            {ws.reports.length > 0 && <li><StateBadge status="available" locale={locale} /> {t(locale, "research.reports.title")}: {fmtCount(ws.reports.length)}</li>}
          </ul>
        </section>
      </div>
    </>
  );
}
