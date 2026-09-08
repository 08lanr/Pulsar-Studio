import { t, type Locale } from "@/lib/i18n";

// US market insights is one area with two views: the overview (what is
// prominent) and what to make next (what is being launched). Explore and
// Data & Sources are the drill-downs behind both.
const TABS = [
  { id: "overview", href: "/producer/insights", key: "next.nav.overview" },
  { id: "next", href: "/producer/insights/next", key: "next.nav.next" },
  { id: "explore", href: "/producer/explore/titles", key: "next.nav.explore" },
  { id: "sources", href: "/producer/sources", key: "next.nav.sources" },
] as const;

export default function InsightsNav({ active, locale }: { active: (typeof TABS)[number]["id"]; locale: Locale }) {
  return (
    <nav className="tabs rs-tabs" aria-label={t(locale, "ws.nav.insights")}>
      {TABS.map((tab) => (
        <a key={tab.id} className={`tab${tab.id === active ? " is-active" : ""}`} href={tab.href} aria-current={tab.id === active ? "page" : undefined}>
          {t(locale, tab.key)}
        </a>
      ))}
    </nav>
  );
}
