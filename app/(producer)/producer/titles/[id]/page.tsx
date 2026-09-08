import TitleShell, { sectionHref } from "@/components/producer/TitleShell";
import { isStaffPreview, portalSession, producerLocale } from "@/components/producer/server";
import { BandPill } from "@/components/producer/research/workspace-ui";
import { fmtCount, fmtPct } from "@/components/producer/research/ui";
import { MetricValue, StateChip, fmtUsd } from "@/components/producer/analytics/bits";
import { t } from "@/lib/i18n";
import { parseRange } from "@/lib/analytics/types";
import { BENCHMARK } from "@/lib/research/assessment";
import { adCtr, adSpend } from "@/lib/research/title-status";
import { loadTitleWorkspace } from "@/lib/research/title-workspace";

// /producer/titles/[id] — the title overview (decision 2026-09-09): one
// screen that says where the title is on TikTok, what advertising is doing,
// how prepared it is and what materials exist, each with the way into its
// section. The composite US potential score stays in Preparation; here the
// band and the next step are enough.

export const dynamic = "force-dynamic";

export default async function TitleOverview({ params, searchParams }: { params: { id: string }; searchParams: { range?: string } }) {
  const session = await portalSession(`/producer/titles/${params.id}`);
  const locale = producerLocale();
  const range = parseRange(searchParams.range);
  const w = await loadTitleWorkspace(session, params.id, range);
  const canEdit = !isStaffPreview(session) && (session.producerRole === "reviewer" || session.producerRole === "approver");
  const x = w.title;
  const a = x.assessment;
  const episodes = w.detail.episodes;
  const withVideo = episodes.filter((e) => e.has_video).length;
  const approved = episodes.filter((e) => e.status === "approved").length;
  const spend = adSpend(x.results);
  const ctr = adCtr(x.results);
  const tiktokHref = sectionHref(params.id, "tiktok", `?range=${range}`);
  const step = w.ads.flow ? t(locale, `workflow.step.${w.ads.flow.step}`) : null;

  // The next action: the campaign's own next step when one is waiting on the
  // producer; otherwise the most useful preparation step.
  let next: { href: string; label: string; hint: string };
  if (w.ads.flow && !w.ads.flow.waiting) next = { href: w.ads.flow.href, label: t(locale, w.ads.flow.action), hint: t(locale, w.ads.flow.hint) };
  else if (w.ads.flow) next = { href: w.ads.flow.href, label: t(locale, "workflow.viewLaunch"), hint: t(locale, w.ads.flow.hint) };
  else if (withVideo === 0) next = { href: sectionHref(params.id, "materials"), label: t(locale, "tw.next.uploadVideo"), hint: t(locale, "workflow.needsVideo") };
  else next = { href: `/producer/promote/new?title=${params.id}`, label: t(locale, "ws.actions.test"), hint: t(locale, "tw.next.firstCampaignHint") };

  return (
    <TitleShell locale={locale} titleId={params.id} name_zh={w.detail.title.name_zh} name_en={w.detail.title.name_en} platform={w.platform} ads={w.ads.status} adStep={step} section="overview" tiktokQuery={`?range=${range}`}
      actions={<a className="btn btn-primary" href={next.href}>{next.label}</a>}>
      <p className="tw-next-hint">{next.hint}</p>

      <div className="tw-grid">
        <section className="tw-card tw-card-tiktok" aria-labelledby="tw-tiktok">
          <header><h2 id="tw-tiktok">{t(locale, "tw.nav.tiktok")}</h2><a href={tiktokHref}>{t(locale, "tw.open")}&nbsp;→</a></header>
          {w.tiktok && w.tiktok.revenue.value != null ? (
            <dl className="tw-facts">
              <div><dt>{t(locale, `an.basis.${w.tiktok.revenue.basis}`)} · {t(locale, `an.range.${range}`)}</dt><dd className="tw-big">{fmtUsd(w.tiktok.revenue.value, 0)}</dd></div>
              <div><dt>{t(locale, "an.catalog.col.viewers")}</dt><dd>{w.tiktok.viewers.value != null ? fmtCount(w.tiktok.viewers.value) : <MetricValue m={w.tiktok.viewers} unit="count" locale={locale} compact />}</dd></div>
              <div><dt>{t(locale, "an.catalog.col.conversion")}</dt><dd>{w.tiktok.payer_conversion.value != null ? fmtPct(w.tiktok.payer_conversion.value, 2) : <MetricValue m={w.tiktok.payer_conversion} unit="rate" locale={locale} compact />}</dd></div>
              <div><dt>{t(locale, "an.catalog.col.state")}</dt><dd><StateChip state={w.tiktok.analytics_state} locale={locale} />{w.tiktok.freshness.data_through && <small> {t(locale, "an.dataThrough", { date: w.tiktok.freshness.data_through, lag: w.tiktok.freshness.lag_days ?? 0 })}</small>}</dd></div>
            </dl>
          ) : (
            <div className="tw-empty">
              <StateChip state={w.tiktok?.analytics_state ?? "needs_listing_link"} locale={locale} />
              <p>{t(locale, w.platform === "not_linked" ? "tw.tiktok.notLinked" : w.platform === "awaiting_data" ? "tw.tiktok.awaiting" : "tw.tiktok.noValue")}</p>
              {w.platform === "not_linked" && canEdit && <a className="btn btn-outline btn-sm" href={`${tiktokHref.replace(/\?.*$/, "")}/link?range=${range}`}>{t(locale, "an.link.cta")}</a>}
            </div>
          )}
          {w.tiktok?.source === "demo" && <p className="tw-demo">{t(locale, "an.demo.chip")}</p>}
        </section>

        <section className="tw-card tw-card-ads" aria-labelledby="tw-ads">
          <header><h2 id="tw-ads">{t(locale, "tw.nav.campaigns")}</h2><a href={sectionHref(params.id, "campaigns")}>{t(locale, "tw.open")}&nbsp;→</a></header>
          {w.ads.campaign ? (
            <dl className="tw-facts">
              <div><dt>{t(locale, "tw.ads.spendToDate")}</dt><dd className="tw-big">{spend == null ? <span className="tw-muted">{t(locale, "tw.ads.noSpend")}</span> : fmtUsd(spend, 0)}</dd></div>
              <div><dt>{t(locale, "tw.ads.ctrToDate")}</dt><dd>{ctr ? <><b className={ctr.ctr >= BENCHMARK.ctr ? "delta-up" : "delta-down"}>{fmtPct(ctr.ctr, 2)}</b> <small>{ctr.ctr >= BENCHMARK.ctr ? "✓" : "✗"} ≥ {(BENCHMARK.ctr * 100).toFixed(1)}%</small></> : <span className="tw-muted">{t(locale, "tw.ads.noResults")}</span>}</dd></div>
              <div><dt>{t(locale, "tw.ads.rounds")}</dt><dd>{w.ads.rounds}</dd></div>
              <div><dt>{t(locale, "ws.exp.col.stage")}</dt><dd><a href={w.ads.flow!.href}>{w.ads.campaign.name}</a><small> · {step}</small></dd></div>
            </dl>
          ) : (
            <div className="tw-empty">
              <p>{t(locale, "tw.ads.noneYet")}</p>
              {canEdit && <a className="btn btn-outline btn-sm" href={`/producer/promote/new?title=${params.id}`}>{t(locale, "ws.actions.test")}</a>}
            </div>
          )}
          {x.results.some((r) => r.source === "demo") && <p className="tw-demo">{t(locale, "rd.sourceDemo")}</p>}
        </section>

        <section className="tw-card" aria-labelledby="tw-prep">
          <header><h2 id="tw-prep">{t(locale, "tw.nav.preparation")}</h2><a href={sectionHref(params.id, "preparation")}>{t(locale, "tw.open")}&nbsp;→</a></header>
          <dl className="tw-facts">
            <div><dt>{t(locale, "tw.prep.band")}</dt><dd><BandPill band={a.band} locale={locale} /></dd></div>
            <div><dt>{t(locale, "ws.catalog.col.rights")}</dt><dd className={x.facts.rights === "outside" ? "delta-down" : undefined}>{t(locale, `ws.catalog.rights.${x.facts.rights}`)}</dd></div>
            <div><dt>{t(locale, "tw.prep.nextSteps")}</dt><dd><ol className="tw-steps">{a.next.slice(0, 2).map((k) => <li key={k}>{t(locale, k)}</li>)}</ol></dd></div>
          </dl>
        </section>

        <section className="tw-card" aria-labelledby="tw-materials">
          <header><h2 id="tw-materials">{t(locale, "tw.nav.materials")}</h2><a href={sectionHref(params.id, "materials")}>{t(locale, "tw.open")}&nbsp;→</a></header>
          <dl className="tw-facts">
            <div><dt>{t(locale, "v3.title.episodes")}</dt><dd className="tw-big">{episodes.length}<small> / {w.detail.title.episode_count}</small></dd></div>
            <div><dt>{t(locale, "ws.catalog.col.video")}</dt><dd>{withVideo > 0 ? t(locale, "ws.catalog.video.n", { n: withVideo }) : t(locale, "ws.catalog.video.none")}</dd></div>
            <div><dt>{t(locale, "ws.catalog.col.subs")}</dt><dd>{approved > 0 ? t(locale, "ws.catalog.subs.approved", { n: approved }) : x.summary.percent_adapted > 0 ? t(locale, "redesign.catalog.partialSubs", { pct: x.summary.percent_adapted }) : t(locale, "ws.catalog.subs.none")}</dd></div>
          </dl>
        </section>
      </div>
    </TitleShell>
  );
}
