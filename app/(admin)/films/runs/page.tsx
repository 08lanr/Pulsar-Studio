import "@/app/segment.css";
import Link from "next/link";
import RunList from "@/components/admin/segment/RunList";
import { adminLocale, staffSession } from "@/components/admin/server";
import { t } from "@/lib/i18n";

// /films/runs — the segmenting desk (decision 2026-09-23, "segment a film
// in Studio"): every run of the cut-only pipeline Studio drives, and the
// door to a new one. Staff only; editors see the runs, an administrator
// starts and decides them (the routes enforce it).

export const dynamic = "force-dynamic";

export default async function FilmRunsPage() {
  await staffSession();
  const locale = adminLocale();
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t(locale, "seg.title")}</h1>
          <p className="page-sub">{t(locale, "seg.sub")}</p>
        </div>
        <div className="title-actions">
          <Link className="btn btn-primary" href="/films/runs/new">{t(locale, "seg.newRun")}</Link>
        </div>
      </div>
      <RunList />
    </>
  );
}
