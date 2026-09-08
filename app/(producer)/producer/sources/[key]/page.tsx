import { sourceCopy } from '@/lib/research/source-copy';
import { notFound } from "next/navigation";
import { portalSession, producerLocale } from "@/components/producer/server";
import { EvidenceTag, StateBadge, fmtUtc, platformName } from "@/components/producer/research/ui";
import { getData } from "@/lib/data";
import { t } from "@/lib/i18n";
import { GROUP_LABELS, METRICS, metricByKey, sourceByKey, statusFor, sourceStatus } from "@/lib/research/registry";

// /producer/sources/[key] — the methodology view a metric label opens:
// business meaning, grain, source field, unit, denominator, window,
// evidence, formula and version, limitations, and the live status. A
// source key shows the source card with its review note and the metrics
// that depend on it.

export const dynamic = "force-dynamic";

export default async function SourceEntryPage({ params }: { params: { key: string } }) {
  const session = await portalSession(`/producer/sources/${params.key}`);
  const locale = producerLocale();
  const data = getData();
  const [market, profile, batches] = await Promise.all([data.getMarket(session), data.getResearchProfile(session), data.listReportBatches(session)]);
  const ctx = { view: market, hasReports: batches.some((b) => !b.reverted_at), hasProfile: Boolean(profile) };
  const metric = metricByKey(params.key);
  const source = metric ? sourceByKey(metric.source_key) : sourceByKey(params.key);
  if (!metric && !source) notFound();

  const crumbs = (
    <nav className="studio-crumbs" aria-label={t(locale, "v3.breadcrumbs")}>
      <a href="/producer/sources">{t(locale, "research.sources.title")}</a>
      <span>›</span>
      <span>{metric ? (locale === "zh" ? metric.name_zh : metric.name_en) : sourceCopy(source!,locale).name}</span>
    </nav>
  );

  if (metric) {
    const status = statusFor(metric.status_rule, ctx);
    return (
      <>
        {crumbs}
        <div className="page-head">
          <div>
            <span className="page-kicker">{GROUP_LABELS[metric.group][locale]}</span>
            <h1>{locale === "zh" ? metric.name_zh : metric.name_en}</h1>
            <p className="page-sub">{locale === "zh" ? metric.question_zh : metric.question_en}</p>
          </div>
          <StateBadge status={status} locale={locale} />
        </div>
        <div className="rs-detail">
          <section className="rs-panel">
            <details className="brief-section"><summary>{t(locale,"ux.advancedData")}</summary><dl className="rs-kv">
              <dt>{t(locale, "research.sources.grain")}</dt><dd>{metric.grain}</dd>
              <dt>{t(locale, "research.sources.source")}</dt><dd>{source ? <a href={`/producer/sources/${source.key}`}>{sourceCopy(source,locale).name}</a> : metric.source_key}</dd>
              <dt>{t(locale, "research.sources.field")}</dt><dd>{metric.source_field ?? "–"}</dd>
              <dt>{t(locale, "research.sources.unit")}</dt><dd>{metric.unit}</dd>
              <dt>{t(locale, "research.sources.denominator")}</dt><dd>{metric.denominator ?? "–"}</dd>
              <dt>{t(locale, "research.sources.window")}</dt><dd>{metric.window}</dd>
              <dt>{t(locale, "research.sources.evidence")}</dt><dd><EvidenceTag evidence={metric.evidence} locale={locale} /></dd>
              <dt>{t(locale, "research.sources.formula")}</dt><dd>{metric.formula}</dd>
              <dt>{t(locale, "research.sources.version")}</dt><dd>{metric.version}</dd>
              <dt>{t(locale, "research.sources.geo")}</dt><dd>{source ? t(locale, `research.geo.${source.audience_geography}`) : "–"}</dd>
              <dt>{t(locale, "research.sources.locale")}</dt><dd>{source?.collection_locale ?? "–"}</dd>
            </dl></details>
          </section>
          <section className="rs-panel">
            <div className="rs-panel-head"><div><h2>{t(locale, "research.sources.limits")}</h2></div></div>
            <ul className="rs-list">
              {(locale === "zh" ? metric.limitations_zh : metric.limitations_en).map((l, i) => <li key={i}>{l}</li>)}
            </ul>
            {market.latest && metric.status_rule === "catalog" && (
              <div className="rs-panel-foot">
                {t(locale, "research.sources.lastRun")}: {market.latest.run_id} · {market.latest.platforms.map((p) => `${platformName(p.id)} ${p.status} ${fmtUtc(p.fetched_at)}`).join(" · ")}
              </div>
            )}
            {metric.status_rule === "history" && <div className="rs-panel-foot">{t(locale, "research.sources.history", { n: market.days.length })} · {t(locale, "research.state.collectingHint")}</div>}
          </section>
        </div>
      </>
    );
  }

  const s = source!;
  const copy = sourceCopy(s,locale);
  const status = sourceStatus(s, ctx);
  const dependents = METRICS.filter((m) => m.source_key === s.key);
  const run = market.latest?.platforms.find((p) => `${p.id}_web` === s.key) ?? null;
  return (
    <>
      {crumbs}
      <div className="page-head">
        <div>
          <span className="page-kicker">{GROUP_LABELS[s.group][locale]}</span>
          <h1>{copy.name}</h1>
          <p className="page-sub">{copy.description}</p>
        </div>
        <StateBadge status={status} locale={locale} />
      </div>
      <div className="rs-detail">
        <section className="rs-panel">
          <dl className="rs-kv">
            <dt>{t(locale, "research.sources.access")}</dt><dd>{t(locale,`ux.access.${s.access}`)}</dd>
            <dt>{t(locale, "research.sources.locale")}</dt><dd>{s.collection_locale}</dd>
            <dt>{t(locale, "research.sources.geo")}</dt><dd>{t(locale, `research.geo.${s.audience_geography}`)}</dd>
            <dt>{t(locale, "research.sources.refresh")}</dt><dd>{copy.refresh}</dd>
            {run && (
              <>
                <dt>{t(locale, "research.sources.coverage")}</dt>
                <dd>{run.title_count} · {t(locale, "research.col.withViews").toLowerCase()} {run.with_views} · {fmtUtc(run.fetched_at)}{run.detail_coverage ? ` · ${t(locale, "research.sources.detailCoverage", { fetched: run.detail_coverage.fetched, requested: run.detail_coverage.requested })}` : ""}{run.error ? ` · ${run.error}` : ""}</dd>
                <dt>{t(locale, "research.sources.surface")}</dt>
                <dd>{run.source_urls.map((u) => <span key={u}>{u}<br /></span>)}</dd>
              </>
            )}
          </dl>
        </section>
        <section className="rs-panel">
          <div className="rs-panel-head"><div><h2>{t(locale, "research.sources.limits")}</h2></div></div>
          <ul className="rs-list">{copy.limits.map((l, i) => <li key={i}>{l}</li>)}</ul>
          {dependents.length > 0 && (
            <>
              <div className="rs-panel-head" style={{ borderTop: "1px solid var(--border-light)" }}><div><h2>{t(locale, "research.sources.usedBy")}</h2></div></div>
              <ul className="rs-list">
                {dependents.map((m) => <li key={m.key}><a href={`/producer/sources/${m.key}`}>{locale === "zh" ? m.name_zh : m.name_en}</a><span className="spacer" /><StateBadge status={statusFor(m.status_rule, ctx)} locale={locale} /></li>)}
              </ul>
            </>
          )}
        </section>
      </div>
    </>
  );
}
