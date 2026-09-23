import FilmImport from "@/components/producer/FilmImport";
import { isStaffPreview, portalSession, producerLocale } from "@/components/producer/server";
import { t } from "@/lib/i18n";
import { crazydramasStatesByTitle } from "@/lib/research/title-workspace";

// /producer/films/import — the import desk under My titles (decision
// 2026-09-22, "the workspace import"): the films the cutting pipeline
// delivered, one row each, imported as titles of this company by the
// approver. Staff previewing the portal see the list and cannot act. Each
// row carries the crazydramas chip of its imported title (plan A4.3).

export const dynamic = "force-dynamic";

export default async function FilmImportPage() {
  const session = await portalSession("/producer/films/import");
  const locale = producerLocale();
  const canImport = !isStaffPreview(session) && session.producerRole === "approver";
  // Staff previewing the portal get the states from disk alone (no company's records), so no chip states either.
  const crazydramas = isStaffPreview(session) ? {} : await crazydramasStatesByTitle(session);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t(locale, "fi.title")}</h1>
          <p className="page-sub">{t(locale, "fi.sub")}</p>
        </div>
      </div>
      {!canImport && <p className="note note-info">{t(locale, "fi.readOnly")}</p>}
      <FilmImport portal="producer" canImport={canImport} crazydramas={crazydramas} />
    </>
  );
}
