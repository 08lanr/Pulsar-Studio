import { notFound } from "next/navigation";
import DeliveryPanel from "@/components/tiktok/DeliveryPanel";
import { isStaffPreview, portalSession, producerLocale } from "@/components/producer/server";
import { getData, isDataError } from "@/lib/data";
import { mediaUrl } from "@/lib/data/storage";
import { t } from "@/lib/i18n";

export const dynamic = "force-dynamic";

export default async function EarlierCampaign({ params }: { params: { campaignId: string } }) {
  const session = await portalSession(`/producer/promote/${params.campaignId}`);
  const locale = producerLocale();
  let detail;
  try {
    detail = await getData().getPromoCampaign(session, params.campaignId);
  } catch (error) {
    if (isDataError(error) && (error.code === "not_found" || error.code === "forbidden")) notFound();
    throw error;
  }

  const { campaign, title, launch } = detail;
  const titleName = locale === "en" ? title.name_en || title.name_zh : title.name_zh;
  const creatives = detail.creatives.filter((creative) => creative.status !== "superseded");
  const canStop = !isStaffPreview(session) && session.producerRole === "approver";
  const hasDelivery = !!launch?.tiktok_campaign_id && !!campaign.grow_campaign_id;

  return <div className="fc-campaign">
    <nav className="studio-crumbs" aria-label={t(locale, "v3.breadcrumbs")}>
      <a href="/producer/titles">{t(locale, "ws.nav.catalog")}</a><span>›</span>
      <a href={`/producer/titles/${title.id}`}>{titleName}</a><span>›</span>
      <a href={`/producer/titles/${title.id}/campaigns`}>{t(locale, "tw.nav.campaigns")}</a><span>›</span>
      <span>{campaign.name}</span>
    </nav>

    <div className="page-head"><div>
      <p className="page-kicker">{t(locale, "lv2.legacyCampaigns")}</p>
      <h1>{campaign.name}</h1>
      <p className="page-sub">{t(locale, "legacy.historyNote")}</p>
    </div><span className="rs-tool-row">
      <a className="btn btn-outline btn-sm" href={`/producer/titles/${title.id}/campaigns`}>{t(locale, "tw.backTo", { section: t(locale, "tw.nav.campaigns") })}</a>
      <a className="btn btn-primary" href="/producer/launch">{t(locale, "lv2.launch.title")}&nbsp;→</a>
    </span></div>

    {hasDelivery && <DeliveryPanel campaignId={campaign.id} status={campaign.status} launch={launch} monitorUrl={`/api/producer/promote/${campaign.id}/monitor`} controlsUrl={`/api/producer/promote/${campaign.id}/controls`} canAct={canStop} stopOnly />}

    <section className="rs-panel" id="brief">
      <div className="rs-panel-head"><h2>{t(locale, "legacy.record")}</h2><span className="pill pill-neutral">{t(locale, `promote.status.${campaign.status}`)}</span></div>
      <dl className="rs-kv">
        <dt>{t(locale, "legacy.title")}</dt><dd>{titleName}</dd>
        <dt>{t(locale, "legacy.market")}</dt><dd>{campaign.target_market}</dd>
        <dt>{t(locale, "legacy.destination")}</dt><dd>{campaign.destination_url || "—"}</dd>
        <dt>{t(locale, "legacy.approvedBudget")}</dt><dd>{campaign.experiment?.approved_at ? `$${campaign.experiment.budget_usd}` : "—"}</dd>
        {campaign.status_note && <><dt>{t(locale, "legacy.statusNote")}</dt><dd>{campaign.status_note}</dd></>}
      </dl>
    </section>

    <section className="fc-ads-section" id="ads">
      <header className="fc-section-heading"><h2>{t(locale, "legacy.creatives")}</h2><p>{t(locale, "legacy.readOnly")}</p></header>
      {creatives.length === 0 && <p className="gt-muted">{t(locale, "legacy.noCreatives")}</p>}
      <div className="promo-campaign-grid">{creatives.map((creative) => {
        const path = creative.render_path || detail.episodes.find((episode) => episode.id === creative.source_episode_id)?.video_path;
        return <article className="card" key={creative.id}>
          {path && <video src={mediaUrl(path) ?? undefined} controls preload="metadata" />}
          <div className="pd-creative-body"><header><h3>{creative.hook || creative.external_id}</h3><span className="pill pill-neutral">{t(locale, `promote.creativeStatus.${creative.status}`)}</span></header>
            <p>{creative.caption}</p><small className="pd-mono">{creative.external_id}</small>
          </div>
        </article>;
      })}</div>
    </section>

    <section className="rs-panel" id="results">
      <div className="rs-panel-head"><h2>{t(locale, "legacy.results")}</h2></div>
      {detail.results.length === 0 ? <p className="gt-muted">{t(locale, "legacy.noResults")}</p> : <div className="pd-grid">{detail.results.map((row) => {
        const creative = detail.creatives.find((item) => item.id === row.creative_id);
        return <article className="card pd-panel" key={row.id}>
          <h3>{creative?.hook || creative?.external_id || row.creative_id}</h3>
          <dl className="pd-kv">
            <dt>{t(locale, "legacy.source")}</dt><dd>{row.source}</dd>
            <dt>{t(locale, "legacy.spend")}</dt><dd>{row.spend_usd === null ? "—" : `$${row.spend_usd.toFixed(2)}`}</dd>
            <dt>{t(locale, "legacy.clicks")}</dt><dd>{row.clicks ?? "—"}</dd>
            <dt>{t(locale, "legacy.impressions")}</dt><dd>{row.impressions ?? "—"}</dd>
            <dt>{t(locale, "legacy.observed")}</dt><dd>{row.observed_at}</dd>
          </dl>
        </article>;
      })}</div>}
    </section>
  </div>;
}
