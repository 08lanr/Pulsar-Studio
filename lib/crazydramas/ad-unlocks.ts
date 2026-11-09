// Reading crazydramas' ad-unlocks report (decision 2026-11-09, "Ad unlocks in Studio"): one authenticated
// POST /api/studio/ad-unlocks through the Studio API transport, the stats report's way (./stats.ts): the fake in
// fixture mode, the live site in Supabase mode (or with CRAZYDRAMAS_LIVE_READ=1), the team's emails in the body so
// their ads are left out, parsed with the whitelist in ./ad-unlocks-types.ts and kept five minutes per team list.
// A crazydramas from before the route answers 404: `not_deployed`, and the tab says the numbers come with the
// next crazydramas release. Server-only; the sums are the pure ./ad-unlocks-summary.ts.

import { crazydramasStudioMode, crazydramasStudioTransport } from "./studio-client";
import { readTeamList } from "./stats-team";
import { AdUnlocksReportSchema, type AdUnlocksReport } from "./ad-unlocks-types";
import { CrazydramasApiError, type CrazydramasStudioTransport } from "./transport";

export const AD_UNLOCKS_PATH = "/api/studio/ad-unlocks";
export const AD_UNLOCKS_CACHE_MS = 5 * 60_000;

export type AdUnlocksRead =
  | { ok: true; report: AdUnlocksReport; read_at: string; mode: "fake" | "live"; team_emails: string[] }
  /** `code`: crazydramas' own code verbatim, or `not_deployed` (404: no route yet), `read_off`, `unreachable`, `bad_response`. */
  | { ok: false; code: string; error: string; mode: "fake" | "live" | "off" };

type Cached = { at: number; read: Extract<AdUnlocksRead, { ok: true }> };
const holder = globalThis as typeof globalThis & { __studioCdAdUnlocksCache?: Map<string, Cached> };
const cache = (holder.__studioCdAdUnlocksCache ??= new Map<string, Cached>());

export function clearAdUnlocksCache(): void {
  cache.clear();
}

export async function readCrazydramasAdUnlocks(
  opts: { fresh?: boolean; transport?: CrazydramasStudioTransport; now?: () => number; teamEmails?: string[] } = {},
): Promise<AdUnlocksRead> {
  const now = opts.now ?? Date.now;
  const mode = opts.transport?.mode ?? crazydramasStudioMode().read;
  if (mode === "off") return { ok: false, code: "read_off", error: crazydramasStudioMode().read_refusal ?? "The live Studio API read is not allowed here.", mode: "off" };
  const team = [...(opts.teamEmails ?? (await readTeamList()).emails)].sort();
  const key = `${mode}|${team.join(",")}`;
  const kept = cache.get(key);
  if (!opts.fresh && kept && now() - kept.at < AD_UNLOCKS_CACHE_MS) return kept.read;

  const transport = opts.transport ?? crazydramasStudioTransport();
  let answer: { status: number; body: unknown };
  try {
    answer = await transport.request("POST", AD_UNLOCKS_PATH, { team_emails: team });
  } catch (e) {
    return { ok: false, code: "unreachable", error: e instanceof CrazydramasApiError ? e.message : "crazydramas did not answer.", mode };
  }
  if (answer.status === 404) return { ok: false, code: "not_deployed", error: "crazydramas has no ad-unlocks report yet.", mode };
  if (answer.status !== 200) {
    const body = (answer.body ?? {}) as { code?: unknown; error?: unknown };
    return {
      ok: false,
      code: typeof body.code === "string" ? body.code : `http_${answer.status}`,
      error: typeof body.error === "string" ? body.error : `crazydramas answered HTTP ${answer.status}.`,
      mode,
    };
  }
  const parsed = AdUnlocksReportSchema.safeParse(answer.body);
  if (!parsed.success) return { ok: false, code: "bad_response", error: "crazydramas answered an ad-unlocks report Studio cannot read (an older or newer report version).", mode };
  const read = { ok: true as const, report: parsed.data, read_at: new Date(now()).toISOString(), mode, team_emails: team };
  cache.set(key, { at: now(), read });
  return read;
}
