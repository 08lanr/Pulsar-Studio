import { t, type Locale } from '@/lib/i18n';

const TABS = ["profile", "accounts", "access", "reports", "simulation"] as const;

export default function CompanyNav({ active, locale }: { active: (typeof TABS)[number]; locale: Locale }) {
  return (
    <nav className="tabs rs-tabs" aria-label={t(locale, "ws.company.title")}>
      {TABS.map((id) => (
        <a key={id} className={`tab${id === active ? " is-active" : ""}`}
          aria-current={id === active ? "page" : undefined}
          href={id === "simulation" ? "/producer/simulation" : `/producer/company?tab=${id}`}>
          {t(locale, id === "simulation" ? "sim.nav" : `ws.company.tab.${id}`)}
        </a>
      ))}
    </nav>
  );
}

