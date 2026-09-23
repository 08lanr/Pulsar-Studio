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
// re-exported sweep.ts made a cycle that `next build` could not finish
// under the default heap (the phase 3a review). Nothing inside this folder
// imports "./index"; everything outside asks "@/lib/crazydramas".

import { dataSource } from "@/lib/data-source";
import { fakeCrazydramasTransport } from "./fake";
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
