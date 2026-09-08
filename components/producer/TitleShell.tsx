import { t, type Locale } from "@/lib/i18n";
import type { AdStatus, PlatformStatus } from "@/lib/research/title-status";

// The one title workspace (decision 2026-09-09): every page about a title
// shares this identity, its two statuses (TikTok publication, Pulsar
// advertising), the section nav and the route back to the catalog. Sections
// reuse the existing route implementations; the shell only frames them.

export type TitleSection = "overview" | "tiktok" | "campaigns" | "preparation" | "materials";

const SECTIONS: { id: TitleSection; sub: string; key: string }[] = [
  { id: "overview", sub: "", key: "tw.nav.overview" },
  { id: "tiktok", sub: "/analytics", key: "tw.nav.tiktok" },
  { id: "campaigns", sub: "/campaigns", key: "tw.nav.campaigns" },
  { id: "preparation", sub: "/preparation", key: "tw.nav.preparation" },
  { id: "materials", sub: "/materials", key: "tw.nav.materials" },
];

const PLATFORM_CLASS: Record<PlatformStatus, string> = { reporting: "is-live", stale: "is-warn", sync_failed: "is-bad", awaiting_data: "is-wait", not_linked: "is-none" };
const AD_CLASS: Record<AdStatus, string> = { none: "is-none", preparing: "is-wait", awaiting_approval: "is-warn", ready_to_launch: "is-warn", submitted: "is-live", running: "is-live", results: "is-live", failed: "is-bad" };

export function PlatformChip({ status, locale }: { status: PlatformStatus; locale: Locale }) {
  return <span className={`tw-chip tw-chip-tiktok ${PLATFORM_CLASS[status]}`}><i aria-hidden="true" />{t(locale, `tw.platform.${status}`)}</span>;
}

export function AdChip({ status, locale, step }: { status: AdStatus; locale: Locale; step?: string | null }) {
  return <span className={`tw-chip tw-chip-ads ${AD_CLASS[status]}`}><i aria-hidden="true" />{t(locale, `tw.ads.${status}`)}{step && status !== "none" ? <small> · {step}</small> : null}</span>;
}

export function titleName(locale: Locale, name_zh: string, name_en: string | null): { primary: string; secondary: string | null; lang: "en" | "zh-CN" } {
  const primary = locale === "en" ? name_en || name_zh : name_zh;
  const secondary = locale === "en" ? (name_en ? name_zh : null) : name_en;
  return { primary, secondary, lang: locale === "en" && name_en ? "en" : "zh-CN" };
}

export function sectionHref(titleId: string, section: TitleSection, query = ""): string {
  return `/producer/titles/${titleId}${SECTIONS.find((s) => s.id === section)?.sub ?? ""}${query}`;
}

export default function TitleShell({ locale, titleId, name_zh, name_en, platform, ads, adStep, section, actions, catalogHref = "/producer/titles", tiktokQuery = "", children }: {
  locale: Locale;
  titleId: string;
  name_zh: string;
  name_en: string | null;
  platform: PlatformStatus;
  ads: AdStatus;
  adStep?: string | null;
  section: TitleSection;
  actions?: React.ReactNode;
  catalogHref?: string;
  /** `?range=` carried into the TikTok section so the range survives navigation. */
  tiktokQuery?: string;
  children: React.ReactNode;
}) {
  const { primary, secondary, lang } = titleName(locale, name_zh, name_en);
  return (
    <div className="tw-page">
      <nav className="studio-crumbs" aria-label={t(locale, "v3.breadcrumbs")}>
        <a href={catalogHref}>{t(locale, "ws.nav.catalog")}</a>
        <span aria-hidden>›</span>
        {section === "overview" ? <span lang={lang}>{primary}</span> : <a href={sectionHref(titleId, "overview")} lang={lang}>{primary}</a>}
        {section !== "overview" && <><span aria-hidden>›</span><span>{t(locale, `tw.nav.${section}`)}</span></>}
      </nav>
      <header className="tw-head">
        <div className="tw-identity">
          <h1 className="bilingual" lang={lang}>{primary}</h1>
          {secondary && <p className="tw-secondary" lang={lang === "en" ? "zh-CN" : "en"}>{secondary}</p>}
          <div className="tw-chips">
            <PlatformChip status={platform} locale={locale} />
            <AdChip status={ads} locale={locale} step={adStep} />
          </div>
        </div>
        {actions && <div className="tw-actions">{actions}</div>}
      </header>
      <nav className="tw-nav" aria-label={t(locale, "tw.nav.label")}>
        {SECTIONS.map((s) => (
          <a key={s.id} href={sectionHref(titleId, s.id, s.id === "tiktok" ? tiktokQuery : "")} aria-current={s.id === section ? "page" : undefined} className={s.id === section ? "is-active" : undefined}>
            {t(locale, s.key)}
          </a>
        ))}
      </nav>
      {children}
    </div>
  );
}
