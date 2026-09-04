// Hand-rolled i18n — no dependency, two locales, Chinese first.
//
// Every user-visible string in the app goes through t(). The dictionaries
// are flat key→string JSON (locales/zh.json, locales/en.json); both ship in
// the client bundle (they are small) so language switching is a cookie flip
// plus reload, and server components can render the right language from the
// cookie header on first paint.

import zh from "@/locales/zh.json";
import en from "@/locales/en.json";

export type Locale = "zh" | "en";
export const DEFAULT_LOCALE: Locale = "zh";
export const LOCALE_COOKIE = "pulsar_studio_locale";

const DICTS: Record<Locale, Record<string, string>> = {
  zh: zh as Record<string, string>,
  en: en as Record<string, string>,
};

/**
 * Look a key up in the locale's dictionary. {name}-style placeholders are
 * filled from vars. Falls back zh→en (and en→zh), then to the key itself —
 * a missing key renders as its name, which is ugly and therefore noticed.
 */
export function t(
  locale: Locale,
  key: string,
  vars?: Record<string, string | number>
): string {
  const s = DICTS[locale][key] ?? DICTS[locale === "zh" ? "en" : "zh"][key] ?? key;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, name) =>
    vars[name] !== undefined ? String(vars[name]) : m
  );
}

export function parseLocale(value: string | undefined | null): Locale {
  return value === "en" ? "en" : DEFAULT_LOCALE;
}

/** Locale from a Cookie header string (server side). */
export function localeFromCookieHeader(cookieHeader: string | null): Locale {
  const m = (cookieHeader || "").match(
    new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=([^;]+)`)
  );
  return parseLocale(m?.[1]);
}

/** Locale from document.cookie (client side). */
export function localeFromDocument(): Locale {
  if (typeof document === "undefined") return DEFAULT_LOCALE;
  const m = document.cookie.match(
    new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=([^;]+)`)
  );
  return parseLocale(m?.[1]);
}

/** Persist the choice and reload so every component re-renders in it. */
export function switchLocale(locale: Locale) {
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=31536000; samesite=lax`;
  window.location.reload();
}
