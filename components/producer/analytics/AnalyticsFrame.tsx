import { t } from "@/lib/i18n";
import type { AnalyticsRange } from "@/lib/analytics/types";
import { ANALYTICS_VERSION } from "@/lib/analytics/compute";
import TitleShell from "@/components/producer/TitleShell";
import { DemoChip, FreshnessLine, RangeControl, StateChip } from "./bits";
import type { AnalyticsPageData, View } from "./load";

// The frame every analytics view shares: breadcrumb (My catalog › title ›
// Analytics), the head with the state and demo chips, the range control
// (preserved across views as ?range=), the four-view nav, the freshness
// line, and the non-available states. Children render only when the record
// has data; otherwise the frame explains what is missing and what to do.

const VIEWS: { id: View; key: string; sub: string }[] = [
  { id: "overview", key: "an.nav.overview", sub: "" },
  { id: "revenue", key: "an.nav.revenue", sub: "/revenue" },
  { id: "episodes", key: "an.nav.episodes", sub: "/episodes" },
  { id: "acquisition", key: "an.nav.acquisition", sub: "/acquisition" },
];

export default function AnalyticsFrame({ data, view, children }: { data: AnalyticsPageData; view: View; children: React.ReactNode }) {
  const { locale, record: a, range, base, query, canEdit, platform, ads } = data;
  const name = locale === "en" ? a.title.name_en || a.title.name_zh : a.title.name_zh;
  const lang = locale === "en" && a.title.name_en ? "en" : "zh-CN";
  const secondary = locale === "en" ? (a.title.name_en ? a.title.name_zh : null) : a.title.name_en;
  const hrefFor = (r: AnalyticsRange) => `${view === "overview" ? base : `${base}/${view}`}?range=${r}`;
  const hasData = !!a.overview;
  const state = a.analytics_state;
  const linkHref = `${base}/link${query}`;

  const adStep = ads.flow ? t(locale, `workflow.step.${ads.flow.step}`) : null;
  return (
    <TitleShell locale={locale} titleId={a.title.id} name_zh={a.title.name_zh} name_en={a.title.name_en} platform={platform} ads={ads.status} adStep={adStep} section="tiktok" tiktokQuery={query} catalogHref={`/producer/titles?range=${range}`}
      actions={canEdit ? <a className="btn btn-outline btn-sm" href={linkHref}>{t(locale, a.listing ? "an.link.change" : "an.link.cta")}</a> : <span className="ev ev-inferred">{t(locale, "an.readOnly")}</span>}>
      <div className="rs-tool-row an-chips">
        <StateChip state={state} locale={locale} />
        {a.source === "demo" && <DemoChip locale={locale} />}
        {a.listing && <span className="ev ev-partner_reported" title={a.listing.id}>{a.listing.platform_label} · {a.listing.name}</span>}
      </div>
      <div className="an-controls">
        <RangeControl range={range} hrefFor={hrefFor} locale={locale} />
        <nav className="tabs rs-tabs an-nav" aria-label={t(locale, "an.title")}>
          {VIEWS.map((v) => (
            <a key={v.id} className={`tab${v.id === view ? " on" : ""}`} href={`${base}${v.sub}${query}`} aria-current={v.id === view ? "page" : undefined}>
              {t(locale, v.key)}
            </a>
          ))}
          <a className={`tab${view === "link" ? " on" : ""}`} href={linkHref} aria-current={view === "link" ? "page" : undefined}>{t(locale, "an.nav.link")}</a>
        </nav>
      </div>

      <FreshnessLine f={a.freshness} period={a.period} locale={locale} source={a.source} />

      {view === "link" ? (
        children
      ) : !hasData ? (
        <section className="rs-panel rs-empty an-empty" role="status">
          <h2>{t(locale, `an.empty.${state}.title`)}</h2>
          <p>{t(locale, `an.empty.${state}.body`)}</p>
          {state === "needs_listing_link" && canEdit && <a className="btn btn-primary" href={linkHref}>{t(locale, "an.link.cta")}</a>}
          {state === "needs_listing_link" && !canEdit && <p className="note note-info">{t(locale, "an.readOnly")}</p>}
          {state === "sync_failed" && <p className="note note-warn">{t(locale, "an.empty.sync_failed.hint")}</p>}
          {view === "acquisition" && <div className="an-empty-acq">{children}</div>}
        </section>
      ) : (
        <>
          {state === "stale" && <p className="note note-warn" role="status">{t(locale, "an.stale.note", { days: a.freshness.lag_days ?? 0 })}</p>}
          {state === "partial" && <p className="note note-info" role="status">{t(locale, "an.partial.note", { covered: a.period?.covered_days ?? 0, days: a.period?.days ?? 0 })}</p>}
          {state === "sync_failed" && <p className="note note-warn" role="status">{t(locale, "an.empty.sync_failed.hint")}</p>}
          {children}
        </>
      )}

      <p className="an-foot rs-meta">
        <span>{t(locale, "an.demo.legend")}</span>
        <a href="/producer/sources">{t(locale, "research.nav.sources")} ›</a>
      </p>
    </TitleShell>
  );
}
