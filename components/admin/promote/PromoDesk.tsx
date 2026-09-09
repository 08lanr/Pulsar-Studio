"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { postJson } from "@/lib/api-client";
import { useT } from "@/components/locale";
import type { PromoCampaignDetail, PromoCreative } from "@/lib/types";

// Pulsar's side of a promotion (decision 2026-09-09: staff monitor and
// intervene, they do not approve). A change request gets answered with a
// revised version; a launched campaign shows its launch record with the
// TikTok ids, the spend ceiling and TikTok's answer, and the controls:
// sync now, pause / resume on TikTok, retry a failed launch. The status
// override stays behind a disclosure for troubleshooting only.

const STATUS_CLASS: Record<PromoCampaignDetail["campaign"]["status"], string> = {
  draft: "pill-neutral", generating: "pill-neutral", review: "status-review", approved: "status-approved",
  submitted: "pill-accent", launching: "status-adapting", live: "status-live", paused: "pill-warning", ended: "pill-neutral", failed: "pill-error",
};
const CREATIVE_CLASS: Record<PromoCreative["status"], string> = {
  draft: "pill-neutral", ready: "pill-neutral", approved: "status-approved", rejected: "status-changes", not_selected: "pill-neutral", superseded: "pill-neutral",
};

function seconds(ms: number | null) { return ms === null ? "—" : `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`; }
const dash = (v: string | null | undefined) => (v && v.trim() ? v : "—");

type Draft = { hypothesis: string; hook: string; caption: string; ad_description: string; start: string; end: string; revision_note: string };
const draftOf = (c: PromoCreative): Draft => ({ hypothesis: c.hypothesis, hook: c.hook, caption: c.caption, ad_description: c.ad_description, start: c.source_start_ms === null ? "" : String(c.source_start_ms / 1000), end: c.source_end_ms === null ? "" : String(c.source_end_ms / 1000), revision_note: "" });

type SyncSummary = { polled: number; synced: number; errors: string[] };

export default function PromoDesk({ detail, media, renders = {} }: { detail: PromoCampaignDetail; media: Record<string, string | null>; renders?: Record<string, string | null> }) {
  const { tt } = useT();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [growId, setGrowId] = useState(detail.campaign.grow_campaign_id ?? "");
  const [note, setNote] = useState("");

  const { campaign, launch } = detail;
  const active = detail.creatives.filter((c) => c.status !== "superseded");
  const approved = active.filter((c) => c.status === "approved").length;
  const changes = active.filter((c) => c.status === "rejected").length;
  const inReview = campaign.status === "review";
  const launched = ["launching", "submitted", "live", "paused", "ended", "failed"].includes(campaign.status);
  const switchable = ["submitted", "live", "paused"].includes(campaign.status) && !!campaign.grow_campaign_id;

  async function post<T = unknown>(key: string, path: string, body: Record<string, unknown>): Promise<T | null> {
    setBusy(key); setError(null); setInfo(null);
    try { const r = await postJson<T>(path, body); setOpen(null); setDraft(null); router.refresh(); return r; }
    catch (e) { setError((e as Error).message); return null; }
    finally { setBusy(null); }
  }
  function startRevision(c: PromoCreative) { setOpen(c.id); setDraft(draftOf(c)); setError(null); }
  async function sendRevision(c: PromoCreative) {
    if (!draft) return;
    const toMs = (s: string) => (s.trim() === "" ? null : Math.round(Number(s) * 1000));
    await post(c.id, `/api/promote/creatives/${c.id}/revise`, {
      hypothesis: draft.hypothesis.trim() || null, hook: draft.hook, caption: draft.caption, ad_description: draft.ad_description,
      source_start_ms: toMs(draft.start), source_end_ms: toMs(draft.end), revision_note: draft.revision_note.trim() || null,
    });
  }
  const advance = (status: "launching" | "live" | "failed") => post(`status-${status}`, `/api/promote/${campaign.id}/status`, { status, grow_campaign_id: growId.trim() || null, note: note.trim() || null });
  const sync = async () => {
    const r = await post<{ summary: SyncSummary }>("sync", "/api/promote/sync", {});
    if (r) setInfo(tt("admin.promote.launch.synced", { polled: r.summary.polled, synced: r.summary.synced, errors: r.summary.errors.length }));
  };
  const flip = async (on: boolean) => {
    const r = await post<{ applied: boolean; note: string | null }>("switch", `/api/promote/${campaign.id}/switch`, { on });
    if (r && !r.applied) setInfo(tt("admin.promote.launch.notApplied"));
  };
  const retry = () => post("retry", `/api/promote/${campaign.id}/retry`, {});

  return <div className="pd">
    <div className="stat-grid">
      <div className="stat"><span className="stat-label">{tt("admin.promote.stat.status")}</span><strong className="stat-value"><span className={`pill ${STATUS_CLASS[campaign.status]}`}>{tt(`admin.promote.status.${campaign.status}`)}</span></strong></div>
      <div className="stat"><span className="stat-label">{tt("admin.promote.stat.creatives")}</span><strong className="stat-value">{approved}/{active.length}</strong></div>
      <div className={`stat ${changes ? "stat-attention" : ""}`}><span className="stat-label">{tt("admin.promote.stat.changes")}</span><strong className="stat-value">{changes}</strong></div>
      <div className="stat"><span className="stat-label">{tt("admin.promote.stat.grow")}</span><strong className="stat-value pd-mono">{dash(campaign.grow_campaign_id)}</strong></div>
    </div>
    {error && <p className="note note-warn" role="alert">{error}</p>}
    {info && <p className="note note-info" role="status">{info}</p>}

    <div className="pd-grid">
      <section className="pd-main">
        <div className="pd-section-head"><h2 className="section-title">{tt("admin.promote.creatives")}</h2><p className="page-sub">{tt("admin.promote.creatives.sub")}</p></div>
        {!active.length && <div className="empty"><p>{tt("admin.promote.launch.waiting")}</p></div>}
        {active.map((c, index) => {
          const ep = detail.episodes.find((e) => e.id === c.source_episode_id);
          const rendered = c.render_path ? renders[c.id] : null;
          const source = c.source_episode_id ? media[c.source_episode_id] : null;
          const history = detail.creatives.filter((x) => x.status === "superseded" && lineage(detail.creatives, c).includes(x.id)).length;
          const editing = open === c.id && draft;
          const adId = launch?.ad_ids[c.id];
          return <article className={`card pd-creative ${c.status}`} key={c.id}>
            <div className="pd-creative-media">{rendered ? <video src={rendered} controls preload="metadata" /> : source ? <video src={`${source}#t=${Math.floor((c.source_start_ms ?? 0) / 1000)}`} controls preload="metadata" /> : <div className="pd-placeholder">{String(index + 1).padStart(2, "0")}</div>}</div>
            <div className="pd-creative-body">
              <header>
                <div><span className="kicker">{tt(`promote.kind.${c.kind}`)} · {tt("admin.promote.version", { v: c.version })}{history > 0 && <> · {tt("admin.promote.history", { n: history })}</>}{adId && <> · <span className="pd-mono">ad {adId}</span></>}</span><h3>{c.hypothesis}</h3></div>
                <span className={`pill ${CREATIVE_CLASS[c.status]}`}>{tt(`promote.creativeStatus.${c.status}`)}</span>
              </header>
              <dl className="pd-kv">
                <dt>{tt("admin.promote.source")}</dt><dd>{tt("admin.promote.episode", { n: ep?.number ?? 0 })} · {seconds(c.source_start_ms)}–{seconds(c.source_end_ms)}{c.render_sha256 && <> · <span className="pd-mono">{c.render_sha256.slice(0, 12)}…</span></>}</dd>
                <dt>{tt("admin.promote.revise.hook")}</dt><dd>{c.hook}</dd>
                <dt>{tt("admin.promote.revise.caption")}</dt><dd>{c.caption}</dd>
                <dt>{tt("admin.promote.revise.description")}</dt><dd>{c.ad_description}</dd>
              </dl>
              {c.status === "rejected" && <div className="pd-ask"><span>{tt("admin.promote.producerAsked")}</span><p>{c.rejection_note}</p></div>}
              {c.revision_note && <div className="pd-revnote"><span>{tt("admin.promote.revise.note")}</span><p>{c.revision_note}</p></div>}
              {(c.status === "rejected" || c.status === "ready") && !editing && (inReview
                ? <div className="pd-actions"><button type="button" className={`btn ${c.status === "rejected" ? "btn-primary" : "btn-outline"}`} onClick={() => startRevision(c)}>{tt("admin.promote.revise")}</button></div>
                : c.status === "rejected" && <p className="pd-muted">{tt("admin.promote.revise.closed")}</p>)}
              {editing && <form className="pd-revise" onSubmit={(e) => { e.preventDefault(); void sendRevision(c); }}>
                <div className="field"><label className="label">{tt("admin.promote.revise.hypothesis")}</label><input className="input" value={draft.hypothesis} onChange={(e) => setDraft({ ...draft, hypothesis: e.target.value })} /></div>
                <div className="field"><label className="label">{tt("admin.promote.revise.hook")}</label><input className="input" value={draft.hook} required onChange={(e) => setDraft({ ...draft, hook: e.target.value })} /></div>
                <div className="field"><label className="label">{tt("admin.promote.revise.caption")}</label><textarea className="textarea" rows={2} value={draft.caption} required onChange={(e) => setDraft({ ...draft, caption: e.target.value })} /></div>
                <div className="field"><label className="label">{tt("admin.promote.revise.description")}</label><textarea className="textarea" rows={2} value={draft.ad_description} required onChange={(e) => setDraft({ ...draft, ad_description: e.target.value })} /></div>
                <div className="pd-row"><div className="field"><label className="label">{tt("admin.promote.revise.start")}</label><input className="input" type="number" min={0} step="0.1" value={draft.start} onChange={(e) => setDraft({ ...draft, start: e.target.value })} /></div><div className="field"><label className="label">{tt("admin.promote.revise.end")}</label><input className="input" type="number" min={0} step="0.1" value={draft.end} onChange={(e) => setDraft({ ...draft, end: e.target.value })} /></div></div>
                <div className="field"><label className="label">{tt("admin.promote.revise.note")}</label><textarea className="textarea" rows={2} value={draft.revision_note} onChange={(e) => setDraft({ ...draft, revision_note: e.target.value })} /></div>
                <div className="pd-actions"><button className="btn btn-primary" disabled={busy === c.id}>{busy === c.id ? tt("common.loading") : tt("admin.promote.revise.submit")}</button><button type="button" className="btn btn-ghost" onClick={() => { setOpen(null); setDraft(null); }}>{tt("admin.promote.revise.cancel")}</button></div>
              </form>}
            </div>
          </article>;
        })}
      </section>

      <aside className="pd-side">
        <section className="card pd-panel">
          <h2 className="section-title">{tt("admin.promote.launch")}</h2>
          {!launched && <p className="pd-muted">{tt("admin.promote.launch.waiting")}</p>}
          {launched && <>
            <p className="pd-muted">{tt(`admin.promote.launch.${campaign.status as "submitted" | "launching" | "live" | "paused" | "ended" | "failed"}`, { n: approved })}</p>
            {campaign.status_note && <div className="pd-ask"><span>{tt("promote.launch.note")}</span><p>{campaign.status_note}</p></div>}
            {launch && <dl className="pd-kv">
              <dt>{tt("admin.promote.launch.mode")}</dt><dd>{tt(`promote.launch.mode.${launch.mode}`)}</dd>
              <dt>{tt("admin.promote.launch.advertiser")}</dt><dd className="pd-mono">{launch.advertiser_id}</dd>
              <dt>{tt("admin.promote.launch.identity")}</dt><dd className="pd-mono">{launch.identity_id ? `${launch.identity_id} (${launch.identity_type})` : "—"}</dd>
              <dt>{tt("admin.promote.launch.budget")}</dt><dd>${launch.budget_usd}</dd>
              <dt>{tt("admin.promote.launch.tiktokIds")}</dt><dd className="pd-mono">{dash(launch.tiktok_campaign_id)} / {dash(launch.tiktok_adgroup_id)}</dd>
              <dt>{tt("admin.promote.launch.ads")}</dt><dd>{Object.keys(launch.ad_ids).length}</dd>
              <dt>{tt("admin.promote.launch.attempts")}</dt><dd>{launch.attempts} · {launch.status}</dd>
              {launch.error && <><dt>{tt("admin.promote.launch.error")}</dt><dd>{launch.error}</dd></>}
            </dl>}
            <div className="pd-actions pd-wrap">
              <button type="button" className="btn btn-outline" disabled={!!busy} onClick={sync}>{busy === "sync" ? tt("common.loading") : tt("admin.promote.launch.sync")}</button>
              {switchable && campaign.status !== "paused" && <button type="button" className="btn btn-outline" disabled={!!busy} onClick={() => flip(false)}>{tt("admin.promote.launch.pause")}</button>}
              {switchable && campaign.status === "paused" && <button type="button" className="btn btn-primary" disabled={!!busy} onClick={() => flip(true)}>{tt("admin.promote.launch.resume")}</button>}
              {campaign.status === "failed" && launch && <button type="button" className="btn btn-primary" disabled={!!busy} onClick={retry}>{busy === "retry" ? tt("common.loading") : tt("admin.promote.launch.retry")}</button>}
            </div>
            {campaign.status !== "live" && campaign.status !== "ended" && <details className="pd-override" style={{ marginTop: 12 }}>
              <summary className="pd-muted">{tt("admin.promote.launch.override")}</summary>
              <p className="pd-muted">{tt("admin.promote.launch.overrideNote")}</p>
              <div className="field"><label className="label">{tt("admin.promote.launch.growId")}</label><input className="input pd-mono" value={growId} onChange={(e) => setGrowId(e.target.value)} /></div>
              <div className="field"><label className="label">{tt("admin.promote.launch.note")}</label><textarea className="textarea" rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></div>
              <div className="pd-actions pd-wrap">
                {campaign.status === "failed" && <button type="button" className="btn btn-ghost" disabled={!!busy} onClick={() => advance("launching")}>{tt("admin.promote.launch.markLaunching")}</button>}
                {["submitted", "launching", "paused"].includes(campaign.status) && <button type="button" className="btn btn-ghost" disabled={!!busy} onClick={() => advance("live")}>{tt("admin.promote.launch.markLive")}</button>}
                {["submitted", "launching", "paused"].includes(campaign.status) && <button type="button" className="btn btn-ghost" disabled={!!busy} onClick={() => advance("failed")}>{tt("admin.promote.launch.markFailed")}</button>}
              </div>
            </details>}
          </>}
        </section>

        <section className="card pd-panel">
          <h2 className="section-title">{tt("admin.promote.brief")}</h2>
          <dl className="pd-kv">
            <dt>{tt("admin.promote.brief.market")}</dt><dd>{campaign.target_market}</dd>
            <dt>{tt("admin.promote.brief.objective")}</dt><dd>{tt(`promote.objective.${campaign.objective}`)}</dd>
            <dt>{tt("admin.promote.brief.spoilers")}</dt><dd>{tt(`promote.spoiler.${campaign.spoiler_level}`)}</dd>
            <dt>{tt("admin.promote.brief.destination")}</dt><dd className="pd-mono">{dash(campaign.destination_url)}</dd>
            <dt>{tt("admin.promote.brief.direction")}</dt><dd>{dash(campaign.creative_direction)}</dd>
            <dt>{tt("admin.promote.brief.exclusions")}</dt><dd>{dash(campaign.exclusions)}</dd>
          </dl>
        </section>

        {(detail.approval || detail.handoffs.length > 0) && <section className="card pd-panel">
          {detail.approval && <><h2 className="section-title">{tt("admin.promote.manifest")}</h2><p className="pd-mono pd-muted">{detail.approval.manifest_sha256.slice(0, 16)}… · {(detail.approval.manifest as { creatives?: unknown[] }).creatives?.length ?? 0}</p></>}
          {detail.handoffs.length > 0 && <><h2 className="section-title">{tt("admin.promote.handoffs")}</h2><ul className="pd-list">{detail.handoffs.map((h) => <li key={h.id}><span className={`pill ${h.status === "accepted" ? "status-approved" : h.status === "failed" ? "pill-error" : "pill-neutral"}`}>{h.status}</span><span className="pd-mono">{h.attempted_at.slice(0, 16).replace("T", " ")}</span></li>)}</ul></>}
        </section>}
      </aside>
    </div>
  </div>;
}

/** Ids of every ancestor of `c` through parent_creative_id. */
function lineage(all: PromoCreative[], c: PromoCreative): string[] {
  const out: string[] = [];
  let cur: PromoCreative | undefined = c;
  while (cur?.parent_creative_id) { out.push(cur.parent_creative_id); cur = all.find((x) => x.id === cur!.parent_creative_id); }
  return out;
}
