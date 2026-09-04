import { redirect } from "next/navigation";
import Nav from "@/components/Nav";
import { LocaleProvider } from "@/components/locale";
import { adminLocale } from "@/components/admin/server";
import { getSession } from "@/lib/auth";

// The admin portal's route group: Pulsar staff only, English chrome unless
// the locale cookie says otherwise (decision #8 — the root layout's default
// is zh because /login and the partner portal want it; this layout re-wraps
// its subtree in a LocaleProvider whose fallback is en). The middleware
// already turned producers away from every non-/producer URL; the session
// check here is defense in depth for a path the matcher missed.

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session || session.kind !== "staff") redirect("/login");
  const locale = adminLocale();
  return (
    <LocaleProvider locale={locale}>
      <Nav displayName={session.displayName} role={session.staffRole ?? "editor"} />
      <main className="page page-wide">{children}</main>
    </LocaleProvider>
  );
}
