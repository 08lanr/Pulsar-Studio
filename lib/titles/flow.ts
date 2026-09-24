// The per-film flow strip (overnight spec item 14, 2026-09-24): on each
// title page, the six steps a film walks from the cutting pipeline to its ad
// results, each marked done, next, not yet or not needed, each linking to
// the page where it happens:
//
//   Segment → Import → Upload to crazydramas → Ad clips → Launch → Stats
//
// "Segment a film" and "Ad clips" are both cutting, for different ends: the
// first cuts the film into the series' episodes, the second cuts short clips
// for ads; the strip says which is which. Pure (`titleFlow`) plus the one
// read the pages call (`loadTitleFlow`); nothing here writes.

import type { Session } from "@/lib/auth";
import { getData } from "@/lib/data";
import type { CrazydramasState } from "@/lib/crazydramas/match";
import { titleResults } from "@/lib/launch/title-stats";

export type FlowStepId = "segment" | "import" | "upload" | "clips" | "launch" | "stats";
export type FlowStepState = "done" | "next" | "later" | "skip";
export type FlowStep = { id: FlowStepId; state: FlowStepState; href: string | null };

export type FlowFacts = {
  /** The title came from a workspace film (`source_ref`): it was segmented and imported. */
  imported: boolean;
  /** Episodes with a video file. */
  episodes_with_video: number;
  /** Where the series stands on crazydramas (the chip's state). */
  crazydramas: CrazydramasState;
  /** Finished ad clips of the title. */
  clips_ready: number;
  /** Campaigns a launch created for the title. */
  campaigns: number;
};

export const FLOW_STEPS: readonly FlowStepId[] = ["segment", "import", "upload", "clips", "launch", "stats"];

const LIVE: ReadonlySet<CrazydramasState> = new Set(["live_complete", "live_partial", "live_differs", "live_unverified", "local_newer"]);

/** Each step's page, for the staff desk or the producer portal; null where the portal has none. */
export function flowHref(id: FlowStepId, titleId: string, portal: "admin" | "producer"): string | null {
  const staff = portal === "admin";
  switch (id) {
    case "segment":
      return staff ? "/films/runs" : null;
    case "import":
      return staff ? "/films/import" : "/producer/films/import";
    case "upload":
      return `${staff ? `/titles/${titleId}` : `/producer/titles/${titleId}`}/crazydramas#cd-publish`;
    case "clips":
      return staff ? `/titles/${titleId}/clips` : `/producer/titles/${titleId}/clips`;
    case "launch":
      return staff ? "/promote/launches" : "/producer/launch";
    case "stats":
      return staff ? `/promote/monitor/titles/${titleId}` : `/producer/monitor/titles/${titleId}`;
  }
}

/**
 * The strip, pure. Segment and Import are done for an imported film and not
 * needed for a title made in Studio (its episodes were uploaded there).
 * Upload is done once the series is live, Ad clips once one clip is
 * finished, Launch once a launch made a campaign, Stats once there is a
 * campaign to read. The first step that is neither done nor not needed is
 * next; the ones after it are not yet.
 */
export function titleFlow(facts: FlowFacts, titleId: string, portal: "admin" | "producer"): FlowStep[] {
  const done: Record<FlowStepId, boolean | null> = {
    segment: facts.imported ? true : null,
    import: facts.imported ? true : null,
    upload: LIVE.has(facts.crazydramas),
    clips: facts.clips_ready > 0,
    launch: facts.campaigns > 0,
    stats: facts.campaigns > 0,
  };
  let nextFound = false;
  return FLOW_STEPS.map((id) => {
    const d = done[id];
    let state: FlowStepState;
    if (d === null) state = "skip";
    else if (d) state = "done";
    else if (!nextFound) {
      state = "next";
      nextFound = true;
    } else state = "later";
    return { id, state, href: flowHref(id, titleId, portal) };
  });
}

/** The strip for one title the session can read: its episodes, clips and launches, and the crazydramas state the page already has. */
export async function loadTitleFlow(session: Session, title: { id: string; source_ref?: string | null }, episodesWithVideo: number, crazydramas: CrazydramasState, portal: "admin" | "producer"): Promise<FlowStep[]> {
  const data = getData();
  const [clips, runs] = await Promise.all([
    data.listEpisodeClips(session, title.id).catch(() => []),
    data.listLaunchRuns(session).catch(() => []),
  ]);
  const results = titleResults(runs, title.id);
  return titleFlow({
    imported: !!title.source_ref,
    episodes_with_video: episodesWithVideo,
    crazydramas,
    clips_ready: clips.filter((c) => c.render_status === "rendered").length,
    campaigns: results.campaigns.length,
  }, title.id, portal);
}
