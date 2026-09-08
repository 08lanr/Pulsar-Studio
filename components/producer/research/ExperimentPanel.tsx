"use client";

// The experiment record on a campaign, as a form and a decision surface:
// brief (typed fields, versioned), budget approval (approver only),
// demo-results simulation (fixture only), and the next-spend decision
// (creates a new round). Nothing here spends money.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/components/locale";
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
};

async function call<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

export default function ExperimentPanel({ campaign, creatives, results, canEdit, canApprove, fixtureMode, benchmark, titleName }: Props) {
  const { tt } = useT();
  const router = useRouter();
  const e = campaign.experiment;
  const [budget, setBudget] = useState(String(e?.budget_usd ?? 100));
  const [hypothesis, setHypothesis] = useState(e?.hypothesis ?? "");
  const [audience, setAudience] = useState(e?.audience ?? "");
  const [batch, setBatch] = useState(String(e?.first_batch ?? 2));
  const [signal, setSignal] = useState<ExperimentSpec["signal"]>(e?.signal ?? "views");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
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
  const nextRound = (budgetUsd: number, note: string) =>
    run("round", async () => {
      await call("/api/producer/promote", "POST", {
        title_id: campaign.title_id,
        name: `${titleName.slice(0, 60)} — round ${(e?.version ?? 1) + 1}`,
        target_market: campaign.target_market,
        objective: campaign.objective,
        spoiler_level: campaign.spoiler_level,
        destination_url: campaign.destination_url,
        creative_direction: note,
        experiment: { budget_usd: budgetUsd, hypothesis: note, audience: e?.audience ?? "", first_batch: e?.first_batch ?? 2, signal: e?.signal ?? "views" },
      });
      return tt("ws.exp.roundCreated");
    });

  // Results and the decision.
  const byCreative = new Map(creatives.map((c) => [c.id, c]));
  const scored = results.map((r) => ({ r, c: byCreative.get(r.creative_id), ctr: r.impressions ? r.clicks / r.impressions : 0 }));
  const winner = scored.filter((x) => x.r.hook_hold_rate >= benchmark.hook_hold_rate && x.ctr >= benchmark.ctr).sort((a, b) => b.r.hook_hold_rate - a.r.hook_hold_rate)[0] ?? null;
  const totalSpend = results.reduce((a, r) => a + r.spend_usd, 0);

  return (
    <div className="ws-experiment">
      <section className="rs-panel" id="experiment">
        <div className="rs-panel-head">
          <div>
            <h3>{tt("ws.exp.brief")}</h3>
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
            {msg && <span role="status" className="pill pill-success">{msg}</span>}
            {err && <span role="alert" className="err">{err}</span>}
          </div>
        </form>
      </section>

      <section className="rs-panel" id="results">
        <div className="rs-panel-head">
          <div>
            <h3>{tt("ws.exp.results")}</h3>
            <p>{tt("ws.exp.resultsSub")} {tt("ws.exp.benchmark", { hold: Math.round(benchmark.hook_hold_rate * 100), ctr: (benchmark.ctr * 100).toFixed(1) })}</p>
          </div>
          {fixtureMode && locked && results.length === 0 && canEdit && (
            <span className="rs-panel-aside"><button className="btn btn-outline btn-sm" type="button" onClick={simulate} disabled={busy !== null} title={tt("ws.exp.simulateNote")}>{busy === "simulate" ? tt("common.loading") : tt("ws.exp.simulate")}</button></span>
          )}
        </div>
        {results.length === 0 ? (
          <div className="rs-empty">{tt("ws.exp.noResults")} {fixtureMode && locked && <small className="gt-muted">{tt("ws.exp.simulateNote")}</small>}</div>
        ) : (
          <div className="gtable gtable-flush rs-table" style={{ ["--cols" as string]: "minmax(0,2fr) 90px 90px 90px 80px 80px 90px 80px" }}>
            <div className="gt-head"><span>{tt("ws.exp.col.creative")}</span><span className="gt-num">{tt("ws.exp.col.impressions")}</span><span className="gt-num">{tt("ws.exp.col.views")}</span><span className="gt-num">{tt("ws.exp.col.hold")}</span><span className="gt-num">{tt("ws.exp.col.ctr")}</span><span className="gt-num">{tt("ws.exp.col.spend")}</span><span className="gt-num">{tt("ws.exp.col.landing")}</span><span>{tt("ws.exp.col.source")}</span></div>
            {scored.map(({ r, c, ctr }) => {
              const wins = winner?.r.id === r.id;
              return (
                <div className={`gt-row${wins ? " is-winner" : ""}`} key={r.id}>
                  <span style={{ minWidth: 0 }}><span className="rs-title-name">{c?.hypothesis ?? r.creative_id}</span><span className="rs-title-sub">{c ? `${c.kind} · ${c.hook}` : ""}{wins ? ` · ${tt("ws.exp.winner")}` : ""}</span></span>
                  <span className="gt-num">{r.impressions.toLocaleString("en-US")}</span>
                  <span className="gt-num">{r.video_views.toLocaleString("en-US")}</span>
                  <span className={`gt-num${r.hook_hold_rate >= benchmark.hook_hold_rate ? " delta-up" : " delta-down"}`}>{Math.round(r.hook_hold_rate * 100)}%</span>
                  <span className={`gt-num${ctr >= benchmark.ctr ? " delta-up" : " delta-down"}`}>{(ctr * 100).toFixed(2)}%</span>
                  <span className="gt-num">${r.spend_usd.toFixed(2)}</span>
                  <span className="gt-num">{r.landing_actions ?? "–"}</span>
                  <span><span className={`state ${r.source === "demo" ? "state-unavailable" : "state-available"}`}>{tt(`ws.exp.source.${r.source}`)}</span></span>
                </div>
              );
            })}
            <div className="rs-panel-foot">{tt("ws.exp.col.spend")}: ${totalSpend.toFixed(2)} · {results[0]?.window_start} → {results[results.length - 1]?.window_end}</div>
          </div>
        )}
      </section>

      {results.length > 0 && (
        <section className="rs-panel" id="decide">
          <div className="rs-panel-head">
            <div>
              <h3>{tt("ws.exp.decide")}</h3>
              <p>{tt("ws.exp.decideSub")}</p>
            </div>
          </div>
          <div className="rs-panel-body">
            {winner ? (
              <p><b>{tt("ws.exp.winner")}:</b> {winner.c?.hypothesis} <span className="gt-muted">({Math.round(winner.r.hook_hold_rate * 100)}% · {(winner.ctr * 100).toFixed(2)}%)</span></p>
            ) : (
              <p className="note note-warn">{tt("ws.exp.noWinner")}</p>
            )}
            <div className="rs-tool-row">
              {winner && <button className="btn btn-primary" type="button" disabled={!canEdit || busy !== null} onClick={() => nextRound(Math.round((e?.budget_usd ?? 100) * 3), `Scale the winning concept: "${winner.c?.hypothesis ?? ""}". Same audience; 3× the first budget.`)}>{tt("ws.exp.scaleUp", { n: Math.round((e?.budget_usd ?? 100) * 3) })}</button>}
              <button className="btn btn-outline" type="button" disabled={!canEdit || busy !== null} onClick={() => nextRound(e?.budget_usd ?? 100, winner ? `More variations of the winning concept: "${winner.c?.hypothesis ?? ""}". Same audience and budget.` : "New variations after a round with no concept above both benchmarks. Same audience and budget.")}>{tt("ws.exp.moreVariations")}</button>
              <a className="btn btn-ghost" href="/producer/promote">{tt("ws.exp.stop")}</a>
            </div>
            {msg && <p role="status" className="note note-success">{msg}</p>}
            {err && <p role="alert" className="err">{err}</p>}
          </div>
        </section>
      )}
    </div>
  );
}
