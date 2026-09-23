import "@/app/segment.css";
import RunIntake from "@/components/admin/segment/RunIntake";
import { adminLocale, staffSession } from "@/components/admin/server";
import { getData } from "@/lib/data";
import { t } from "@/lib/i18n";

// /films/runs/new — intake (plan B2 stage 0): pick the source on this
// machine, name the film folder, choose mode and language, start the run.

export const dynamic = "force-dynamic";

export default async function NewFilmRunPage() {
  const session = await staffSession();
  const locale = adminLocale();
  const producers = (await getData().listProducers(session))
    .map((p) => ({ id: p.id, name: locale === "en" ? p.name_en || p.name_zh : p.name_zh }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t(locale, "seg.intake.title")}</h1>
          <p className="page-sub">{t(locale, "seg.intake.sub")}</p>
        </div>
        <div className="title-actions">
          <a className="btn btn-ghost" href="/films/runs">{t(locale, "seg.run.back")}</a>
        </div>
      </div>
      <RunIntake producers={producers} />
    </>
  );
}
