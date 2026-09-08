import { portalSession, producerLocale } from "@/components/producer/server";
import { StageStrip } from "@/components/producer/research/workspace-ui";
import { t } from "@/lib/i18n";
import { experimentStage, loadWorkspace } from "@/lib/research/workspace";

// /producer/promote — Launch & experiments: every experiment with its stage,
// budget, batch and best signal, and what it is waiting on. The loop:
// generate broadly → select a small first batch → approve the budget →
// submit → read results → decide the next spend.

export const dynamic = "force-dynamic";

export default async function Experiments() {
  const session = await portalSession("/producer/promote");
  const locale = producerLocale();
  const ws = await loadWorkspace(session);
  const rows = ws.campaigns.map((c) => ({ c, ...experimentStage(c, ws.results), results: ws.results.filter((r) => r.campaign_id === c.id) }));
  const order = ["decide", "budget", "batch", "concepts", "brief", "submitted", "results"];
  rows.sort((a, b) => order.indexOf(a.stage) - order.indexOf(b.stage) || b.c.updated_at.localeCompare(a.c.updated_at));

  return (
    <>
      <div className="page-head">
        <div>
          <span className="page-kicker">{t(locale, "ws.exp.kicker")}</span>
          <h2>{t(locale, "ws.exp.title")}</h2>
          <p className="page-sub">{t(locale, "ws.exp.sub")}</p>
        </div>
        <a className="btn btn-primary" href="/producer/promote/new">{t(locale, "ws.exp.new")}</a>
      </div>
      <p className="note note-info">{t(locale, "ws.exp.mock")}</p>

      {rows.length === 0 ? (
        <section className="rs-panel"><div className="rs-empty">{t(locale, "ws.exp.empty")} <a className="btn btn-outline btn-sm" href="/producer/titles">{t(locale, "ws.nav.catalog")}</a></div></section>
      ) : (
        <section className="rs-panel">
          <div className="gtable gtable-flush rs-table" style={{ ["--cols" as string]: "minmax(0,2.4fr) minmax(0,2.6fr) 90px 90px 140px 150px" }}>
            <div className="gt-head">
              <span>{t(locale, "ws.exp.col.experiment")}</span>
              <span>{t(locale, "ws.exp.col.stage")}</span>
              <span className="gt-num">{t(locale, "ws.exp.col.budget")}</span>
              <span className="gt-num">{t(locale, "ws.exp.col.batch")}</span>
              <span>{t(locale, "ws.exp.col.signal")}</span>
              <span>{t(locale, "ws.exp.col.waiting")}</span>
            </div>
            {rows.map(({ c, stage, waiting, results }) => {
              const best = results.reduce<typeof results[number] | null>((b, r) => (!b || r.hook_hold_rate > b.hook_hold_rate ? r : b), null);
              return (
                <a className="gt-row" key={c.id} href={`/producer/promote/${c.id}`}>
                  <span style={{ minWidth: 0 }}>
                    <span className="rs-title-name">{c.name}</span>
                    <span className="rs-title-sub">{t(locale, "ws.exp.forTitle", { title: c.title_name_en || c.title_name_zh })} · {c.updated_at.slice(0, 10)}</span>
                  </span>
                  <span><StageStrip stage={stage} locale={locale} /></span>
                  <span className="gt-num">{c.experiment ? `$${c.experiment.budget_usd}${c.experiment.approved_at ? " ✓" : ""}` : "–"}</span>
                  <span className="gt-num">{c.approved_count}/{c.creative_count || (c.experiment?.first_batch ?? "–")}</span>
                  <span>{best ? <>{Math.round(best.hook_hold_rate * 100)}% · {best.impressions ? ((best.clicks / best.impressions) * 100).toFixed(2) : "0.00"}% {best.source === "demo" && <span className="state state-unavailable">{t(locale, "ws.state.demo")}</span>}</> : <span className="gt-muted">–</span>}</span>
                  <span><span className={`state ${waiting === "results" ? "state-collecting_history" : waiting === "none" ? "state-available" : "state-requires_connection"}`}>{t(locale, `ws.exp.waiting.${waiting}`)}</span></span>
                </a>
              );
            })}
          </div>
        </section>
      )}
    </>
  );
}
