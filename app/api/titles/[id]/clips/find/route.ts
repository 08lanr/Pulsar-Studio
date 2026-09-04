// The clip finder: the best ad moments of an episode with timestamp range,
// hook, why, opening text and cut length. With episode_number it runs one
// episode; without, every ingested episode that has timecodes (an untimed
// script has nothing to cut). `force` starts a fresh job for a version
// whose suggestions already exist. Returns the title's clips afterwards.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireStaff } from "@/lib/auth";
import { DataError, getData } from "@/lib/data";
import { runFindClips } from "@/lib/jobs";
import { handle, parseJson } from "../../../_lib/handler";

const Body = z.object({
  episode_number: z.number().int().positive().optional(),
  force: z.boolean().optional(),
});

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  return handle(req, async () => {
    const g = await requireStaff();
    if (g.response) return g.response;
    const p = await parseJson(req, Body);
    if (p.response) return p.response;
    const data = getData();
    const opts = { force: p.data.force };

    if (p.data.episode_number !== undefined) {
      const r = await runFindClips(g.session, params.id, p.data.episode_number, opts);
      return NextResponse.json({ clips: r.clips, job: r.job });
    }

    const detail = await data.getTitle(g.session, params.id);
    const timed = detail.episodes.filter((e) => e.has_timecodes && e.lines_total > 0).sort((a, b) => a.number - b.number);
    if (!timed.length) throw new DataError("invalid", "no episode with timecodes to search for clips");
    const jobs = [];
    for (const ep of timed) jobs.push((await runFindClips(g.session, params.id, ep.number, opts)).job);
    const clips = await data.listClips(g.session, params.id);
    return NextResponse.json({ clips, jobs });
  });
}
