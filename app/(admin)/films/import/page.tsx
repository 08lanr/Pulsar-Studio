import FilmImport from "@/components/producer/FilmImport";
import { adminLocale, staffSession } from "@/components/admin/server";
import { checkedAtText } from "@/components/producer/CrazydramasChip";
import { crazydramasSweepStatus, listUnmatchedCrazydramas } from "@/lib/crazydramas";
import { getData } from "@/lib/data";
import { t } from "@/lib/i18n";
import { crazydramasStatesByTitle } from "@/lib/research/title-workspace";

// /films/import — the staff mirror of the producer's import desk with a
// company picker: staff may not act in the producer portal (CLAUDE.md), so
// an administrator imports a film for a company from here. Editors see the
// states; the import itself is admin-only, like the route. Below the desk,
// the series live on crazydramas.com that match no Studio title (plan
// A4.4, "Unmatched on crazydramas"): the newest read of each slug the sweep
// recorded with no title, null until a sweep has read the catalog at all.

export const dynamic = "force-dynamic";

export default async function StaffFilmImportPage() {
  const session = await staffSession();
  const locale = adminLocale();
  const data = getData();
  const [producers, crazydramas, unmatched] = await Promise.all([
    data.listProducers(session).then((ps) => ps.map((p) => ({ id: p.id, name: locale === "en" ? p.name_en || p.name_zh : p.name_zh })).sort((a, b) => a.name.localeCompare(b.name))),
    crazydramasStatesByTitle(session),
    listUnmatchedCrazydramas(session).then((rows) => rows && [...rows].sort((a, b) => a.slug.localeCompare(b.slug))),
  ]);
  // Only the sweep reads the catalog; a Check now reads one title. An empty list before any sweep in this process means
  // "not read yet", not "every series matches" (the e2e server never sweeps: SCHEDULER_DISABLED=1).
  const catalogRead = unmatched !== null && (unmatched.length > 0 || crazydramasSweepStatus().lastAt !== null);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t(locale, "fi.title")}</h1>
          <p className="page-sub">{t(locale, "fi.sub")}</p>
        </div>
      </div>
      <FilmImport portal="admin" canImport={session.staffRole === "admin"} producers={producers} crazydramas={crazydramas} />

      <section className="card cd-unmatched" aria-labelledby="cd-unmatched" style={{ marginTop: 24 }}>
        <h2 id="cd-unmatched" className="field-group-title">{t(locale, "cd.unmatched.title")}</h2>
        <p className="section-sub">{t(locale, "cd.unmatched.sub")}</p>
        {!catalogRead ? (
          <p className="hint">{t(locale, "cd.unmatched.notRead")}</p>
        ) : unmatched!.length === 0 ? (
          <p className="hint">{t(locale, "cd.unmatched.empty")}</p>
        ) : (
          <div className="gtable gtable-flush" style={{ "--cols": "minmax(200px, 1.6fr) minmax(200px, 1.4fr) 90px 110px 150px 150px" } as React.CSSProperties}>
            <div className="gt-row gt-head" aria-hidden="true">
              <span>{t(locale, "cd.unmatched.col.series")}</span>
              <span>{t(locale, "cd.unmatched.col.slug")}</span>
              <span>{t(locale, "cd.unmatched.col.episodes")}</span>
              <span>{t(locale, "cd.series.poster")}</span>
              <span>{t(locale, "cd.unmatched.col.read")}</span>
              <span />
            </div>
            {unmatched!.map((s) => (
              <div className="gt-row" key={s.slug} data-cd-slug={s.slug}>
                <span lang="en">{s.title}</span>
                <span className="gt-muted"><code>{s.slug}</code></span>
                <span className="gt-num">{s.episode_count}</span>
                <span>{s.poster_url ? <span className={`pill ${s.poster_placeholder ? "pill-warning" : "pill-success"}`}>{t(locale, s.poster_placeholder ? "cd.series.poster.placeholderPill" : "cd.series.poster.ok")}</span> : <span className="gt-muted">{t(locale, "cd.series.noPoster")}</span>}</span>
                <span className="gt-muted">{checkedAtText(s.read_at) ?? "—"} <span className="ev ev-observed">{t(locale, "research.evidence.observed")}</span></span>
                <span><a className="btn btn-outline btn-sm" href={s.public_url} target="_blank" rel="noreferrer">{t(locale, "cd.unmatched.open")}</a></span>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
