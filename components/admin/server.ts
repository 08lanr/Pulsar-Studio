// Server-only helpers shared by the admin pages: the portal's locale rule
// and the staff-session read every page repeats. Kept out of the layout
// file because Next only allows its own exports from a layout module.

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSession, type Session } from "@/lib/auth";
import { LOCALE_COOKIE, parseLocale, type Locale } from "@/lib/i18n";

/** The admin default: the locale cookie wins, otherwise en (decision #8). */
export function adminLocale(): Locale {
  const raw = cookies().get(LOCALE_COOKIE)?.value;
  return raw ? parseLocale(raw) : "en";
}

/** The staff session, or a redirect to the door (the layout already checked; pages need the value). */
export async function staffSession(): Promise<Session> {
  const session = await getSession();
  if (!session || session.kind !== "staff") redirect("/login");
  return session;
}
