import { portalSession, producerLocale } from "@/components/producer/server";
import { getData } from "@/lib/data";
import { t } from "@/lib/i18n";
import type { TitleStatus } from "@/lib/types";
import { IconPlus } from "@/components/producer/icons";

// /producer — 作品管理. The pattern every Chinese creator console leads with
// (docs/ui-research.md): a poster grid of the producer's works, one status
// tag and one progress line per card, and a dashed "new" card. listTitles is
// scoped to the caller's own producer by the data layer.

export const dynamic = "force-dynamic";

// Statuses a producer reads about their own title, in their own words
// ("待确认", not "制片方审核中"); anything else falls back to the admin label.
const PRODUCER_STATUS = new Set<TitleStatus>(["candidate", "selected", "ingesting", "adapting", "in_review", "approved"]);

/** The title row's status does not advance when a producer generates, so a
 * title with adapted lines still says "uploaded" — read the progress instead. */
function producerStatusKey(status: TitleStatus, percentAdapted: number): string {
  const early = status === "candidate" || status === "selected" || status === "ingesting";
  if (early && percentAdapted > 0) return "pw.titleStatus.adapting";
  return PRODUCER_STATUS.has(status) ? `pw.titleStatus.${status}` : `admin.titleStatus.${status}`;
}

const STATUS_PILL: Partial<Record<TitleStatus, string>> = {
  in_review: "pill-warning",
  approved: "pill-success",
  live: "pill-success",
  dropped: "pill-error",
};

export default async function ProducerHome() {
  const session = await portalSession();
  const locale = producerLocale();
  const titles = await getData().listTitles(session);

  return (
    <>
      <div className="page-head">
        <div>
          <span className="page-kicker">{t(locale, "v3.library.kicker")}</span>
          <h2>{t(locale, "pw.home.title")}</h2>
          <p className="page-sub">{t(locale, "pw.home.sub")}</p>
        </div>
        <a className="btn btn-primary" href="/producer/titles/new"><IconPlus /> {t(locale, "pw.home.new")}</a>
      </div>

      <div className="poster-grid">
        {titles.map((title) => (
          <a className="poster" key={title.id} href={`/producer/titles/${title.id}`}>
            <div className="poster-cover">
              <span className={`pill ${STATUS_PILL[title.status] ?? "pill-neutral"}`}>
                {t(locale, producerStatusKey(title.status, title.percent_adapted))}
              </span>
              <span className="poster-cover-name bilingual" lang="zh-CN">
                {title.name_zh}
              </span>
            </div>
            <div className="poster-body">
              {title.name_en && (
                <span className="poster-title bilingual" lang="en">
                  {title.name_en}
                </span>
              )}
              <span className="poster-meta">
                <span>{t(locale, "pw.home.episodes", { n: title.episodes_ingested })}</span>
                <span>{t(locale, "pw.home.percent", { pct: title.percent_adapted })}</span>
              </span>
              <div className="track" aria-hidden>
                <div style={{ width: `${title.percent_adapted}%` }} />
              </div>
            </div>
          </a>
        ))}
      </div>
    </>
  );
}
