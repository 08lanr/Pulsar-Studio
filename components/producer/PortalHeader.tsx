"use client";

// The partner portal's chrome (decision 2026-09-08, "status board"): two
// groups in the sidebar — My titles (My catalog · Ad campaigns · TikTok
// performance) and US market (Market overview · What to make next · Explore
// listings · Data & sources) — plus Company & accounts and "Add title" as an
// action. The landing page is My catalog. Mobile gets a native dialog with
// focus return.

import { useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import LangToggle from "@/components/LangToggle";
import ThemeToggle from "@/components/ThemeToggle";
import { IconMenu } from "@/components/icons";
import { containDialogFocus } from "@/components/dialog-focus";
import { useT } from "@/components/locale";
import type { Producer } from "@/lib/types";
import { IconCompass, IconLibrary, IconLogout, IconMarket, IconPlus, IconPromote, IconSources } from "./icons";
import DemoBadge from "./DemoBadge";

type Item = { href: string; key: string; Icon: (p: { size?: number }) => JSX.Element; match: (path: string) => boolean };
type Group = { key: string | null; items: Item[] };

const GROUPS: Group[] = [
  {
    key: "ws.nav.group.titles",
    items: [
      { href: "/producer/titles", key: "ws.nav.catalog", Icon: IconLibrary, match: (p) => p === "/producer" || p.startsWith("/producer/titles") || p === "/producer/library" },
      { href: "/producer/promote", key: "ws.nav.launch", Icon: IconPromote, match: (p) => p.startsWith("/producer/promote") },
      { href: "/producer/tiktok", key: "ws.nav.tiktok", Icon: IconMarket, match: (p) => p.startsWith("/producer/tiktok") },
    ],
  },
  {
    key: "ws.nav.group.market",
    items: [
      { href: "/producer/insights", key: "next.nav.overview", Icon: IconCompass, match: (p) => p === "/producer/insights" },
      { href: "/producer/insights/next", key: "next.nav.next", Icon: IconCompass, match: (p) => p.startsWith("/producer/insights/next") },
      { href: "/producer/explore/titles", key: "next.nav.explore", Icon: IconCompass, match: (p) => p.startsWith("/producer/explore") || p.startsWith("/producer/market") },
      { href: "/producer/sources", key: "ws.nav.sources", Icon: IconSources, match: (p) => p.startsWith("/producer/sources") },
    ],
  },
  {
    key: null,
    items: [
      { href: "/producer/company", key: "ws.nav.company", Icon: IconSources, match: (p) => ["/producer/company", "/producer/accounts", "/producer/onboarding", "/producer/reports", "/producer/simulation"].some((x) => p.startsWith(x)) },
    ],
  },
];
const ITEMS = GROUPS.flatMap((g) => g.items);

export default function PortalHeader({ company, demo = false }: { company: Pick<Producer, "name_zh" | "name_en"> | null; demo?: boolean }) {
  const { tt, locale } = useT();
  const path = usePathname() ?? "/producer/titles";
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const name = company ? (locale === "en" ? company.name_en || company.name_zh : company.name_zh) : tt("portal.name");
  const close = () => dialog.current?.close();
  const active = ITEMS.find((i) => i.match(path));
  const link = ({ href, key, Icon, match }: Item) => (
    <Link key={href} href={href} onClick={close} className={match(path) ? "is-active" : ""} aria-current={match(path) ? "page" : undefined}>
      <Icon />
      {tt(key)}
    </Link>
  );
  const groups = GROUPS.map((g, i) => (
    <div className="producer-nav-group" key={g.key ?? `group-${i}`} role="group" aria-label={g.key ? tt(g.key) : undefined}>
      {g.key && <span className="producer-nav-label" aria-hidden="true">{tt(g.key)}</span>}
      {g.items.map(link)}
    </div>
  ));

  return (
    <>
      <a className="skip-link" href="#main-content">{tt("redesign.skipContent")}</a>
      <aside className="producer-sidebar" aria-label={tt("ws.overview.kicker")}>
        <Link href="/producer/titles" className="producer-brand"><span className="producer-brandmark" aria-hidden><i /></span><span>Pulsar <b>Studio</b></span></Link>
        <span className="producer-workspace-label">{tt("ws.overview.kicker")}</span>
        <nav className="producer-nav" aria-label={tt("v3.primaryNav")}>{groups}</nav>
        <Link className="btn btn-outline brief-add" href="/producer/titles/new"><IconPlus />{tt("research.nav.addTitle")}</Link>
        <div className="producer-sidebar-foot">
          <Link className="producer-org" href="/producer/company"><span>{name.slice(0, 2)}</span><div><strong>{name}</strong><small>{tt("ws.nav.company")}</small></div></Link>
          <a href="/api/auth/logout" className="producer-signout" aria-label={tt("portal.signOut")}><IconLogout /></a>
        </div>
      </aside>
      <header className="producer-topbar">
        <button ref={trigger} className="btn btn-outline brief-menu" aria-label={tt("ux.menu")} aria-haspopup="dialog" onClick={() => dialog.current?.showModal()}><IconMenu /></button>
        <span className="producer-section">{tt(active?.key ?? "ws.nav.catalog")}</span>
        <span className="spacer" />
        {demo && <DemoBadge />}
        <LangToggle />
        <ThemeToggle />
      </header>
      <dialog className="brief-nav-dialog" ref={dialog} aria-label={tt("v3.primaryNav")} onKeyDown={containDialogFocus} onClose={() => trigger.current?.focus()} onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
        <div className="brief-dialog-head"><strong>Pulsar Studio</strong><button className="btn btn-outline" onClick={close} autoFocus>{tt("ux.close")}</button></div>
        <nav className="producer-nav">
          {groups}
          <Link href="/producer/titles/new" onClick={close}><IconPlus />{tt("research.nav.addTitle")}</Link>
          <a href="/api/auth/logout"><IconLogout />{tt("portal.signOut")}</a>
        </nav>
      </dialog>
    </>
  );
}
