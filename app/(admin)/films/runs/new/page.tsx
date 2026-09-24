import "@/app/segment.css";
import RunIntake from "@/components/admin/segment/RunIntake";
import ThisComputer from "@/components/admin/ThisComputer";
import { adminLocale, staffSession } from "@/components/admin/server";
import { getData } from "@/lib/data";
import { t } from "@/lib/i18n";

// /films/runs/new — intake (plan B2 stage 0): pick the source on this
// machine, name the film folder, choose mode and language, start the run.
// The "This computer" card first: the films folder the run cuts into, the
// pipeline, and whether this computer can cut at all (2026-09-24).

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
      <ThisComputer canEdit={session.staffRole === "admin"} sections="cut" />
      <RunIntake producers={producers} />
    </>
  );
}
