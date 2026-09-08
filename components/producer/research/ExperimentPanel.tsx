"use client";

// The experiment record on a campaign, as a form and a decision surface:
// brief (typed fields, versioned), budget approval (approver only),
// demo-results simulation (fixture only), the results read against the
// Studio-wide benchmarks, and the next-spend decision (creates a new
// round as its own campaign). Nothing here spends money.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/components/locale";
import { readResults, type AdReading, type Verdict } from "@/lib/research/results";
import type { CreativeResult, ExperimentSpec, PromoCampaign, PromoCreative } from "@/lib/types";

type Props = {
  campaign: PromoCampaign;
  creatives: PromoCreative[];
  results: CreativeResult[];
  canEdit: boolean;
  canApprove: boolean;
  fixtureMode: boolean;
  benchmark: { hook_hold_rate: number; ctr: number };
  titleName: string;
  briefExpanded?: boolean;
  /** The number the next round would get and the campaign name it would carry. */
  nextRound: { number: number; name: string };
  /** Where attributable revenue for this title lives (title analytics → acquisition). */
  analyticsHref?: string | null;
};

async function call<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

const pct = (v: number | null | undefined, digits = 0) => (v == null ? "–" : `${(v * 100).toFixed(digits)}%`);
const usd = (v: number | null | undefined, digits = 2) => (v == null ? "–" : `$${v.toFixed(digits)}`);
const num = (v: number | null | undefined) => (v == null ? "–" : v.toLocaleString("en-US"));

const VERDICT_CLASS: Record<Verdict, string> = { met_both: "rd-verdict-met", missed_hold: "rd-verdict-miss", missed_ctr: "rd-verdict-miss", missed_both: "rd-verdict-miss", no_impressions: "rd-verdict-none" };

export default function ExperimentPanel({ campaign, creatives, results, canEdit, canApprove, fixtureMode, benchmark, titleName, briefExpanded = true, nextRound, analyticsHref = null }: Props) {
  const { tt, locale } = useT();
  const router = useRouter();
  const e = campaign.experiment;
  const [budget, setBudget] = useState(String(e?.budget_usd ?? 100));
  const [hypothesis, setHypothesis] = useState(e?.hypothesis ?? "");
  const [audience, setAudience] = useState(e?.audience ?? "");
  const [batch, setBatch] = useState(String(e?.first_batch ?? 2));
  const [signal, setSignal] = useState<ExperimentSpec["signal"]>(e?.signal ?? "views");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const locked = ["submitted", "launching", "live"].includes(campaign.status);

  async function run(key: string, fn: () => Promise<string | null>) {
    setBusy(key);
    setErr(null);
    setMsg(null);
    try {
      const m = await fn();
      if (m) setMsg(m);
      router.refresh();
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const save = () =>
    run("save", async () => {
      const r = await call<{ campaign: PromoCampaign }>(`/api/producer/promote/${campaign.id}/experiment`, "PUT", { budget_usd: Number(budget), hypothesis: hypothesis.trim(), audience: audience.trim(), first_batch: Number(batch), signal });
      return tt("ws.exp.saved", { version: r.campaign.experiment?.version ?? 1 });
    });
  const approve = () => run("approve", async () => { await call(`/api/producer/promote/${campaign.id}/experiment`, "POST"); return null; });
  const simulate = () => run("simulate", async () => { await call(`/api/producer/promote/${campaign.id}/results`, "POST"); return null; });
  const createRound = (budgetUsd: number, note: string) =>
    run("round", async () => {
      const r = await call<{ campaign: PromoCampaign }>("/api/producer/promote", "POST", {
        title_id: campaign.title_id,
        name: nextRound.name.slice(0, 120),
        target_market: campaign.target_market,
        objective: campaign.objective,
        spoiler_level: campaign.spoiler_level,
        destination_url: campaign.destination_url,
        creative_direction: note,
        experiment: { budget_usd: budgetUsd, hypothesis: note, audience: e?.audience ?? "", first_batch: e?.first_batch ?? 2, signal: e?.signal ?? "views" },
      });
      setCreated(r.campaign.id);
      return tt("rd.roundCreated", { n: nextRound.number });
    });

  // ---- results read against the benchmarks ------------------------------------------------
  const reading = readResults(results, creatives, benchmark);
  const winner = reading.winner;
  const roundBudget = e?.budget_usd ?? 100;
  const bh = Math.round(benchmark.hook_hold_rate * 100);
  const bc = (benchmark.ctr * 100).toFixed(1);
  const adLabel = (x: AdReading) => (x.ad_number ? tt("fc.adNumber", { n: x.ad_number }) : x.creative?.hypothesis ?? x.result.creative_id);
  const missedWhat = (x: AdReading) => (x.verdict === "missed_both" ? tt("rd.what.both") : x.verdict === "missed_hold" ? tt("rd.what.hold") : tt("rd.what.ctr"));

  const briefPanel = (<section className="rs-panel" id="experiment">
        <div className="rs-panel-head">
          <div>
            <h2>{tt("ws.exp.brief")}</h2>
            <p>{tt("ws.exp.briefSub")}</p>
          </div>
          <span className="rs-panel-aside">
            {e?.approved_at ? <span className="state state-available">{tt("ws.exp.budgetApproved", { n: e.budget_usd, at: e.approved_at.slice(0, 10) })}</span> : <span className="state state-requires_connection">{tt("ws.exp.budgetPending")}</span>}
            {e && <small className="gt-muted"> v{e.version}</small>}
          </span>
        </div>
        <form className="rs-form ws-brief-form" onSubmit={(ev) => { ev.preventDefault(); save(); }}>
          <fieldset disabled={!canEdit || locked || busy !== null}>
            <div className="ws-brief-grid">
              <label>{tt("ws.exp.budget")}<input className="input" type="number" min={1} max={100000} value={budget} onChange={(x) => setBudget(x.target.value)} required /></label>
              <label>{tt("ws.exp.firstBatch")}<input className="input" type="number" min={1} max={10} value={batch} onChange={(x) => setBatch(x.target.value)} required /></label>
              <label>{tt("ws.exp.signal")}
                <select className="select" value={signal} onChange={(x) => setSignal(x.target.value as ExperimentSpec["signal"])}>
                  {(["views", "clicks", "landing"] as const).map((s) => <option key={s} value={s}>{tt(`ws.exp.signal.${s}`)}</option>)}
                </select>
              </label>
              <label className="ws-span">{tt("ws.exp.audience")}<input className="input" maxLength={200} value={audience} onChange={(x) => setAudience(x.target.value)} required /></label>
              <label className="ws-span">{tt("ws.exp.hypothesis")}<textarea className="textarea" maxLength={400} rows={3} value={hypothesis} onChange={(x) => setHypothesis(x.target.value)} required /></label>
            </div>
            <p className="hint">{tt("ws.exp.budgetNote")}</p>
          </fieldset>
          <div className="rs-form-foot">
            {canEdit && !locked && <button className="btn btn-outline" type="submit" disabled={busy !== null || hypothesis.trim().length < 10 || audience.trim().length < 3}>{busy === "save" ? tt("common.loading") : tt("ws.exp.save")}</button>}
            {e && !e.approved_at && !locked && (
              <button className="btn btn-primary" type="button" onClick={approve} disabled={!canApprove || busy !== null} title={canApprove ? undefined : tt("ws.exp.approverOnly")}>
                {busy === "approve" ? tt("common.loading") : tt("ws.exp.approveBudget", { n: e.budget_usd })}
              </button>
            )}
            {!canEdit && <span className="hint">{tt("ws.readOnly")}</span>}
          </div>
        </form>
      </section>);

  const resultsPanel = (<section className="rs-panel rd-results" id="results">
        <div className="rs-panel-head">
          <div>
            <h2>{tt("rd.resultsTitle")}</h2>
            <p>{tt("rd.resultsSub")}</p>
          </div>
          {fixtureMode && ["submitted", "live"].includes(campaign.status) && results.length === 0 && canEdit && (
            <span className="rs-panel-aside"><button className="btn btn-outline btn-sm" type="button" onClick={simulate} disabled={busy !== null} title={tt("ws.exp.simulateNote")}>{busy === "simulate" ? tt("common.loading") : tt("ws.exp.simulate")}</button></span>
          )}
        </div>
        {results.length === 0 ? (
          <div className="rs-empty">{tt("ws.exp.noResults")} {fixtureMode && locked && <small className="gt-muted">{tt("ws.exp.simulateNote")}</small>}</div>
        ) : (
          <>
            <div className="rd-provenance">
              {reading.sources.map((s) => <span key={s} className={`state ${s === "demo" ? "state-unavailable" : "state-available"}`}>{tt(s === "demo" ? "rd.sourceDemo" : "rd.sourceGrow")}</span>)}
              {reading.window && <span>{tt("rd.window", { start: reading.window.start, end: reading.window.end })}</span>}
              {reading.observed_at && <span>{tt("rd.readAt", { at: reading.observed_at.slice(0, 16).replace("T", " ") + " UTC" })}</span>}
              <span className="rd-bench"><b>{tt("rd.benchHold", { n: bh })}</b> · <b>{tt("rd.benchCtr", { n: bc })}</b></span>
            </div>
            {reading.demo_only && <p className="rd-demo-note">{tt("rd.demoNote")}</p>}
            <div className="rd-table-wrap">
              <table className="rd-table">
                <caption className="sr-only">{tt("rd.resultsSub")}</caption>
                <thead>
                  <tr>
                    <th scope="col">{tt("rd.col.ad")}</th>
                    <th scope="col" className="rd-num">{tt("rd.col.hold")}<small>{tt("rd.benchHold", { n: bh })}</small></th>
                    <th scope="col" className="rd-num">{tt("rd.col.ctr")}<small>{tt("rd.benchCtr", { n: bc })}</small></th>
                    <th scope="col" className="rd-num">{tt("rd.col.views")}</th>
                    <th scope="col" className="rd-num">{tt("rd.col.impressions")}</th>
                    <th scope="col" className="rd-num">{tt("rd.col.clicks")}</th>
                    <th scope="col" className="rd-num">{tt("rd.col.spend")}</th>
                    <th scope="col" className="rd-num">{tt("rd.col.landing")}</th>
                    <th scope="col">{tt("rd.col.verdict")}</th>
                  </tr>
                </thead>
                <tbody>
                  {reading.rows.map((x) => {
                    const r = x.result;
                    const isWinner = winner?.result.id === r.id;
                    return (
                      <tr key={r.id} className={isWinner ? "is-winner" : undefined}>
                        <th scope="row" className="rd-ad">
                          <span className="rd-ad-number">{adLabel(x)}{isWinner && <span className="rd-winner-tag">{tt("rd.winnerIs")}</span>}</span>
                          <span className="rd-ad-hypothesis">{x.creative?.hypothesis ?? r.creative_id}</span>
                          {x.creative && <span className="rd-ad-kind">{tt(`promote.kind.${x.creative.kind}`)} · {x.creative.hook}</span>}
                        </th>
                        <td className={`rd-num ${x.hold_met ? "rd-met" : "rd-miss"}`}><b>{pct(r.hook_hold_rate)}</b><small>{x.hold_met ? "✓" : "✗"} {tt("rd.benchHold", { n: bh })}</small></td>
                        <td className={`rd-num ${x.ctr == null ? "" : x.ctr_met ? "rd-met" : "rd-miss"}`}><b>{pct(x.ctr, 2)}</b><small>{x.ctr == null ? tt("rd.verdict.no_impressions") : `${x.ctr_met ? "✓" : "✗"} ${tt("rd.benchCtr", { n: bc })}`}</small></td>
                        <td className="rd-num"><b>{num(r.video_views)}</b><small>{x.view_rate != null ? tt("rd.viewRate", { pct: pct(x.view_rate) }) : "–"}</small></td>
                        <td className="rd-num"><b>{num(r.impressions)}</b><small>{x.cpm != null ? tt("rd.cpm", { n: x.cpm.toFixed(2) }) : "–"}</small></td>
                        <td className="rd-num"><b>{num(r.clicks)}</b><small>{x.cpc != null ? tt("rd.cpc", { n: x.cpc.toFixed(2) }) : "–"}</small></td>
                        <td className="rd-num"><b>{usd(r.spend_usd)}</b><small>{tt(`ws.exp.source.${r.source}`)}</small></td>
                        <td className="rd-num"><b>{r.landing_actions == null ? "–" : num(r.landing_actions)}</b><small>{r.landing_actions == null ? tt("rd.notReported") : x.cost_per_action != null ? tt("rd.cpa", { n: x.cost_per_action.toFixed(2) }) : "–"}</small></td>
                        <td><span className={`rd-verdict ${VERDICT_CLASS[x.verdict]}`}>{tt(`rd.verdict.${x.verdict}`)}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="rs-panel-foot rd-foot">
              <span>{tt("rd.totals", { spend: reading.totals.spend_usd.toFixed(2), impressions: num(reading.totals.impressions), views: num(reading.totals.video_views), clicks: num(reading.totals.clicks) })}</span>
              <span>{tt("rd.benchWhy")}</span>
            </div>
          </>
        )}
      </section>);

  const decisionPanel = results.length > 0 ? (<section className="rs-panel rd-decide" id="decide">
          <div className="rs-panel-head">
            <div>
              <h2>{tt("rd.decideTitle")}</h2>
              <p>{tt("rd.decideSub")}</p>
            </div>
          </div>
          <div className="rs-panel-body">
            <ul className="rd-findings">
              {reading.rows.map((x) => (
                <li key={x.result.id} className={x.verdict === "met_both" ? "is-met" : "is-miss"}>
                  <span className="rd-finding-mark" aria-hidden="true">{x.verdict === "met_both" ? "✓" : "✗"}</span>
                  <span>
                    {x.verdict === "met_both"
                      ? tt("rd.winnerLine", { n: x.ad_number ?? "?", hold: Math.round(x.result.hook_hold_rate * 100), bh, ctr: x.ctr == null ? "–" : (x.ctr * 100).toFixed(2), bc })
                      : tt("rd.missedLine", { n: x.ad_number ?? "?", what: missedWhat(x), hold: Math.round(x.result.hook_hold_rate * 100), ctr: x.ctr == null ? "–" : (x.ctr * 100).toFixed(2) })}
                    {x.creative && <small> — {x.creative.hypothesis}</small>}
                  </span>
                </li>
              ))}
            </ul>
            {!winner && <p className="note note-warn">{tt("rd.noWinner")}</p>}
            {reading.demo_only && <p className="rd-demo-note">{tt("rd.demoNote")}</p>}
            {analyticsHref && <p className="rd-analytics"><a href={analyticsHref}>{tt("rd.analyticsLink")} →</a></p>}

            <h3 className="rd-next-title">{tt("rd.nextTitle")}</h3>
            <p className="rd-next-sub">{tt("rd.nextSub", { n: nextRound.number })}</p>
            {created ? (
              <p className="note note-success" role="status">{tt("rd.roundCreated", { n: nextRound.number })} <a className="btn btn-primary btn-sm" href={`/producer/promote/${created}`}>{tt("rd.openRound", { n: nextRound.number })}</a></p>
            ) : (
              <div className="rd-options">
                {winner && (
                  <div className="rd-option is-primary">
                    <div><strong>{tt("rd.scale")}</strong><p>{tt("rd.scaleHint", { n: nextRound.number, budget: Math.round(roundBudget * 3), ad: winner.ad_number ?? "?" })}</p></div>
                    <button className="btn btn-primary" type="button" disabled={!canEdit || busy !== null} onClick={() => createRound(Math.round(roundBudget * 3), tt("fc.roundScale", { hypothesis: winner.creative?.hypothesis ?? "" }))}>{busy === "round" ? tt("common.loading") : tt("ws.exp.scaleUp", { n: Math.round(roundBudget * 3) })}</button>
                  </div>
                )}
                <div className={`rd-option${winner ? "" : " is-primary"}`}>
                  <div><strong>{tt("rd.more")}</strong><p>{tt(winner ? "rd.moreHint" : "rd.retryHint", { n: nextRound.number, budget: roundBudget })}</p></div>
                  <button className={`btn ${winner ? "btn-outline" : "btn-primary"}`} type="button" disabled={!canEdit || busy !== null} onClick={() => createRound(roundBudget, winner ? tt("fc.roundMore", { hypothesis: winner.creative?.hypothesis ?? "" }) : tt("fc.roundRetry"))}>{busy === "round" ? tt("common.loading") : tt("ws.exp.moreVariations")}</button>
                </div>
                <div className="rd-option">
                  <div><strong>{tt("rd.stop")}</strong><p>{tt("rd.stopHint")}</p></div>
                  <a className="btn btn-ghost" href="/producer/promote">{tt("ws.exp.stop")}</a>
                </div>
              </div>
            )}
            {!canEdit && <p className="hint">{tt("rd.editorOnly")}</p>}
          </div>
        </section>) : null;

  return <div className="ws-experiment fc-experiment">
    {msg && !created && <p role="status" className="note note-success">{msg}</p>}
    {err && <p role="alert" className="err">{err}</p>}
    {(locked || results.length > 0) && resultsPanel}
    {results.length > 0 && decisionPanel}
    {briefExpanded && !locked && !results.length ? briefPanel : (
      <details className="fc-disclosure" id="brief-record">
        <summary><span>{tt("fc.briefRecord")}</span><span>{e ? `$${e.budget_usd} · ${tt(e.approved_at ? "fc.budgetApproved" : "fc.budgetPending")}` : tt("ws.exp.brief")}</span></summary>
        {briefPanel}
      </details>
    )}
    <span hidden>{locale}</span>
  </div>;
}
