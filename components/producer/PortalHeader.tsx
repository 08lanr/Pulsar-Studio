"use client";

import LangToggle from "@/components/LangToggle";
import { useT } from "@/components/locale";
import { usePathname } from "next/navigation";
import { IconCompass, IconLibrary, IconLogout, IconMarket, IconPlus, IconPromote, IconSources } from "./icons";

// The partner portal's whole chrome: brand, portal name, language, sign out.
// The product sidebar keeps the shared drama library and the two separate
// workflows legible. Sign-out is a plain GET link on purpose: it
// works before hydration and gets a phone out of any stuck state
// (app/api/auth/logout accepts GET for exactly this reason).

export default function PortalHeader() {
  const { tt } = useT();
  const pathname = usePathname() ?? "/producer";
  // The desk's order (docs/market-desk-plan.md): Overview, Explore, My
  // titles (Adapt lives behind each title), Creative & tests (Promote), Data
  // & Sources. "Add title" stays an action.
  const inOverview = pathname === "/producer" || pathname.startsWith("/producer/market") || pathname === "/producer/onboarding";
  const inExplore = pathname.startsWith("/producer/explore");
  const inNew = pathname === "/producer/titles/new";
  const inLibrary = !inNew && (pathname === "/producer/titles" || pathname.startsWith("/producer/titles/") || pathname === "/producer/reports");
  const inPromote = pathname === "/producer/promote" || pathname.startsWith("/producer/promote/");
  const inSources = pathname.startsWith("/producer/sources");
  const section = inPromote
    ? tt("research.nav.creative")
    : inSources
      ? tt("research.nav.sources")
      : inExplore
        ? tt("research.nav.explore")
        : pathname.includes("/episodes/")
          ? tt("v3.nav.episode")
          : inNew
            ? tt("v3.nav.newTitle")
            : pathname.startsWith("/producer/titles/")
              ? tt("v3.nav.title")
              : pathname === "/producer/reports"
                ? tt("research.reports.title")
                : inLibrary
                  ? tt("research.nav.titles")
                : pathname === "/producer/onboarding"
                  ? tt("research.onboard.title")
                  : tt("research.nav.overview");
  return (
    <>
      <aside className="producer-sidebar">
        <a href="/producer" className="producer-brand" aria-label="Pulsar Studio">
          <span className="producer-brandmark" aria-hidden><i /></span>
          <span>Pulsar <b>Studio</b></span>
        </a>
        <span className="producer-workspace-label">{tt("v3.workspace")}</span>
        <nav className="producer-nav" aria-label={tt("v3.primaryNav")}>
          <a href="/producer" className={inOverview ? "is-active" : ""} aria-current={inOverview ? "page" : undefined}>
            <IconMarket />
            {tt("research.nav.overview")}
          </a>
          <a href="/producer/explore/titles" className={inExplore ? "is-active" : ""} aria-current={inExplore ? "page" : undefined}>
            <IconCompass />
            {tt("research.nav.explore")}
          </a>
          <a href="/producer/titles" className={inLibrary ? "is-active" : ""} aria-current={inLibrary ? "page" : undefined}>
            <IconLibrary />
            {tt("research.nav.titles")}
          </a>
          <a href="/producer/promote" className={inPromote ? "is-active" : ""} aria-current={inPromote ? "page" : undefined}>
            <IconPromote />
            {tt("research.nav.creative")}
          </a>
          <a href="/producer/sources" className={inSources ? "is-active" : ""} aria-current={inSources ? "page" : undefined}>
            <IconSources />
            {tt("research.nav.sources")}
          </a>
          <a href="/producer/titles/new" className={inNew ? "is-active" : ""} aria-current={inNew ? "page" : undefined}>
            <IconPlus />
            {tt("research.nav.addTitle")}
          </a>
        </nav>
        <div className="producer-sidebar-foot">
          <div className="producer-org">
            <span>PS</span>
            <div><strong>{tt("portal.name")}</strong><small>{tt("v3.role.producer")}</small></div>
          </div>
          <a href="/api/auth/logout" className="producer-signout" aria-label={tt("portal.signOut")}>
            <IconLogout />
          </a>
        </div>
      </aside>
      <header className="producer-topbar">
        <a href="/producer" className="producer-mobile-brand"><span className="producer-brandmark" aria-hidden><i /></span>Pulsar</a>
        <span className="producer-section">{section}</span>
        <span className="spacer" />
        <LangToggle />
        <a href="/api/auth/logout" className="producer-mobile-signout" aria-label={tt("portal.signOut")}><IconLogout /></a>
      </header>
    </>
  );
}
