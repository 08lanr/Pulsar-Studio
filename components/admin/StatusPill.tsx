// Status pills for the three status vocabularies the admin screens show —
// a title's pipeline status, an episode's derived status and a version's
// gate status — mapped onto the design system's five pill variants. Server
// and client safe: labels come in through t()/tt() by the caller's locale,
// so the component takes a label and only decides the colour.

import type { EpisodeStatus, TitleStatus, VersionStatus } from "@/lib/types";

const TITLE_CLASS: Record<TitleStatus, string> = {
  candidate: "pill-neutral",
  selected: "pill-neutral",
  ingesting: "status-ingested",
  adapting: "status-adapting",
  in_review: "status-review",
  approved: "status-approved",
  live: "status-live",
  ended: "pill-neutral",
  dropped: "pill-neutral",
};

const EPISODE_CLASS: Record<EpisodeStatus, string> = {
  ingested: "status-ingested",
  adapting: "status-adapting",
  in_review: "status-review",
  approved: "status-approved",
};

const VERSION_CLASS: Record<VersionStatus, string> = {
  draft: "pill-neutral",
  in_review: "status-review",
  approved: "status-approved",
  superseded: "pill-neutral",
};

/** Dictionary key for each status; every key lives in locales/_keys/admin.json. */
export function titleStatusKey(s: TitleStatus): string {
  return `admin.titleStatus.${s}`;
}
export function episodeStatusKey(s: EpisodeStatus): string {
  return `admin.episodeStatus.${s}`;
}
export function versionStatusKey(s: VersionStatus): string {
  return `admin.versionStatus.${s}`;
}

export function TitlePill({ status, label }: { status: TitleStatus; label: string }) {
  return <span className={`pill ${TITLE_CLASS[status]}`}>{label}</span>;
}

export function EpisodePill({ status, label }: { status: EpisodeStatus; label: string }) {
  return <span className={`pill ${EPISODE_CLASS[status]}`}>{label}</span>;
}

export function VersionPill({ status, label }: { status: VersionStatus; label: string }) {
  return <span className={`pill ${VERSION_CLASS[status]}`}>{label}</span>;
}
