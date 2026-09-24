// Which crazydramas the app reads (decision 2026-09-23, "the crazydramas
// connection"; plan A2), the way lib/meta/index.ts and lib/tiktok/index.ts
// choose:
//
//   fixture mode    the fake, always: no network, the fixture catalog that
//                   mirrors tests/fixtures/workspace. One exception for
//                   engineers: CRAZYDRAMAS_LIVE_READ=1 allows the public
//                   reads from fixture mode (they cost nothing and write
//                   nothing on crazydramas; the snapshots land in the
//                   in-memory store).
//   supabase mode   the live transport against CRAZYDRAMAS_BASE_URL.
//
// Its own small module, imported by sweep.ts and re-exported by index.ts:
// when the choice lived in index.ts, sweep.ts importing it while index.ts
// re-exported sweep.ts made a cycle, which the phase 3a review first blamed
// for a `next build` that ran out of heap (the cause was output tracing
// walking the runtime .uploads folder; next.config.js excludes it since).
// Nothing inside this folder imports "./index"; everything outside asks
// "@/lib/crazydramas".

import { dataSource } from "@/lib/data-source";
import { fakeCrazydramasTransport } from "./fake";
import { fixturePosterPreview } from "./publish-types";
import { liveCrazydramasTransport, type CrazydramasTransport } from "./transport";

export type CrazydramasReadMode = "fake" | "live";

export function crazydramasReadMode(): CrazydramasReadMode {
  if (dataSource() === "fixture") return process.env.CRAZYDRAMAS_LIVE_READ === "1" ? "live" : "fake";
  return "live";
}

/** A base URL or an override can never make a test reach crazydramas: the live transport refuses under node:test. */
export function crazydramasTransport(): CrazydramasTransport {
  if (typeof window !== "undefined") throw new Error("crazydramas reads are server-only.");
  return crazydramasReadMode() === "fake" ? fakeCrazydramasTransport : liveCrazydramasTransport;
}

/**
 * The poster URL a screen may put in an <img>: in fake mode only a
 * same-origin one (the fake's SVGs under /crazydramas-fake/). The fixture
 * store persists its snapshots, so one run with CRAZYDRAMAS_LIVE_READ=1
 * leaves real https://crazydramas.com/posters/... URLs behind, and a later
 * plain fixture run would otherwise have the browser fetch them from
 * crazydramas.com (the phase 3a review, round two). The facts about the
 * poster (set, placeholder) are still shown; only the picture is withheld.
 * A poster fixture mode's stand-in bucket holds (its made-up
 * `https://studio-fixture.invalid/api/public-posters/…` address, decision
 * 2026-09-23 "Upload automation") is shown through the same-origin route.
 */
export function shownPosterUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const fixture = fixturePosterPreview(url);
  if (fixture) return fixture;
  if (crazydramasReadMode() === "fake" && !(url.startsWith("/") && !url.startsWith("//"))) return null;
  return url;
}
