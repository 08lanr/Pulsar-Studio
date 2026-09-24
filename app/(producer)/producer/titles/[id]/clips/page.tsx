import { notFound } from "next/navigation";
import { portalSession, producerLocale } from "@/components/producer/server";
import { getData, isDataError } from "@/lib/data";
import ClipsLibrary from "@/components/launch/ClipsLibrary";
import { titleName } from "@/components/producer/TitleShell";
import { t } from "@/lib/i18n";
import { montageStatus, type MontageStatus } from "@/lib/clips/montage-run";

export const dynamic = "force-dynamic";

export default async function TitleClipsPage({ params }: { params: { id: string } }) {
  const session = await portalSession(`/producer/titles/${params.id}/clips`);
  let initial: MontageStatus | null = null;
  let title: { name_zh: string; name_en: string | null } | null = null;
  try {
    title = (await getData().getTitle(session, params.id)).title;
    initial = await montageStatus(session, params.id);
  } catch (error) {
    if (isDataError(error) && (error.code === "not_found" || error.code === "forbidden")) notFound();
    throw error;
  }
  // The 60-second ad is built by the title's reviewer or approver; staff previewing the portal only look (CLAUDE.md).
  const canBuild = session.kind === "producer" && (session.producerRole === "approver" || session.producerRole === "reviewer");
  // Which title these clips are, and the way back to it (UI sweep 2026-09-24: the page read as the whole library).
  const locale = producerLocale();
  const name = titleName(locale, title!.name_zh, title!.name_en);
  return <>
    <nav className="studio-crumbs" aria-label={t(locale, "v3.breadcrumbs")}><a href="/producer/titles">{t(locale, "ws.nav.catalog")}</a><span aria-hidden>›</span><a href={`/producer/titles/${params.id}`} lang={name.lang}>{name.primary}</a><span aria-hidden>›</span><span>{t(locale, "lv2.clips.title")}</span></nav>
    <ClipsLibrary titleId={params.id} montage={{ canBuild, initial }} />
  </>;
}
