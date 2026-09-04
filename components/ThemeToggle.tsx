"use client";

import { useEffect, useState } from "react";
import { useT } from "@/components/locale";

// Light/dark switch. The layout's inline script already set
// document.documentElement.dataset.theme before first paint; this button
// just flips it and remembers the choice.

function IconSun() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="3.1" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M8 1.2v1.6M8 13.2v1.6M14.8 8h-1.6M2.8 8H1.2M12.8 3.2l-1.13 1.13M4.33 11.67L3.2 12.8M12.8 12.8l-1.13-1.13M4.33 4.33L3.2 3.2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconMoon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M13.4 9.7A5.65 5.65 0 1 1 6.3 2.6a4.55 4.55 0 0 0 7.1 7.1z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function ThemeToggle() {
  const { tt } = useT();
  const [theme, setTheme] = useState<string>("");

  useEffect(() => {
    setTheme(document.documentElement.dataset.theme || "light");
  }, []);

  function flip() {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("theme", next);
    } catch {}
    setTheme(next);
  }

  if (!theme) return null;
  return (
    <button className="icon-btn" onClick={flip} aria-label={tt("common.theme")}>
      {theme === "dark" ? <IconSun /> : <IconMoon />}
    </button>
  );
}
