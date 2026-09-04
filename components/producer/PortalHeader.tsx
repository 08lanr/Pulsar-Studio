"use client";

import LangToggle from "@/components/LangToggle";
import { useT } from "@/components/locale";
import { usePathname } from "next/navigation";
import { IconLibrary, IconLogout, IconPlus, IconPromote } from "./icons";

// The partner portal's whole chrome: brand, portal name, language, sign out.
// The product sidebar keeps the shared drama library and the two separate
// workflows legible. Sign-out is a plain GET link on purpose: it
// works before hydration and gets a phone out of any stuck state
// (app/api/auth/logout accepts GET for exactly this reason).

export default function PortalHeader() {
  const { tt } = useT();
  const pathname = usePathname() ?? "/producer";
  const inLibrary = pathname === "/producer" || (pathname.startsWith("/producer/titles/") && pathname !== "/producer/titles/new");
  const inNew = pathname === "/producer/titles/new";
  const inPromote = pathname === "/producer/promote" || pathname.startsWith("/producer/promote/");
  const section = inPromote
    ? tt("promote.home.title")
    : pathname.includes("/episodes/")
    ? tt("v3.nav.episode")
    : inNew
      ? tt("v3.nav.newTitle")
      : pathname.startsWith("/producer/titles/")
        ? tt("v3.nav.title")
        : tt("v3.nav.library");
  return (
    <>
      <aside className="producer-sidebar">
        <a href="/producer" className="producer-brand" aria-label="Pulsar Studio">
          <span className="producer-brandmark" aria-hidden><i /></span>
          <span>Pulsar <b>Studio</b></span>
        </a>
        <span className="producer-workspace-label">{tt("v3.workspace")}</span>
        <nav className="producer-nav" aria-label={tt("v3.primaryNav")}>
          <a href="/producer" className={inLibrary ? "is-active" : ""} aria-current={inLibrary ? "page" : undefined}>
            <IconLibrary />
            {tt("v3.nav.library")}
          </a>
          <a href="/producer/promote" className={inPromote ? "is-active" : ""} aria-current={inPromote ? "page" : undefined}>
            <IconPromote />
            {tt("promote.home.title")}
          </a>
          <a href="/producer/titles/new" className={inNew ? "is-active" : ""} aria-current={inNew ? "page" : undefined}>
            <IconPlus />
            {tt("v3.nav.newTitle")}
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
