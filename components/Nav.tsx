"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { useT } from "./locale";
import ThemeToggle from "./ThemeToggle";
import LangToggle from "./LangToggle";
import { IconLogout, IconMenu, IconPlus, IconProducers, IconProjects } from "./icons";

// The admin portal's app shell: the fixed sidebar (brand, the one primary
// CTA, the two nav rows, the identity block) and the sticky header (page
// title, language, theme, sign out). Ported from the sibling's Nav — the
// shape, not the merchant content: Studio has two areas, Projects and
// Producers, so there is no product sectioning.
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

  const items: NavItem[] = [
    { href: "/titles", label: tt("admin.nav.projects"), icon: <IconProjects /> },
    { href: "/producers", label: tt("admin.nav.producers"), icon: <IconProducers /> },
  ];

  // The header names the screen; derived from the path so no page threads a
  // prop through. Deeper routes are matched first.
  const title = pathname.startsWith("/producers")
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

  return (
    <>
      <header className="apphead">
        <button
          type="button"
          className="m-menu-btn"
          aria-label={tt("admin.nav.menu")}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <IconMenu />
        </button>
        <a className="m-brand" href="/titles">
          <span className="brand-mark" aria-hidden />
          Pulsar Studio
        </a>
        <h1 className="apphead-title">{title}</h1>
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

      {open && <button type="button" className="scrim" aria-label={tt("admin.nav.closeMenu")} onClick={() => setOpen(false)} />}

      <aside className={`sidebar ${open ? "open" : ""}`}>
        <a className="brand" href="/titles">
          <span className="brand-mark" aria-hidden />
          Pulsar Studio
        </a>

        <a className="btn btn-primary side-cta" href="/titles/new" onClick={() => setOpen(false)}>
          <IconPlus />
          {tt("admin.titles.new")}
        </a>

        <nav>
          {items.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className={`side-link ${pathname.startsWith(item.href) ? "active" : ""}`}
              aria-current={pathname.startsWith(item.href) ? "page" : undefined}
              onClick={() => setOpen(false)}
            >
              {item.icon}
              {item.label}
            </a>
          ))}
        </nav>

        <div className="side-foot">
          <div className="ident">
            <span className="avatar">{initials}</span>
            <div>
              <div className="ident-name">{displayName}</div>
              <div className="ident-role">
                {role === "admin" ? tt("admin.ident.admin") : tt("admin.ident.editor")}
              </div>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
