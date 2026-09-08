import TitleShell from "@/components/producer/TitleShell";
import { portalSession, producerLocale } from "@/components/producer/server";
import { BandPill, ComponentCard, ScoreDial, WorkflowBadge } from "@/components/producer/research/workspace-ui";
import { EvidenceTag, MetricLabel, Prominence, TropeChip, platformName } from "@/components/producer/research/ui";
import { t } from "@/lib/i18n";
import { ASSESSMENT_VERSION } from "@/lib/research/assessment";
import { loadTitleWorkspace } from "@/lib/research/title-workspace";
import { campaignWorkflow } from "@/lib/research/workflow";

// /producer/titles/[id]/preparation — the Preparation section: the US
// potential assessment (the explained composite: story match, market
// signal, readiness, own evidence, fit), comparable US listings, the
// preparation checklist and the imported reports. Everything the old
// /potential page held, framed inside the title workspace.

export const dynamic = "force-dynamic";

export default async function Preparation({ params }: { params: { id: string } }) {
  const session = await portalSession(`/producer/titles/${params.id}/preparation`);
  const locale = producerLocale();
  const w = await loadTitleWorkspace(session, params.id);
  const x = w.title;
  const a = x.assessment;
  const evidenceHref = a.tropes.length ? `/producer/insights?mode=all&trope=${a.tropes[0]}` : "/producer/insights";
  const returnTo = `/producer/titles/${x.summary.id}/preparation`;
  const adStep = w.ads.flow ? t(locale, `workflow.step.${w.ads.flow.step}`) : null;

  return (
    <TitleShell locale={locale} titleId={params.id} name_zh={w.detail.title.name_zh} name_en={w.detail.title.name_en} platform={w.platform} ads={w.ads.status} adStep={adStep} section="preparation"
      actions={!x.campaigns.length ? <a className="btn btn-primary" href={`/producer/promote/new?title=${x.summary.id}`}>{t(locale, "ws.actions.test")}</a> : <a className="btn btn-outline" href={campaignWorkflow(x.campaigns[0], w.title.results).href}>{t(locale, "tw.nav.campaigns")}&nbsp;→</a>}>
      <section className="ws-hero tw-hero">
        <ScoreDial score={a.score} band={a.band} locale={locale} />
        <div className="ws-hero-body">
          <span className="page-kicker">{t(locale, "tw.prep.assessment")} · v{ASSESSMENT_VERSION}</span>
          <div className="rs-tool-row" style={{ margin: "8px 0" }}>
            <BandPill band={a.band} locale={locale} />
            <span className="rs-tropes clip">{a.tropes.map((id) => <TropeChip key={id} id={id} locale={locale} evidence="inferred" href={`/producer/insights?mode=all&trope=${id}`} />)}</span>
          </div>
          <p className="page-sub">{t(locale, "ws.assess.sub")}</p>
          <p className="ws-hero-note">{t(locale, "ws.score.note", { version: ASSESSMENT_VERSION })} {a.observed_at && <>· {t(locale, "ws.assess.observed", { date: a.observed_at })}</>} · <a href="/producer/sources/catalog_match">{t(locale, "research.title.methodology")}</a></p>
          <div className="rs-tool-row">
            <a className="btn btn-outline btn-sm" href={evidenceHref}>{t(locale, "tw.prep.marketEvidence")}</a>
          </div>
        </div>
        <aside className="ws-hero-next">
          <h2>{t(locale, "tw.prep.checklist")}</h2>
          <ol>{a.next.map((k) => <li key={k}>{t(locale, k)}</li>)}</ol>
        </aside>
      </section>

      <section className="rs-panel" style={{ marginBottom: 20 }}>
        <div className="rs-panel-head"><div><h2>{t(locale, "tw.prep.breakdown")}</h2></div></div>
        <div className="ws-components">{a.components.map((c) => <ComponentCard key={c.key} c={c} locale={locale} />)}</div>
      </section>

      <div className="rs-grid">
        <section className="rs-panel">
          <div className="rs-panel-head">
            <div>
              <h2>{t(locale, "ws.assess.comparables")}</h2>
              <p>{t(locale, "ws.assess.comparablesSub")}</p>
            </div>
            <a className="rs-panel-aside" href={evidenceHref}>{t(locale, "ws.nav.insights")} ›</a>
          </div>
          {a.comparables.length === 0 ? (
            <div className="rs-empty">{t(locale, "research.mine.untagged")}</div>
          ) : (
            <ul className="rs-list">
              {a.comparables.map((c) => (
                <li key={c.key}>
                  <a className="rs-title-name" lang="en" href={`/producer/market/${c.key}?returnTo=${encodeURIComponent(returnTo)}`}>{c.title}</a>
                  <span className="rs-platform">{platformName(c.platform)}</span>
                  <span className="rs-tropes clip">{c.overlap.slice(0, 3).map((id) => <TropeChip key={id} id={id} locale={locale} />)}</span>
                  <span className="spacer" />
                  <MetricLabel metric="prominence" locale={locale}><Prominence value={c.prominence} locale={locale} /></MetricLabel>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rs-panel">
          <div className="rs-panel-head">
            <div><h2>{t(locale, "tw.nav.campaigns")}</h2></div>
            <a className="rs-panel-aside" href={`/producer/titles/${x.summary.id}/campaigns`}>{t(locale, "tw.open")} ›</a>
          </div>
          {x.campaigns.length === 0 ? (
            <div className="rs-empty">{t(locale, "ws.assess.noExperiments")}</div>
          ) : (
            <ul className="rs-list">
              {x.campaigns.map((c) => {
                const flow = campaignWorkflow(c, w.title.results);
                return (
                  <li key={c.id} style={{ flexWrap: "wrap" }}>
                    <a className="rs-title-name" href={`/producer/promote/${c.id}`}>{c.name}</a>
                    {c.experiment && <span className="gt-muted">${c.experiment.budget_usd}</span>}
                    <span className="spacer" />
                    <WorkflowBadge step={flow.step} locale={locale} /><a className="btn btn-outline btn-sm" href={flow.href}>{t(locale, flow.action)}</a>
                  </li>
                );
              })}
            </ul>
          )}
          {x.reports.length > 0 && (
            <>
              <div className="rs-panel-head" style={{ borderTop: "1px solid var(--border-light)" }}><div><h2>{t(locale, "ws.assess.reports")}</h2></div></div>
              <ul className="rs-list">
                {x.reports.slice(0, 6).map((r) => <li key={r.id}><span>{t(locale, `research.metric.${r.metric}`)} · {r.platform}</span><span className="spacer" /><b>{r.value.toLocaleString("en-US")}{r.currency ? ` ${r.currency}` : ""}</b><small className="gt-muted">{r.period_start} → {r.period_end}</small><EvidenceTag evidence="partner_reported" locale={locale} /></li>)}
              </ul>
            </>
          )}
        </section>
      </div>
    </TitleShell>
  );
}
