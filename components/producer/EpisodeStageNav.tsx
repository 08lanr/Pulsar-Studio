"use client";

import { useT } from "@/components/locale";
import { IconCaptions, IconChevronRight, IconScript } from "./icons";

type Props = {
  titleId: string;
  titleName: string;
  episodeNumber: number;
  active: "script" | "subtitles";
  finalized: boolean;
};

export default function EpisodeStageNav({ titleId, titleName, episodeNumber, active, finalized }: Props) {
  const { tt } = useT();
  const root = `/producer/titles/${titleId}`;
  const episode = `${root}/episodes/${episodeNumber}`;

  return (
    <div className="episode-context">
      <nav className="studio-crumbs" aria-label={tt("v3.breadcrumbs")}>
        <a href="/producer">{tt("v3.nav.library")}</a>
        <IconChevronRight size={13} />
        <a href={root}>{titleName}</a>
        <IconChevronRight size={13} />
        <span>{tt("review.episode", { n: episodeNumber })}</span>
      </nav>
      <div className="episode-stagebar">
        <div className="episode-identity">
          <span className="episode-number">{String(episodeNumber).padStart(2, "0")}</span>
          <div>
            <strong>{tt("v3.episode.workspace")}</strong>
            <small>{finalized ? tt("v3.version.final") : tt("v3.version.draft")}</small>
          </div>
        </div>
        <nav className="episode-tabs" aria-label={tt("v3.episode.stages")}>
          <a className={active === "script" ? "is-active" : ""} href={episode} aria-current={active === "script" ? "page" : undefined}>
            <IconScript />
            <span>{tt("v3.stage.script")}</span>
            {finalized && <i aria-label={tt("v3.complete")}>✓</i>}
          </a>
          <a
            className={`${active === "subtitles" ? "is-active" : ""} ${!finalized ? "is-locked" : ""}`}
            href={finalized ? `${episode}/subtitles` : episode}
            aria-current={active === "subtitles" ? "page" : undefined}
            aria-disabled={!finalized}
          >
            <IconCaptions />
            <span>{tt("v3.stage.timingDelivery")}</span>
          </a>
        </nav>
      </div>
    </div>
  );
}
