"use client";
import { useSearchParams } from 'next/navigation';
import { t } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";

// Market scope stays in the URL when switching between exploration views.

const TABS: { id: "titles" | "tropes" | "platforms" | "companies"; key: string }[] = [
  { id: "titles", key: "research.explore.titles" },
  { id: "tropes", key: "research.explore.tropes" },
  { id: "platforms", key: "research.explore.platforms" },
  { id: "companies", key: "research.explore.companies" },
];

export default function ExploreNav({ active, locale }: { active: (typeof TABS)[number]["id"]; locale: Locale }) {
  const params=useSearchParams();
  const scoped=new URLSearchParams(params.toString()); scoped.delete("page"); for(const key of ["watched","newonly","sort"]) scoped.delete(key);
  const saved = active === "titles" && params.get("watched") === "1";
  const savedScope = new URLSearchParams(scoped);
  savedScope.set("watched", "1");
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t(locale, "research.explore.title")}</h1>
        </div>
      </div>
      <nav className="tabs rs-tabs" aria-label={t(locale, "research.explore.title")}>
        {TABS.map((tab) => (
          <a key={tab.id} className={`tab${tab.id === active && !saved ? " is-active" : ""}`} href={`/producer/explore/${tab.id}?${scoped}`} aria-current={tab.id === active && !saved ? "page" : undefined}>
            {t(locale, tab.key)}
          </a>
        ))}
        <a className={`tab${saved ? " is-active" : ""}`} href={`/producer/explore/titles?${savedScope}`} aria-current={saved ? "page" : undefined}>
          {t(locale, "redesign.savedTitles")}
        </a>
      </nav>
    </>
  );
}
