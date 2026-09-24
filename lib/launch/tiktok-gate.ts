// What a TikTok launch must satisfy before it can be previewed or approved
// (decision 2026-09-23, "TikTok launch: crazydramas link contract + pixel +
// one account"), shared by both data backends through lib/data/launch.ts:
//
//   the title    every TikTok ad links to the title's crazydramas page, so the
//                draft names a title of the company whose slug is real (not
//                missing, not `mock-`, lowercase words) and whose series is
//                live by the phase 3a reading (lib/crazydramas); a title that
//                does not read live gets one fresh public check first
//   the link     the draft carries exactly crazydramasAdUrl(slug), and each ad
//                its own title's (a launch may promote several titles; a
//                Sales Instant Page, with one button, promotes one)
//   the pixel    Website purchases only: the signed pixel code is the current
//                TIKTOK_PIXEL_CODE and resolves, read-only, on every chosen
//                ad account (lib/tiktok/pixel.ts)
//
// Server-only; reads, never writes to TikTok or crazydramas (the fresh check
// writes Studio's own snapshot row, as Check now does).

import { systemSession, type Session } from "@/lib/auth";
import { getData } from "@/lib/data";
import { conflict, invalid, notFound } from "@/lib/data/errors";
import { checkCrazydramasTitle, loadCrazydramasStatus, loadCrazydramasStatuses, PLATFORM, type CrazydramasStatus } from "@/lib/crazydramas";
import { crazydramasAdUrl, crazydramasSlugProblem } from "@/lib/tiktok/ad-url";
import { tiktokPixelCode } from "@/lib/tiktok/pixel";
import { probePixel } from "@/lib/tiktok/preflight";
import { attributionLabel, attributionOf, launchShape, webEventLabel } from "@/lib/tiktok/settings";
import type { Title } from "@/lib/types";
import type { LaunchConnection, LaunchDraft, LaunchPlan, LaunchTitleOption } from "./types";

const LIVE_STATES = new Set(["live_complete", "live_partial", "live_differs", "live_unverified", "local_newer"]);

/**
 * Whether ads may send people to this series: the phase 3a reading says it is
 * published. A read that failed after a good published read stays live (the
 * site answered before; one failed GET is not a takedown); a series read as a
 * draft, archived, missing or reassigned to another drama is not.
 */
export function crazydramasLaunchable(status: Pick<CrazydramasStatus, "state" | "stale" | "series" | "detail" | "note">): boolean {
  if (LIVE_STATES.has(status.state)) return true;
  return status.state === "read_failed" && status.stale && !!status.series && !status.detail && !status.note;
}

function stateWords(status: CrazydramasStatus): string {
  if (status.state === "not_checked") return "not checked yet";
  if (status.state === "read_failed") return `the last read failed${status.error ? `: ${status.error}` : ""}`;
  if (status.detail === "draft") return "it is a draft";
  if (status.detail === "archived") return "it is archived";
  if (status.note === "slug_reassigned") return "the slug now serves another series";
  return "crazydramas answers that it is not published";
}

async function titleOf(s: Session, titleId: string, producerId: string): Promise<{ title: Title; name: string; status: CrazydramasStatus }> {
  const detail = await getData().getTitle(s, titleId);
  if (detail.title.producer_id !== producerId) throw notFound("Title");
  const status = await loadCrazydramasStatus(s, detail.title);
  return { title: detail.title, name: detail.title.name_en || detail.title.name_zh, status };
}

/** The ad link a draft's title gives it today, or null when the title's slug cannot carry one. Used on save. */
export async function tiktokLandingFor(s: Session, titleId: string, producerId: string): Promise<string | null> {
  const { status } = await titleOf(s, titleId, producerId);
  return crazydramasSlugProblem(status.slug) === null ? crazydramasAdUrl(status.slug!) : null;
}

/** Every title of the company that has a crazydramas slug, with its reading, for the Launch screen's title list. */
export async function launchTitleOptions(s: Session, producerId: string): Promise<LaunchTitleOption[]> {
  const titles = (await getData().listTitlesWithPlatformSlug(s, PLATFORM)).filter((t) => t.producer_id === producerId);
  const statuses = await loadCrazydramasStatuses(s, titles);
  return titles.map((t) => {
    const status = statuses.get(t.id);
    const slug = status?.slug ?? t.crazydramas_slug ?? null;
    return { id: t.id, name: t.name_en || t.name_zh, slug, state: status?.state ?? null,
      live: !!status && crazydramasLaunchable(status),
      ad_url: crazydramasSlugProblem(slug) === null ? crazydramasAdUrl(slug!) : null };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * One title a TikTok ad promotes, checked: the company's, a real slug, a live
 * series (after one fresh public read when the stored reading is not live).
 * Returns the title's name and the one link its ads carry.
 */
async function launchableTitle(s: Session, titleId: string, producerId: string): Promise<{ name: string; link: string }> {
  const found = await titleOf(s, titleId, producerId);
  let status = found.status;
  const problem = crazydramasSlugProblem(status.slug);
  if (problem === "missing") throw invalid(`${found.name} has no crazydramas link. Add its crazydramas slug to the title before launching on TikTok.`);
  if (problem === "mock") throw invalid(`${found.name} points at "${status.slug}", a crazydramas design mock, not a real series.`);
  if (problem) throw invalid(`${found.name} has a crazydramas slug ("${status.slug}") that is not lowercase words joined by hyphens.`);
  if (!crazydramasLaunchable(status)) {
    // One fresh public read before refusing: the hourly sweep may not have
    // seen the series go live yet. The caller's session already proved the
    // title is theirs to read, and the snapshot is Studio's own record, so the
    // read runs as the system actor (as the sweep does) and a viewer's preview
    // gets it too. A refused or failed check keeps the stored reading.
    try { status = (await checkCrazydramasTitle(systemSession(), found.title.id)).status; } catch { /* the stored reading stands */ }
  }
  if (!crazydramasLaunchable(status)) throw invalid(`${found.name} is not live on crazydramas.com (${stateWords(status)}), so its ads would land on a missing page. Publish the series, then preview again.`);
  return { name: found.name, link: crazydramasAdUrl(status.slug!) };
}

/**
 * The preview and approval gate for a TikTok draft: the launch's title and
 * every title an ad promotes (each a live series, each ad carrying its own
 * title's exact link, a picked clip from that same title; an Instant Page
 * launch promotes one title), then the pixel. Throws the sentence a person
 * reads; returns the pixel summary a Website purchases plan carries.
 */
export async function tiktokLaunchGate(s: Session, draft: LaunchDraft, producerId: string, own: readonly LaunchConnection[]): Promise<LaunchPlan["tiktok_pixel"] | undefined> {
  if (draft.provider !== "tiktok") return undefined;
  if (!draft.title_id) throw invalid("TikTok ads link to the title's crazydramas page. Choose the title this launch promotes.");
  // The launch's title (every ad's default, the campaign's link) and every
  // title an ad names, each checked once.
  const checked = new Map<string, { name: string; link: string }>();
  const title = async (id: string) => {
    if (!checked.has(id)) checked.set(id, await launchableTitle(s, id, producerId));
    return checked.get(id)!;
  };
  const launchTitleId: string = draft.title_id;
  const launchTitle = await title(launchTitleId);
  if (draft.destination_url !== launchTitle.link) throw conflict("The title's crazydramas link changed since this draft was saved. Save the draft and preview again.");
  const clipIds = draft.content.map((c) => c.clip_id).filter((id): id is string => !!id);
  const clips = clipIds.length ? await getData().listClipLibrary(s, { producer_id: producerId }) : [];
  const instantPage = launchShape(draft.tiktok_settings) === "instant_page";
  for (const [index, item] of draft.content.entries()) {
    const ad = `Ad ${index + 1}`;
    const titleId: string = item.title_id ?? launchTitleId;
    const adTitle = await title(titleId);
    // A picked clip names the title the Spark code was made from: an ad that
    // promotes another title would send its viewers to the wrong show.
    const clip = item.clip_id ? clips.find((c) => c.id === item.clip_id) : undefined;
    if (clip && clip.title_id !== titleId) throw invalid(`${ad} is made from a clip of ${clip.title_name}, but it is set to promote ${adTitle.name}. Set the ad's title to ${clip.title_name}, or clear its clip.`);
    // Content saved before per-ad titles carries the campaign's link, the launch's title.
    const expected = item.landing_url === undefined && titleId === launchTitleId ? undefined : adTitle.link;
    if (item.landing_url !== expected) throw conflict(`${ad}'s crazydramas link changed since this draft was saved. Save the draft and preview again.`);
    if (instantPage && titleId !== launchTitleId) throw invalid(`${ad} promotes ${adTitle.name}, but a Sales Instant Page has one button link, so every ad in this launch must promote ${launchTitle.name}. Set the ad to ${launchTitle.name}, or use Website purchases or Traffic to promote several titles in one launch.`);
  }
  const settings = draft.tiktok_settings;
  if (launchShape(settings) !== "website_purchases") return undefined;
  const code = tiktokPixelCode();
  if (settings.pixel_code && settings.pixel_code !== code) throw conflict("The TikTok pixel setting changed since this draft was saved. Save the draft and preview again.");
  const accounts: { connection_id: string; pixel_id: string }[] = [];
  for (const connection of own.filter((c) => draft.account_ids.includes(c.id))) {
    const pixel = await probePixel(connection.advertiser_id, code);
    if (!pixel.ok) throw invalid(pixel.message);
    accounts.push({ connection_id: connection.id, pixel_id: pixel.pixel_id });
  }
  return { code, event: webEventLabel(settings.optimization_event), attribution: attributionLabel(attributionOf(settings)), accounts };
}
