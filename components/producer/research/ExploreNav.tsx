import { t } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";

// Sub-navigation of 市场探索: Titles · Tropes · Platforms · Companies.

const TABS: { id: "titles" | "tropes" | "platforms" | "companies"; key: string }[] = [
  { id: "titles", key: "research.explore.titles" },
  { id: "tropes", key: "research.explore.tropes" },
  { id: "platforms", key: "research.explore.platforms" },
  { id: "companies", key: "research.explore.companies" },
];

export default function ExploreNav({ active, locale }: { active: (typeof TABS)[number]["id"]; locale: Locale }) {
  return (
    <>
      <div className="page-head">
        <div>
          <span className="page-kicker">{t(locale, "research.market.kicker")}</span>
          <h2>{t(locale, "research.explore.title")}</h2>
        </div>
      </div>
      <nav className="tabs rs-tabs" aria-label={t(locale, "research.explore.title")}>
        {TABS.map((tab) => (
          <a key={tab.id} className={`tab${tab.id === active ? " is-active" : ""}`} href={`/producer/explore/${tab.id}`} aria-current={tab.id === active ? "page" : undefined}>
            {t(locale, tab.key)}
          </a>
        ))}
      </nav>
    </>
  );
}
