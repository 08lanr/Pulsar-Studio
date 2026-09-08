// Loads published market snapshots (schema v2).
//
// The loader follows data/research/published.json: `latest_run_id` is the
// newest validated run; `days` maps each observed date to the run that
// represents it (the latest validated run of that day; earlier runs of the
// same day stay on disk, unpublished). A file that fails the zod schema is
// reported as an error state, never silently skipped.
//
// Both data sources read the same files: the snapshot is public-catalog
// data with no per-producer rows, so fixture and Supabase modes are
// equivalent by construction. Cached on globalThis for the process (Next
// bundles lib/ per route) and re-read at most once a minute.

import fs from "node:fs";
import path from "node:path";
import { marketSnapshotSchema, publicationSchema, type MarketSnapshot, type Publication } from "./types";

const DIR = path.join(process.cwd(), "data", "research");
const CACHE_KEY = "__pulsar_market_v2__";

export type PublicationState = "published" | "none" | "invalid";

export type MarketView = {
  /** The newest validated run. */
  latest: MarketSnapshot | null;
  /** The newest validated run of the most recent EARLIER day; null with one day of history. */
  previous: MarketSnapshot | null;
  /** Every published day, oldest first: [date, run_id]. */
  days: [string, string][];
  publication: {
    state: PublicationState;
    published_at: string | null;
    last_failure: Publication["last_failure"];
    /** Load errors for files the pointer names but the schema rejects. */
    errors: string[];
  };
};

type Cache = { loaded_at: number; view: MarketView; byRun: Map<string, MarketSnapshot> };

function readSnapshot(runId: string, errors: string[]): MarketSnapshot | null {
  const file = path.join(DIR, "snapshots", `${runId}.json`);
  if (!fs.existsSync(file)) {
    errors.push(`${runId}: snapshot file missing`);
    return null;
  }
  try {
    const parsed = marketSnapshotSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
    if (!parsed.success) {
      errors.push(`${runId}: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
      return null;
    }
    return parsed.data as MarketSnapshot;
  } catch (err) {
    errors.push(`${runId}: ${(err as Error).message}`);
    return null;
  }
}

function load(): Cache {
  const errors: string[] = [];
  const byRun = new Map<string, MarketSnapshot>();
  const empty: MarketView = { latest: null, previous: null, days: [], publication: { state: "none", published_at: null, last_failure: null, errors } };
  const pubFile = path.join(DIR, "published.json");
  if (!fs.existsSync(pubFile)) return { loaded_at: Date.now(), view: empty, byRun };
  let publication: Publication;
  try {
    const parsed = publicationSchema.safeParse(JSON.parse(fs.readFileSync(pubFile, "utf8")));
    if (!parsed.success) {
      errors.push(`published.json: ${parsed.error.issues[0]?.message}`);
      return { loaded_at: Date.now(), view: { ...empty, publication: { ...empty.publication, state: "invalid" } }, byRun };
    }
    publication = parsed.data;
  } catch (err) {
    errors.push(`published.json: ${(err as Error).message}`);
    return { loaded_at: Date.now(), view: { ...empty, publication: { ...empty.publication, state: "invalid" } }, byRun };
  }
  const days = Object.entries(publication.days).sort((a, b) => a[0].localeCompare(b[0])) as [string, string][];
  const latest = publication.latest_run_id ? readSnapshot(publication.latest_run_id, errors) : null;
  if (latest) byRun.set(latest.run_id, latest);
  let previous: MarketSnapshot | null = null;
  if (latest) {
    const earlier = days.filter(([date]) => date < latest.observed_at);
    const prevRun = earlier[earlier.length - 1]?.[1];
    if (prevRun) {
      previous = readSnapshot(prevRun, errors);
      if (previous) byRun.set(previous.run_id, previous);
    }
  }
  const view: MarketView = {
    latest,
    previous,
    days,
    publication: {
      state: latest ? "published" : "invalid",
      published_at: publication.published_at,
      last_failure: publication.last_failure,
      errors,
    },
  };
  return { loaded_at: Date.now(), view, byRun };
}

function cache(): Cache {
  const g = globalThis as unknown as Record<string, Cache | undefined>;
  const c = g[CACHE_KEY];
  if (c && Date.now() - c.loaded_at < 60_000) return c;
  const fresh = load();
  g[CACHE_KEY] = fresh;
  return fresh;
}

export function marketView(): MarketView {
  return cache().view;
}

/** A published run by id (for history pages); loads lazily and caches. */
export function snapshotForRun(runId: string): MarketSnapshot | null {
  const c = cache();
  const hit = c.byRun.get(runId);
  if (hit) return hit;
  const loaded = readSnapshot(runId, c.view.publication.errors);
  if (loaded) c.byRun.set(runId, loaded);
  return loaded;
}

/** Every published day's snapshot, oldest first. Bounded by `limit` days so a long history is never scanned whole. */
export function snapshotHistory(limit = 60): MarketSnapshot[] {
  const view = marketView();
  return view.days
    .slice(-limit)
    .map(([, runId]) => snapshotForRun(runId))
    .filter((s): s is MarketSnapshot => Boolean(s));
}

/** Test hook: forget the cache. */
export function resetMarketCache(): void {
  delete (globalThis as unknown as Record<string, unknown>)[CACHE_KEY];
}
