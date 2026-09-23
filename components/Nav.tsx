"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useT } from "./locale";
import ThemeToggle from "./ThemeToggle";
import { containDialogFocus } from "./dialog-focus";
import LangToggle from "./LangToggle";
import { IconFilm, IconLogout, IconMenu, IconPlus, IconProducers, IconProjects, IconSparkle } from "./icons";

// The admin portal's app shell: the fixed sidebar (brand, the one primary
// CTA, the two nav rows, the identity block) and the sticky header (page
// title, language, theme, sign out). Ported from the sibling's Nav — the
// shape, not the merchant content: Studio has three areas — the Promote
// desk, Titles and Producers — so there is no product sectioning.
//
// Who is signed in arrives as props from the server layout (it already
// resolved the session), so the shell renders complete on the first paint
// and never fetches itself. Below 1024px the rail is an off-canvas drawer.
//
// Sign out is a plain form POST: the logout route answers with a 303 to
// /login, which a form follows and a fetch would not.

type NavProps = {
  displayName: string;
  /** Staff role key: 'admin' | 'editor'. */
  role: string;
};

type NavItem = { href: string; label: string; icon: React.ReactNode };

/** Up to two initials; a CJK name keeps its first character. */
function initialsOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  if (/[一-鿿]/.test(trimmed[0])) return trimmed[0];
  return trimmed
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

export default function Nav({ displayName, role }: NavProps) {
  const { tt } = useT();
  const pathname = usePathname() ?? "";
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => dialog.current?.close();

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1024px)");
    const onResize = () => { if (desktop.matches) dialog.current?.close(); };
    desktop.addEventListener("change", onResize);
    return () => desktop.removeEventListener("change", onResize);
  }, []);

  // The staff rail reads the same words in the same order as the producer's
  // (plan §5.3): Clips · Launch · Monitor · Connections · Legacy campaigns ·
  // Titles · Producers. Connections is /tiktok, which carries a Meta section
  // as well, so one entry covers both providers; /meta keeps working.
  const items: NavItem[] = [
    { href: "/clips", label: tt("lv2.clips.title"), icon: <IconSparkle /> },
    { href: "/promote/launches", label: tt("lv2.launch.title"), icon: <IconSparkle /> },
    { href: "/promote/monitor", label: tt("lv2.monitor.title"), icon: <IconSparkle /> },
    { href: "/tiktok", label: tt("admin.nav.connections"), icon: <IconSparkle /> },
    { href: "/promote", label: tt("lv2.legacyCampaigns"), icon: <IconSparkle /> },
    { href: "/titles", label: tt("admin.nav.projects"), icon: <IconProjects /> },
    { href: "/films/import", label: tt("fi.nav"), icon: <IconFilm /> },
    { href: "/films/runs", label: tt("seg.nav"), icon: <IconFilm /> },
    { href: "/producers", label: tt("admin.nav.producers"), icon: <IconProducers /> },
  ];

  // The header names the screen with the same word the rail uses; derived from
  // the path so no page threads a prop through. Deeper routes are matched first.
  const title = pathname.startsWith("/films/runs") ? tt("seg.nav") : pathname.startsWith("/films") ? tt("fi.nav") : pathname.startsWith("/clips") ? tt("lv2.clips.title") : pathname.startsWith("/meta") ? tt("lv2.meta.title") : pathname.startsWith("/promote/launches") ? tt("lv2.launch.title") : pathname.startsWith("/promote/monitor") ? tt("lv2.monitor.title") : pathname.startsWith("/tiktok")
    ? tt("admin.nav.connections")
    : pathname.startsWith("/promote")
    ? tt("lv2.legacyCampaigns")
    : pathname.startsWith("/producers")
    ? tt("admin.nav.producers")
    : pathname === "/titles/new"
      ? tt("admin.head.newTitle")
      : /^\/titles\/[^/]+\/pack/.test(pathname)
        ? tt("admin.head.pack")
        : /^\/titles\/[^/]+\/episodes\//.test(pathname)
          ? tt("admin.head.adaptation")
          : /^\/titles\/[^/]+/.test(pathname)
            ? tt("admin.head.title")
            : tt("admin.nav.projects");

  const initials = initialsOf(displayName);
  const navigation = (
    <>
      <a className="brand" href="/titles" onClick={close}>
        <span className="brand-mark" aria-hidden />Pulsar Studio
      </a>
      <a className="btn btn-primary side-cta" href="/titles/new" onClick={close}>
        <IconPlus />{tt("admin.titles.new")}
      </a>
      <nav aria-label={tt("admin.nav.menu")}>
        {items.map((item) => (
          <a key={item.href} href={item.href}
            className={`side-link ${pathname.startsWith(item.href) && !(item.href === "/promote" && pathname !== "/promote") ? "active" : ""}`}
            aria-current={pathname.startsWith(item.href) && !(item.href === "/promote" && pathname !== "/promote") ? "page" : undefined} onClick={close}>
            {item.icon}{item.label}
          </a>
        ))}
      </nav>
      <div className="side-foot"><div className="ident">
        <span className="avatar">{initials}</span>
        <div><div className="ident-name">{displayName}</div>
          <div className="ident-role">{role === "admin" ? tt("admin.ident.admin") : tt("admin.ident.editor")}</div>
        </div>
      </div></div>
    </>
  );

  return (
    <>
      <header className="apphead">
        <button
          ref={trigger}
          type="button"
          className="m-menu-btn"
          aria-label={tt("admin.nav.menu")}
          aria-expanded={open}
          aria-controls="admin-navigation"
          aria-haspopup="dialog"
          onClick={() => { dialog.current?.showModal(); setOpen(true); }}
        >
          <IconMenu />
        </button>
        <a className="m-brand" href="/titles">
          <span className="brand-mark" aria-hidden />
          Pulsar Studio
        </a>
        <span className="apphead-title">{title}</span>
        <span className="spacer" />
        <LangToggle />
        <ThemeToggle />
        <span className="vsep" aria-hidden />
        <form method="post" action="/api/auth/logout">
          <button type="submit" className="icon-btn" title={tt("admin.nav.signOut")}>
            <IconLogout />
            <span className="logout-label">{tt("admin.nav.signOut")}</span>
          </button>
        </form>
      </header>

      <aside className="sidebar" aria-label={tt("admin.nav.menu")}>{navigation}</aside>
      <dialog ref={dialog} id="admin-navigation" className="admin-nav-dialog" aria-label={tt("admin.nav.menu")} onKeyDown={containDialogFocus}
        onClose={() => { setOpen(false); trigger.current?.focus(); }}
        onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
        <div className="admin-nav-content">
          <button type="button" className="btn btn-outline" autoFocus onClick={close}>{tt("admin.nav.closeMenu")}</button>
          {navigation}
        </div>
      </dialog>
    </>
  );
}
