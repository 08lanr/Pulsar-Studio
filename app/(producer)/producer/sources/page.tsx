import { portalSession, producerLocale } from "@/components/producer/server";
import { EvidenceTag, StateBadge, fmtUtc, platformName } from "@/components/producer/research/ui";
import { getData } from "@/lib/data";
import { t } from "@/lib/i18n";
import { GROUP_LABELS, METRICS, SOURCES, statusFor, type SourceGroup } from "@/lib/research/registry";

// /producer/sources — Data & Sources: every metric and source the desk
// uses or plans to use, grouped, with its real availability computed from
// the published data. No credentials, no operational logs, no other
// company's reports.

export const dynamic = "force-dynamic";

const GROUPS: SourceGroup[] = ["catalogs_charts", "social_search", "ads_creatives", "platforms_pricing", "my_reports", "derived"];

export default async function SourcesPage() {
  const session = await portalSession("/producer/sources");
  const locale = producerLocale();
  const data = getData();
  const [market, profile, batches] = await Promise.all([data.getMarket(session), data.getResearchProfile(session), data.listReportBatches(session)]);
  const ctx = { view: market, hasReports: batches.some((b) => !b.reverted_at), hasProfile: Boolean(profile) };
  const latest = market.latest;

  return (
    <>
      <div className="page-head">
        <div>
          <span className="page-kicker">{t(locale, "research.market.kicker")}</span>
          <h2>{t(locale, "research.sources.title")}</h2>
          <p className="page-sub">{t(locale, "research.sources.sub")}</p>
        </div>
      </div>

      <section className="rs-panel" style={{ marginBottom: 20 }}>
        <div className="rs-panel-head"><div><h3>{t(locale, "research.sources.coverage")}</h3></div></div>
        <dl className="rs-kv">
          <dt>{t(locale, "research.sources.lastRun")}</dt>
          <dd>{latest ? <>{latest.run_id} · {fmtUtc(market.publication.published_at)} · {t(locale, "research.sources.history", { n: market.days.length })}</> : <StateBadge status="unavailable" locale={locale} />}</dd>
          {latest?.platforms.map((p) => (
            <div key={p.id} style={{ display: "contents" }}>
              <dt>{platformName(p.id)}</dt>
              <dd>
                <StateBadge status={p.status === "failed" ? "failed" : p.status === "stale" ? "stale" : "available"} locale={locale} /> {p.title_count} {t(locale, "research.crawl.count", { n: "" }).trim()} · {t(locale, "research.col.withViews").toLowerCase()} {p.with_views} · {fmtUtc(p.fetched_at)}
                {p.detail_coverage && <> · {t(locale, "research.sources.detailCoverage", { fetched: p.detail_coverage.fetched, requested: p.detail_coverage.requested })}</>}
                {p.error && <> · <span className="ev ev-inferred">{p.error}</span></>}
              </dd>
            </div>
          ))}
          {market.publication.last_failure && (
            <>
              <dt>{t(locale, "research.sources.lastFailure")}</dt>
              <dd><StateBadge status="failed" locale={locale} /> {market.publication.last_failure.run_id} · {fmtUtc(market.publication.last_failure.at)} · {market.publication.last_failure.errors.slice(0, 3).join("; ")}</dd>
            </>
          )}
          {market.publication.errors.length > 0 && (
            <>
              <dt>{t(locale, "research.sources.errors")}</dt>
              <dd>{market.publication.errors.join("; ")}</dd>
            </>
          )}
          <dt>{t(locale, "research.scope")}</dt>
          <dd>{t(locale, "research.scope.value")} · {t(locale, "research.coverage.note")}</dd>
        </dl>
      </section>

      {GROUPS.map((group) => {
        const metrics = METRICS.filter((m) => m.group === group);
        const sources = SOURCES.filter((s) => s.group === group);
        return (
          <section className="rs-panel" style={{ marginBottom: 20 }} key={group}>
            <div className="rs-panel-head"><div><h3>{GROUP_LABELS[group][locale]}</h3></div>{group === "my_reports" && <a className="rs-panel-aside" href="/producer/reports">{t(locale, "research.reports.title")} ›</a>}</div>
            {sources.length > 0 && (
              <div className="gtable gtable-flush rs-table" style={{ ["--cols" as string]: "minmax(0,2fr) 130px minmax(0,1.4fr) 120px minmax(0,1.6fr)" }}>
                <div className="gt-head"><span>{t(locale, "research.sources.sourcesHead")}</span><span>{t(locale, "research.sources.status")}</span><span>{t(locale, "research.sources.access")}</span><span>{t(locale, "research.sources.geo")}</span><span>{t(locale, "research.sources.refresh")}</span></div>
                {sources.map((s) => (
                  <a className="gt-row" key={s.key} href={`/producer/sources/${s.key}`}>
                    <span className="rs-title-name">{s.name}</span>
                    <span><StateBadge status={statusFor(s.status_rule, ctx)} locale={locale} /></span>
                    <span className="gt-muted">{s.access} · {s.surface}</span>
                    <span>{t(locale, `research.geo.${s.audience_geography}`).split(" (")[0]}</span>
                    <span className="gt-muted">{s.refresh_target}</span>
                  </a>
                ))}
              </div>
            )}
            {metrics.length > 0 && (
              <div className="gtable gtable-flush rs-table" style={{ ["--cols" as string]: "minmax(0,2fr) 130px 90px minmax(0,2fr) 110px", borderTop: "1px solid var(--border-light)" }}>
                <div className="gt-head"><span>{t(locale, "research.sources.metrics")}</span><span>{t(locale, "research.sources.status")}</span><span>{t(locale, "research.sources.grain")}</span><span>{t(locale, "research.sources.question")}</span><span>{t(locale, "research.sources.evidence")}</span></div>
                {metrics.map((m) => (
                  <a className="gt-row" key={m.key} href={`/producer/sources/${m.key}`}>
                    <span className="rs-title-name">{locale === "zh" ? m.name_zh : m.name_en}</span>
                    <span><StateBadge status={statusFor(m.status_rule, ctx)} locale={locale} /></span>
                    <span className="gt-muted">{m.grain}</span>
                    <span className="gt-muted">{locale === "zh" ? m.question_zh : m.question_en}</span>
                    <span><EvidenceTag evidence={m.evidence} locale={locale} /></span>
                  </a>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </>
  );
}
