// Server-side helpers shared by the partner portal's layout and pages.
//
// The portal defaults to Chinese: decision #8 says the route group decides
// the locale when no pulsar_studio_locale cookie is set, and lib/i18n's
// DEFAULT_LOCALE only covers routes outside a group. The session helper
// re-checks what middleware.ts already enforced (deny by default) so a page
// rendered outside the middleware matcher still cannot leak a title.

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSession, type Session } from "@/lib/auth";
import { LOCALE_COOKIE, parseLocale, type Locale } from "@/lib/i18n";

/** Cookie wins; otherwise the partner portal is Chinese. */
export function producerLocale(): Locale {
  const raw = cookies().get(LOCALE_COOKIE)?.value;
  return raw ? parseLocale(raw) : "zh";
}

/**
 * A producer session, or a staff session previewing the portal (the
 * middleware lets staff open /producer/*). Anyone else goes to the door.
 */
export async function portalSession(nextPath = "/producer"): Promise<Session> {
  const session = await getSession();
  if (!session) redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  return session;
}

export function isStaffPreview(session: Session): boolean {
  return session.kind === "staff";
}

/** ISO timestamp to its date part; deterministic on server and client (no timezone math). */
export function isoDate(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : "";
}
