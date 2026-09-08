"use client";

// The partner portal's chrome: five areas of the US launch workspace plus
// "Add title" as an action (decision 2026-09-08). Overview · My catalog ·
// US market insights · Launch & experiments · Company & accounts. Mobile
// gets a native dialog with focus return.

import { useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import LangToggle from "@/components/LangToggle";
import { useT } from "@/components/locale";
import type { Producer } from "@/lib/types";
import { IconCompass, IconLibrary, IconLogout, IconMarket, IconPlus, IconPromote, IconSources } from "./icons";

type Item = { href: string; key: string; Icon: (p: { size?: number }) => JSX.Element; match: (path: string) => boolean };

const ITEMS: Item[] = [
  { href: "/producer", key: "ws.nav.overview", Icon: IconMarket, match: (p) => p === "/producer" },
  { href: "/producer/titles", key: "ws.nav.catalog", Icon: IconLibrary, match: (p) => p.startsWith("/producer/titles") || p === "/producer/library" },
  { href: "/producer/insights", key: "ws.nav.insights", Icon: IconCompass, match: (p) => ["/producer/insights", "/producer/market", "/producer/explore", "/producer/sources"].some((x) => p.startsWith(x)) },
  { href: "/producer/promote", key: "ws.nav.launch", Icon: IconPromote, match: (p) => p.startsWith("/producer/promote") },
  { href: "/producer/company", key: "ws.nav.company", Icon: IconSources, match: (p) => ["/producer/company", "/producer/accounts", "/producer/onboarding", "/producer/reports", "/producer/simulation"].some((x) => p.startsWith(x)) },
];

export default function PortalHeader({ company }: { company: Pick<Producer, "name_zh" | "name_en"> | null }) {
  const { tt, locale } = useT();
  const path = usePathname() ?? "/producer";
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const name = company ? (locale === "en" ? company.name_en || company.name_zh : company.name_zh) : tt("portal.name");
  const close = () => dialog.current?.close();
  const active = ITEMS.find((i) => i.match(path));
  const links = ITEMS.map(({ href, key, Icon, match }) => (
    <Link key={href} href={href} onClick={close} className={match(path) ? "is-active" : ""} aria-current={match(path) ? "page" : undefined}>
      <Icon />
      {tt(key)}
    </Link>
  ));

  return (
    <>
      <aside className="producer-sidebar">
        <Link href="/producer" className="producer-brand"><span className="producer-brandmark" aria-hidden><i /></span><span>Pulsar <b>Studio</b></span></Link>
        <span className="producer-workspace-label">{tt("ws.overview.kicker")}</span>
        <nav className="producer-nav" aria-label={tt("v3.primaryNav")}>{links}</nav>
        <Link className="btn btn-outline brief-add" href="/producer/titles/new"><IconPlus />{tt("research.nav.addTitle")}</Link>
        <div className="producer-sidebar-foot">
          <Link className="producer-org" href="/producer/company"><span>{name.slice(0, 2)}</span><div><strong>{name}</strong><small>{tt("ws.nav.company")}</small></div></Link>
          <a href="/api/auth/logout" className="producer-signout" aria-label={tt("portal.signOut")}><IconLogout /></a>
        </div>
      </aside>
      <header className="producer-topbar">
        <button ref={trigger} className="btn btn-outline brief-menu" aria-label={tt("ux.menu")} aria-haspopup="dialog" onClick={() => dialog.current?.showModal()}>☰</button>
        <span className="producer-section">{tt(active?.key ?? "ws.nav.overview")}</span>
        <span className="spacer" />
        <LangToggle />
      </header>
      <dialog className="brief-nav-dialog" ref={dialog} aria-label={tt("v3.primaryNav")} onClose={() => trigger.current?.focus()} onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
        <div className="brief-dialog-head"><strong>Pulsar Studio</strong><button className="btn btn-outline" onClick={close} autoFocus>{tt("ux.close")}</button></div>
        <nav className="producer-nav">
          {links}
          <Link href="/producer/titles/new" onClick={close}><IconPlus />{tt("research.nav.addTitle")}</Link>
          <a href="/api/auth/logout"><IconLogout />{tt("portal.signOut")}</a>
        </nav>
      </dialog>
    </>
  );
}
