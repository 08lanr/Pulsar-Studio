import FilmImport from "@/components/producer/FilmImport";
import { adminLocale, staffSession } from "@/components/admin/server";
import { getData } from "@/lib/data";
import { t } from "@/lib/i18n";

// /films/import — the staff mirror of the producer's import desk with a
// company picker: staff may not act in the producer portal (CLAUDE.md), so
// an administrator imports a film for a company from here. Editors see the
// states; the import itself is admin-only, like the route.

export const dynamic = "force-dynamic";

export default async function StaffFilmImportPage() {
  const session = await staffSession();
  const locale = adminLocale();
  const producers = (await getData().listProducers(session))
    .map((p) => ({ id: p.id, name: locale === "en" ? p.name_en || p.name_zh : p.name_zh }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t(locale, "fi.title")}</h1>
          <p className="page-sub">{t(locale, "fi.sub")}</p>
        </div>
      </div>
      <FilmImport portal="admin" canImport={session.staffRole === "admin"} producers={producers} />
    </>
  );
}
