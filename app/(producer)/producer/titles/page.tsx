import { portalSession, producerLocale } from "@/components/producer/server";
import { EvidenceTag, MetricLabel, StateBadge, TropeChip, fmtCount, fmtPct, platformName } from "@/components/producer/research/ui";
import { getData } from "@/lib/data";
import { t } from "@/lib/i18n";
import { catalogMatches, scoreSnapshot, tagCatalogTitle, tropeStats } from "@/lib/research/engine";
import { summarizeReports } from "@/lib/research/reports";
import { SHORTLIST_VERSION, shortlist } from "@/lib/research/shortlist";
import { tropeLabel } from "@/lib/research/taxonomy";
import type { TitleStatus } from "@/lib/types";
import { IconPlus } from "@/components/producer/icons";

// /producer/titles — 我的剧库: the producer's catalog against the market.
// Each title is tagged from its synopsis with the same taxonomy as the
// market listings, scored against the prominent-listing share, with the
// explanation and comparable listings. Adapt (localization) and Promote
// (propose a test) live behind each poster; nothing new is built here. US
// performance is an honest empty state until a report is imported.

export const dynamic = "force-dynamic";

const PRODUCER_STATUS = new Set<TitleStatus>(["candidate", "selected", "ingesting", "adapting", "in_review", "approved"]);

function producerStatusKey(status: TitleStatus, percentAdapted: number): string {
  const early = status === "candidate" || status === "selected" || status === "ingesting";
  if (early && percentAdapted > 0) return "pw.titleStatus.adapting";
  return PRODUCER_STATUS.has(status) ? `pw.titleStatus.${status}` : `admin.titleStatus.${status}`;
}

const STATUS_PILL: Partial<Record<TitleStatus, string>> = { in_review: "pill-warning", approved: "pill-success", live: "pill-success", dropped: "pill-error" };

type ChinaMetrics = { views?: number; completion_rate?: number; paying_rate?: number };

export default async function MyTitles() {
  const session = await portalSession("/producer/titles");
  const locale = producerLocale();
  const data = getData();
  const [titles, market, profile, catalog, reportRows] = await Promise.all([data.listTitles(session), data.getMarket(session), data.getResearchProfile(session), data.listCatalogForMatching(session), data.listReportRows(session)]);
  const snapshot = market.latest;
  const scores = snapshot ? scoreSnapshot(snapshot) : new Map();
  const stats = snapshot ? tropeStats(snapshot.titles, scores, snapshot.taxonomy_version) : [];
  const hot = new Set(stats.slice(0, 10).map((s) => s.id));
  const mine = new Set(profile?.tropes ?? []);
  const tagged = catalog.rows.map((r) => ({ id: r.id, tropes: tagCatalogTitle(r) }));
  const matches = snapshot ? catalogMatches(tagged, stats, snapshot.titles, scores) : [];
  const byId = new Map(titles.map((x) => [x.id, x]));
  const marketById = new Map((snapshot?.titles ?? []).map((x) => [x.key, x]));
  const detailList = await Promise.all(titles.map(async (x) => [x.id, await data.getTitle(session, x.id).catch(() => null)] as const));
  const details = new Map(detailList.map(([id, d]) => [id, d?.title.china_metrics ?? null] as const));
  const synopsisById = new Map(catalog.rows.map((r) => [r.id, Boolean(r.synopsis_zh || r.synopsis_en)]));
  const entries = shortlist({
    titles: detailList.map(([id, d]) => {
      const summary = byId.get(id)!;
      return {
        id,
        name_zh: summary.name_zh,
        name_en: summary.name_en,
        license_start: d?.title.license_start ?? null,
        license_end: d?.title.license_end ?? null,
        percent_adapted: summary.percent_adapted,
        has_approved_version: (d?.versions ?? []).some((v) => v.status === "approved"),
        episodes_ingested: summary.episodes_ingested,
        episode_count: summary.episode_count,
        has_synopsis: synopsisById.get(id) ?? false,
      };
    }),
    matches,
    profile,
    reports: reportRows,
  });
  const entryById = new Map(entries.map((e) => [e.title_id, e]));
  const perf = summarizeReports(reportRows);
  const ordered = [...matches].sort((a, b) => (entryById.get(b.title_id)?.score ?? -1) - (entryById.get(a.title_id)?.score ?? -1));

  return (
    <>
      <div className="page-head">
        <div>
          <span className="page-kicker">{t(locale, "research.mine.kicker")}</span>
          <h2>{t(locale, "research.mine.title")}</h2>
          <p className="page-sub">{t(locale, "research.mine.sub")}</p>
        </div>
        <span className="rs-tool-row">
          <a className="btn btn-outline" href="/producer/reports">{t(locale, "research.reports.title")}</a>
          <a className="btn btn-primary" href="/producer/titles/new"><IconPlus /> {t(locale, "research.nav.addTitle")}</a>
        </span>
      </div>

      {titles.length > 0 && snapshot && (
        <section className="rs-panel" style={{ marginBottom: 20 }}>
          <div className="rs-panel-head">
            <div>
              <h3>{t(locale, "research.shortlist.title")}</h3>
              <p>{t(locale, "research.shortlist.sub", { version: SHORTLIST_VERSION })} {t(locale, "research.mine.vsMarketSub")}</p>
            </div>
            <span className="rs-panel-aside">{t(locale, "research.market.observed", { date: snapshot.observed_at })}</span>
          </div>
          <div>
            {ordered.map((m) => {
              const row = byId.get(m.title_id);
              if (!row) return null;
              const china = (details.get(m.title_id) ?? {}) as ChinaMetrics;
              const entry = entryById.get(m.title_id) ?? null;
              const own = perf.get(m.title_id) ?? [];
              return (
                <div className="rs-catalog-row" key={m.title_id}>
                  <div style={{ minWidth: 0 }}>
                    <a href={`/producer/titles/${m.title_id}`} className="rs-title-name bilingual" lang="zh-CN">{row.name_zh}</a>
                    {row.name_en && <div className="rs-title-sub" lang="en">{row.name_en}</div>}
                    <div className="rs-tropes" style={{ marginTop: 6 }}>
                      {m.tropes.length === 0 ? <span className="gt-muted">{t(locale, "research.mine.untagged")}</span> : m.tropes.map((id) => <TropeChip key={id} id={id} locale={locale} hot={hot.has(id)} mine={mine.has(id)} evidence="inferred" href={`/producer?trope=${id}`} />)}
                    </div>
                    <div className="rs-tool-row" style={{ marginTop: 8 }}>
                      <a className="btn btn-outline btn-sm" href={`/producer/titles/${m.title_id}`}>{t(locale, "research.mine.adapt")}</a>
                      <a className="btn btn-outline btn-sm" href={`/producer/promote/new?title=${m.title_id}`}>{t(locale, "research.mine.test")}</a>
                    </div>
                  </div>
                  <div>
                    <div className="stat-label">{t(locale, "research.shortlist.score")}</div>
                    <div style={{ fontSize: "var(--t-h3)", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{entry?.score ?? "–"}</div>
                    <div className="rs-title-sub"><MetricLabel metric="catalog_match" locale={locale}>{t(locale, "research.mine.marketScore")}</MetricLabel> {m.market_score ?? "–"} · {t(locale, "research.mine.marketScoreNote")}</div>
                    {entry && (
                      <details className="rs-why" open>
                        <summary>{t(locale, "research.mine.why")}</summary>
                        <ul>
                          {entry.reasons.map((r) => (
                            <li key={r.kind} className={r.ok === false ? "delta-down" : r.ok === null ? "gt-muted" : ""}>
                              {r.ok === true ? "✓" : r.ok === false ? "✗" : "?"} {t(locale, r.key, r.vars)} <small>({r.points > 0 ? "+" : ""}{r.points})</small>
                            </li>
                          ))}
                          {m.explanation.map((e) => <li key={e.trope} className="gt-muted">{tropeLabel(e.trope, locale)}: {fmtPct(e.cohort_share)}</li>)}
                        </ul>
                      </details>
                    )}
                  </div>
                  <div>
                    <div className="rs-title-sub" style={{ marginBottom: 4 }}>{t(locale, "research.mine.reported")}</div>
                    {china.views || china.completion_rate || china.paying_rate ? (
                      <div style={{ display: "grid", gap: 2 }}>
                        {china.views != null && <span>{t(locale, "research.mine.views")}: {fmtCount(china.views)} <EvidenceTag evidence="partner_reported" locale={locale} /></span>}
                        {china.completion_rate != null && <span>{t(locale, "research.mine.completion")}: {fmtPct(china.completion_rate)}</span>}
                        {china.paying_rate != null && <span>{t(locale, "research.mine.paying")}: {fmtPct(china.paying_rate, 1)}</span>}
                      </div>
                    ) : (
                      <span className="gt-muted">–</span>
                    )}
                    <div className="rs-title-sub" style={{ marginTop: 6 }}>{t(locale, "research.mine.perfTitle")}: {own.length === 0 ? <StateBadge status="requires_connection" locale={locale} /> : <span className="state state-available">{t(locale, "research.mine.perfFrom")}</span>}</div>
                    {own.length > 0 && (
                      <div style={{ display: "grid", gap: 2, marginTop: 4 }}>
                        {own.slice(0, 5).map((r) => (
                          <span key={`${r.metric}|${r.platform}`}>{t(locale, `research.metric.${r.metric}`)} · {r.platform}: {r.value.toLocaleString("en-US")}{r.currency ? ` ${r.currency}` : ""} <small className="gt-muted">{r.period_start} → {r.period_end}</small> <EvidenceTag evidence="partner_reported" locale={locale} /></span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div className="rs-title-sub" style={{ marginBottom: 4 }}>{t(locale, "research.mine.comparables")}</div>
                    <div style={{ display: "grid", gap: 2 }}>
                      {m.comparable_keys.slice(0, 3).map((key) => {
                        const mt = marketById.get(key);
                        return mt ? <a key={key} href={`/producer/market/${key}`} className="rs-title-name" lang="en" style={{ fontWeight: 400 }}>{mt.title} <span className="rs-platform">{platformName(mt.platform)}</span></a> : null;
                      })}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="rs-panel-foot">
            {catalog.truncated && <>{t(locale, "research.mine.truncated", { shown: catalog.rows.length, total: catalog.total })} · </>}
            <strong>{t(locale, "research.mine.perfTitle")}:</strong> {reportRows.length === 0 ? t(locale, "research.mine.perfEmpty") : t(locale, "research.mine.perfFrom")} <a className="btn btn-outline btn-sm" href="/producer/reports">{t(locale, "research.mine.perfCta")}</a>
          </div>
        </section>
      )}

      {titles.length === 0 && (
        <section className="rs-panel" style={{ marginBottom: 20 }}>
          <div className="rs-empty">{t(locale, "research.mine.empty")}</div>
        </section>
      )}

      <div className="poster-grid">
        {titles.map((title) => (
          <a className="poster" key={title.id} href={`/producer/titles/${title.id}`}>
            <div className="poster-cover">
              <span className={`pill ${STATUS_PILL[title.status] ?? "pill-neutral"}`}>{t(locale, producerStatusKey(title.status, title.percent_adapted))}</span>
              <span className="poster-cover-name bilingual" lang="zh-CN">{title.name_zh}</span>
            </div>
            <div className="poster-body">
              {title.name_en && <span className="poster-title bilingual" lang="en">{title.name_en}</span>}
              <span className="poster-meta">
                <span>{t(locale, "pw.home.episodes", { n: title.episodes_ingested })}</span>
                <span>{t(locale, "pw.home.percent", { pct: title.percent_adapted })}</span>
              </span>
              <div className="track" aria-hidden><div style={{ width: `${title.percent_adapted}%` }} /></div>
            </div>
          </a>
        ))}
      </div>
    </>
  );
}
