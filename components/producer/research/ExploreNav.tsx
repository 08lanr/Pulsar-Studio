"use client";
import { useSearchParams } from 'next/navigation';
import { useT } from "@/components/locale";

// Explore is a view inside US market insights (decision 2026-09-09): the
// area tabs stay visible above the explorer's own sub-views so a producer
// arriving from the Overview keeps their place. Market scope stays in the
// URL when switching between exploration views.

const TABS: { id: "titles" | "tropes" | "platforms" | "companies"; key: string }[] = [
  { id: "titles", key: "research.explore.titles" },
  { id: "tropes", key: "research.explore.tropes" },
  { id: "platforms", key: "research.explore.platforms" },
  { id: "companies", key: "research.explore.companies" },
];

export default function ExploreNav({ active }: { active: (typeof TABS)[number]["id"] }) {
  const { tt, locale } = useT();
  const params=useSearchParams();
  const scoped=new URLSearchParams(params.toString()); scoped.delete("page"); for(const key of ["watched","newonly","sort"]) scoped.delete(key);
  const saved = active === "titles" && params.get("watched") === "1";
  const savedScope = new URLSearchParams(scoped);
  savedScope.set("watched", "1");
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{tt("next.nav.explore")}</h1>
          <p className="page-sub">{tt("research.explore.sub")}</p>
        </div>
      </div>
      <nav className="tabs rs-tabs rs-subtabs" aria-label={tt("research.explore.title")}>
        {TABS.map((tab) => (
          <a key={tab.id} className={`tab${tab.id === active && !saved ? " is-active" : ""}`} href={`/producer/explore/${tab.id}?${scoped}`} aria-current={tab.id === active && !saved ? "page" : undefined}>
            {tt(tab.key)}
          </a>
        ))}
        <a className={`tab${saved ? " is-active" : ""}`} href={`/producer/explore/titles?${savedScope}`} aria-current={saved ? "page" : undefined}>
          {tt("redesign.savedTitles")}
        </a>
      </nav>
    </>
  );
}
