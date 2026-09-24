// What the Materials page and GET .../clips return for one episode: the
// clip rows with their download URLs and the derived run state. One
// builder so the server page and the polling route agree.

import type { Session } from "@/lib/auth";
import { getData } from "@/lib/data";
import { mediaUrl } from "@/lib/data/storage";
import type { Clip, Job } from "@/lib/types";
import { clipRunState, type ClipRunState } from "./state";

export type ClipRow = Clip & { download_url: string | null };

export type EpisodeClipsPayload = {
  episode_number: number;
  state: ClipRunState;
  note: string | null;
  clips: ClipRow[];
  job: Pick<Job, "id" | "status" | "started_at" | "finished_at" | "error"> | null;
};

export async function episodeClipsPayload(session: Session, titleId: string, episodeNumber: number): Promise<EpisodeClipsPayload> {
  const data = getData();
  const [clips, job] = await Promise.all([data.listEpisodeClips(session, titleId, episodeNumber), data.latestEpisodeJob(session, titleId, episodeNumber, "cut_clips")]);
  // A 60-second ad belongs to the title, not to the episode its hook hangs on: it is listed on its own.
  const visible = clips.filter((c) => c.status !== "dismissed" && c.moment !== "montage");
  const { state, note } = clipRunState(visible, job);
  return {
    episode_number: episodeNumber,
    state,
    note,
    clips: visible.map((c) => ({ ...c, download_url: c.render_status === "rendered" ? mediaUrl(c.render_path) : null })),
    job: job ? { id: job.id, status: job.status, started_at: job.started_at, finished_at: job.finished_at, error: job.error } : null,
  };
}
