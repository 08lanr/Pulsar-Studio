// Reading crazydramas' stats (decision 2026-09-24, "CrazyDramas stats"):
// one authenticated POST /api/studio/stats through the Studio API transport
// (the fake in fixture mode; the live site in Supabase mode, or from fixture
// mode with the engineer's CRAZYDRAMAS_LIVE_READ=1), with the team's emails in
// the body so their visits and payments are left out (./stats-team.ts), parsed
// with the whitelist in ./stats-types.ts and kept for five minutes per team
// list, so a page that is reloaded, or opened on two tabs, asks crazydramas
// once. Server-only; the sums the screens show are the pure functions in
// ./stats-summary.ts.

import { crazydramasStudioMode, crazydramasStudioTransport } from "./studio-client";
import { readTeamList } from "./stats-team";
import { CdStatsReportSchema, type CdStatsReport } from "./stats-types";
import { CrazydramasApiError, type CrazydramasStudioTransport } from "./transport";

export const STATS_CACHE_MS = 5 * 60_000;

export type CdStatsRead =
  | { ok: true; report: CdStatsReport; read_at: string; mode: "fake" | "live"; team_emails: string[] }
  /** `code`: crazydramas' own code verbatim, or `read_off` (the live read is not allowed here: `error` names the setting), `unreachable`, `bad_response`. */
  | { ok: false; code: string; error: string; mode: "fake" | "live" | "off" };

type Cached = { at: number; read: Extract<CdStatsRead, { ok: true }> };
const holder = globalThis as typeof globalThis & { __studioCdStatsCache?: Map<string, Cached> };
const cache = (holder.__studioCdStatsCache ??= new Map<string, Cached>());

/** Forget the kept reads (tests; the page's Refresh passes `fresh` instead). */
export function clearCdStatsCache(): void {
  cache.clear();
}

export async function readCrazydramasStats(
  opts: { fresh?: boolean; transport?: CrazydramasStudioTransport; now?: () => number; teamEmails?: string[] } = {},
): Promise<CdStatsRead> {
  const now = opts.now ?? Date.now;
  const mode = opts.transport?.mode ?? crazydramasStudioMode().read;
  if (mode === "off") return { ok: false, code: "read_off", error: crazydramasStudioMode().read_refusal ?? "The live Studio API read is not allowed here.", mode: "off" };
  const team = [...(opts.teamEmails ?? (await readTeamList()).emails)].sort();
  const key = `${mode}|${team.join(",")}`;
  const kept = cache.get(key);
  if (!opts.fresh && kept && now() - kept.at < STATS_CACHE_MS) return kept.read;

  const transport = opts.transport ?? crazydramasStudioTransport();
  let answer: { status: number; body: unknown };
  let applied = team;
  try {
    answer = await transport.request("POST", "/api/studio/stats", { team_emails: team });
    // A crazydramas from before the team list answers the POST 405: read it with GET, nobody left out.
    if (answer.status === 405) {
      answer = await transport.request("GET", "/api/studio/stats");
      applied = [];
    }
  } catch (e) {
    return { ok: false, code: "unreachable", error: e instanceof CrazydramasApiError ? e.message : "crazydramas did not answer.", mode };
  }
  if (answer.status !== 200) {
    const body = (answer.body ?? {}) as { code?: unknown; error?: unknown };
    return {
      ok: false,
      code: typeof body.code === "string" ? body.code : `http_${answer.status}`,
      error: typeof body.error === "string" ? body.error : `crazydramas answered HTTP ${answer.status}.`,
      mode,
    };
  }
  const parsed = CdStatsReportSchema.safeParse(answer.body);
  if (!parsed.success) return { ok: false, code: "bad_response", error: "crazydramas answered stats Studio cannot read (an older or newer report version).", mode };
  const read = { ok: true as const, report: parsed.data, read_at: new Date(now()).toISOString(), mode, team_emails: applied };
  cache.set(key, { at: now(), read });
  return read;
}
