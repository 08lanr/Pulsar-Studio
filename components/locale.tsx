"use client";

import { createContext, useContext } from "react";
import { t, type Locale, DEFAULT_LOCALE } from "@/lib/i18n";

// The locale reaches client components as a PROP from the server layout
// (which read the cookie), not by sniffing document.cookie in a hook — that
// way the SSR pass and hydration render the same language and React never
// warns about a mismatch.

const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);

export function LocaleProvider({
  locale,
  children,
}: {
  locale: Locale;
  children: React.ReactNode;
}) {
  return (
    <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>
  );
}

/** The one way UI code gets strings: const { tt } = useT(); tt("dash.title") */
export function useT() {
  const locale = useContext(LocaleContext);
  return {
    locale,
    tt: (key: string, vars?: Record<string, string | number>) =>
      t(locale, key, vars),
  };
}
