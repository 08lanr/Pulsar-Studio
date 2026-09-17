import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/api-guard";
import { requireSession } from "@/lib/auth";
import { dataSource } from "@/lib/data-source";
import { FIXTURE_PRODUCER_ID, systemSession } from "@/lib/auth";
import { currentFixtureSeed, fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { resetFakeTikTokForDemo } from "@/lib/tiktok/fake";
import { resetFakeMetaForClipPosts, resetFakeMetaForRuns } from "@/lib/meta/fake";
import { resetMetaPagePostCache } from "@/lib/meta/publish";
import { resetLaunchFixtureForProducer } from "@/lib/data/launch";
import { handle, parseJson } from "@/app/api/titles/_lib/handler";

// Fixture mode only: rebuild the in-memory demo dataset from data/fixture so a
// rehearsal starts from the same rows every time (decision 2026-09-09, "one
// demo journey"). Any signed-in member may reset: the store is process-wide
// demo data, not anyone's record. In supabase mode this route does not exist.
// Production data is never reseeded from a fixture.

const Body = z.object({ seed: z.enum(["demo", "empty"]).optional() });

export async function POST(req: NextRequest) {
  return handle(req, async () => {
    if (dataSource() !== "fixture") return apiError("Not found", undefined, 404);
    const g = await requireSession();
    if (g.response) return g.response;
    const parsed = await parseJson(req, Body);
    if (parsed.response) return parsed.response;
    const seed = parsed.data.seed ?? "demo";
    const system = systemSession();
    const titles = (await fixtureData.listTitles(system)).filter(title => title.producer_id === FIXTURE_PRODUCER_ID);
    const clipIds = (await Promise.all(titles.map(title => fixtureData.listEpisodeClips(system, title.id)))).flat().map(clip => clip.id);
    const oldCampaignIds = (await fixtureData.listLaunchedPromoCampaigns(system, { all: true }))
      .filter(row => row.campaign.producer_id === FIXTURE_PRODUCER_ID)
      .map(row => row.launch.tiktok_campaign_id).filter((id): id is string => !!id);
    const { runs: removedRuns, clipPosts: removedPosts } = resetLaunchFixtureForProducer(FIXTURE_PRODUCER_ID, clipIds);
    resetFixtureStore(seed);
    resetFakeTikTokForDemo(oldCampaignIds, removedRuns.filter(run => run.draft.provider === "tiktok").map(run => run.id), seed);
    resetFakeMetaForRuns(removedRuns.filter(run => run.draft.provider === "meta"));
    // The demo company's organic posts go with it, on the fake Page too.
    resetFakeMetaForClipPosts(removedPosts);
    resetMetaPagePostCache();
    return NextResponse.json({ ok: true, seed, reset_at: new Date().toISOString() });
  });
}

export async function GET(req: NextRequest) {
  return handle(req, async () => {
    if (dataSource() !== "fixture") return apiError("Not found", undefined, 404);
    const g = await requireSession();
    if (g.response) return g.response;
    return NextResponse.json({ mode: "fixture", seed: currentFixtureSeed() });
  });
}
