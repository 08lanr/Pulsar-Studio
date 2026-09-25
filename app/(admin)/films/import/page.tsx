import ThisComputer from "@/components/admin/ThisComputer";
import FilmImport from "@/components/producer/FilmImport";
import FolderImport from "@/components/admin/FolderImport";
import { adminLocale, staffSession } from "@/components/admin/server";
import { getData } from "@/lib/data";
import { dataSource } from "@/lib/data-source";
import { t } from "@/lib/i18n";
import { crazydramasStatesByTitle } from "@/lib/research/title-workspace";

// /films/import — the staff mirror of the producer's import desk with a
// company picker: staff may not act in the producer portal (CLAUDE.md), so
// an administrator imports a film for a company from here. Editors see the
// states; the import itself is admin-only, like the route. The series live
// on crazydramas.com that match no Studio title (plan A4.4) are rows of the
// CrazyDramas page since 2026-09-24; this page points there. The "This
// computer" card above the list (2026-09-24, "two computers, one database")
// is where this computer's films folder is connected and its cloud copy
// switched on.

export const dynamic = "force-dynamic";

/** The live project's ref (the first label of its URL, public), for the card's link to its storage settings. */
function supabaseRef(): string | null {
  if (dataSource() !== "supabase") return null;
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").hostname.split(".")[0] || null;
  } catch {
    return null;
  }
}

export default async function StaffFilmImportPage() {
  const session = await staffSession();
  const locale = adminLocale();
  const data = getData();
  const [producers, crazydramas] = await Promise.all([
    data.listProducers(session).then((ps) => ps.map((p) => ({ id: p.id, name: locale === "en" ? p.name_en || p.name_zh : p.name_zh })).sort((a, b) => a.name.localeCompare(b.name))),
    crazydramasStatesByTitle(session),
  ]);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t(locale, "fi.title")}</h1>
          <p className="page-sub">{t(locale, "fi.sub")}</p>
        </div>
      </div>
      <ThisComputer canEdit={session.staffRole === "admin"} supabaseRef={supabaseRef()} />
      {/* "Upload by folder" (2026-09-24): a folder of finished ep1..epN.mp4 on this computer, for a narrated remix or any film delivered outside the workspace. */}
      <FolderImport canImport={session.staffRole === "admin"} producers={producers} />
      <FilmImport portal="admin" canImport={session.staffRole === "admin"} producers={producers} crazydramas={crazydramas} />

      {/* One place for one job (2026-09-24): the series live on crazydramas that match no title are rows of the CrazyDramas page now. */}
      <p className="hint cd-unmatched-moved" style={{ marginTop: 16 }}><a href="/crazydramas">{t(locale, "cdh.unmatchedMoved")}&nbsp;→</a></p>
    </>
  );
}
