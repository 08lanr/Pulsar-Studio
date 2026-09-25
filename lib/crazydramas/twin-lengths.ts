// A show already on crazydramas, found by its episodes' lengths (decision
// 2026-09-24 "Match live shows by episode lengths"). Studio used to recognise a
// live show only by its name (the working-name table, the catalog's titles):
// Love Between Lines, imported by folder as "Love between lines", was live as
// "Who Are You When the Game Ends? Season 1" (31 episodes, made in the CMS),
// and the upload page was one click from a second series of the same show.
// Names change; a cut's lengths do not. The first episodes of the title are
// compared with the first episodes of every series in the catalog: three or
// more lengths within LENGTH_TOLERANCE_S, and at least 80% of those compared,
// is the same show (episodes under LENGTH_MIN_SECONDS are not compared). Used
// where Studio picks a slug (import) and before it creates a series
// (saveSeries), so a match links instead of duplicating.
// The catalog lists published series only; a CMS draft is not seen.

import { systemSession } from "@/lib/auth";
import { getData } from "@/lib/data";
import { crazydramasTransport } from "./pick";
import { isMockSlug } from "./slug";
import type { CrazydramasTransport } from "./transport";

/** Two lengths are the same episode within this many seconds (crazydramas rounds; encodes differ by a frame or two). */
export const LENGTH_TOLERANCE_S = 1.5;
/** How many leading episodes are compared. */
export const LENGTH_PROBE = 6;
/** The fewest matching lengths that make a twin. */
export const LENGTH_MIN_MATCHES = 3;
/** Episodes shorter than this say nothing about which show they are (a few seconds matches anything); they are not compared. */
export const LENGTH_MIN_SECONDS = 30;

export type LengthMatch = { matched: number; compared: number };

export type LengthTwin = LengthMatch & { slug: string; id: string; title: string; managed_by: "studio" | "cms" | null };

/** Compare two episode-length lists (seconds, episode 1 first; null = unknown). Pure. */
export function compareLengths(ours: readonly (number | null)[], theirs: readonly (number | null)[]): LengthMatch {
  let matched = 0;
  let compared = 0;
  for (let i = 0; i < LENGTH_PROBE; i++) {
    const a = ours[i];
    const b = theirs[i];
    if (a == null || b == null || !(a >= LENGTH_MIN_SECONDS) || !(b >= LENGTH_MIN_SECONDS)) continue;
    compared++;
    if (Math.abs(a - b) <= LENGTH_TOLERANCE_S) matched++;
  }
  return { matched, compared };
}

/** Is it the same show? Pure. */
export function isLengthTwin(m: LengthMatch): boolean {
  return m.matched >= LENGTH_MIN_MATCHES && m.matched * 5 >= m.compared * 4;
}

/** The title's episode lengths in seconds, episode 1 first (null where unmeasured). */
export async function titleLengths(titleId: string): Promise<(number | null)[]> {
  const eps = (await getData().getTitle(systemSession(), titleId)).episodes;
  const byN = new Map(eps.map((e) => [e.number, e.duration_ms ? e.duration_ms / 1000 : null] as const));
  return Array.from({ length: LENGTH_PROBE }, (_, i) => byN.get(i + 1) ?? null);
}

export type FindTwinOptions = {
  transport?: CrazydramasTransport;
  /** Series that may not be the answer (another title holds them). */
  skip?: (s: { id: string; slug: string }) => boolean;
};

/**
 * The live series whose episodes match the title's, or null. Throws when the
 * catalog cannot be read (the caller decides: refuse, or carry on softly). A
 * series whose own read fails is passed over.
 */
export async function findLengthTwin(titleId: string, opts: FindTwinOptions = {}): Promise<LengthTwin | null> {
  const ours = await titleLengths(titleId);
  if (ours.filter((x) => x != null && x >= LENGTH_MIN_SECONDS).length < LENGTH_MIN_MATCHES) return null;
  const transport = opts.transport ?? crazydramasTransport();
  const catalog = (await transport.catalog()).filter((d) => !isMockSlug(d.slug) && !opts.skip?.({ id: d.id, slug: d.slug }));
  const reads = await Promise.all(
    catalog.map(async (d) => {
      try {
        const r = await transport.series(d.slug);
        if (r.http_status !== 200 || !r.episodes) return null;
        const byN = new Map(r.episodes.map((e) => [e.n, e.duration_s ?? null] as const));
        const m = compareLengths(ours, Array.from({ length: LENGTH_PROBE }, (_, i) => byN.get(i + 1) ?? null));
        return isLengthTwin(m) ? { ...m, slug: d.slug, id: d.id, title: d.title, managed_by: r.drama?.managed_by ?? d.managed_by ?? null } : null;
      } catch {
        return null;
      }
    }),
  );
  return reads.filter((x): x is LengthTwin => !!x).sort((a, b) => b.matched - a.matched)[0] ?? null;
}

/** "N of M episode lengths" for the screens. Pure. */
export function lengthWords(m: LengthMatch): string {
  return `${m.matched} of the first ${m.compared} episode lengths match`;
}
