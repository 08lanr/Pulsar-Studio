// Build and publish one run: the file side of lib/research/build.ts.
//
//   data/research/runs/<RUN_ID>/{reelshort,dramabox}.json        collector artifacts (immutable)
//   data/research/runs/<RUN_ID>/<platform>.failed.json            a collector's recorded failure
//   data/research/runs/<RUN_ID>/manifest.json                     what the builder decided
//   data/research/snapshots/<RUN_ID>.json                         the normalized snapshot (immutable)
//   data/research/published.json                                  pointer; written ONLY after validation
//
// - Re-running on an existing run id needs --force (a taxonomy change on the
//   same artifacts); the manifest records builder and taxonomy versions.
// - Publication is atomic: temp file + rename, then the pointer. A run that
//   fails validation is recorded in published.json.last_failure and replaces
//   nothing. The latest validated run of a day represents that day; earlier
//   same-day runs stay on disk, unpublished.
//
// Usage: RESEARCH_RUN_ID=<id> npx tsx scripts/research/build-snapshot.ts [--force]

import fs from "node:fs";
import path from "node:path";
import { buildSnapshot, type RawArtifact, type RawFailure } from "@/lib/research/build";
import { marketSnapshotSchema, publicationSchema, type MarketSnapshot, type Platform, type Publication } from "@/lib/research/types";

const root = process.cwd();
const runsDir = path.join(root, "data", "research", "runs");
const snapshotsDir = path.join(root, "data", "research", "snapshots");
const publishedFile = path.join(root, "data", "research", "published.json");

function readJson<T>(file: string): T | null {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function loadPublication(): Publication | null {
  const raw = readJson<unknown>(publishedFile);
  if (!raw) return null;
  const parsed = publicationSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function loadSnapshot(runId: string): MarketSnapshot | null {
  const raw = readJson<unknown>(path.join(snapshotsDir, `${runId}.json`));
  if (!raw) return null;
  const parsed = marketSnapshotSchema.safeParse(raw);
  return parsed.success ? (parsed.data as MarketSnapshot) : null;
}

function writeAtomic(file: string, content: string) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function main() {
  const force = process.argv.includes("--force");
  const runId = process.env.RESEARCH_RUN_ID;
  if (!runId) throw new Error("RESEARCH_RUN_ID is required (the run whose artifacts to build)");
  const dir = path.join(runsDir, runId);
  if (!fs.existsSync(dir)) throw new Error(`no run directory ${dir}`);
  const snapshotFile = path.join(snapshotsDir, `${runId}.json`);
  if (fs.existsSync(snapshotFile) && !force) throw new Error(`${snapshotFile} exists; runs are immutable (pass --force to rebuild from the same artifacts)`);

  const publication = loadPublication();
  const previous = publication?.latest_run_id ? loadSnapshot(publication.latest_run_id) : null;
  const artifacts: Partial<Record<Platform, RawArtifact | null>> = {};
  const failures: Partial<Record<Platform, RawFailure | null>> = {};
  for (const platform of ["reelshort", "dramabox"] as Platform[]) {
    artifacts[platform] = readJson<RawArtifact>(path.join(dir, `${platform}.json`));
    failures[platform] = readJson<RawFailure>(path.join(dir, `${platform}.failed.json`));
  }
  const result = buildSnapshot({ runId, artifacts, failures, previous });
  fs.writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify(result.manifest, null, 2)}\n`);

  if (result.errors.length > 0) {
    const pub: Publication = publication ?? { latest_run_id: "", published_at: new Date(0).toISOString(), days: {}, last_failure: null };
    pub.last_failure = { run_id: runId, at: new Date().toISOString(), errors: result.errors };
    writeAtomic(publishedFile, `${JSON.stringify(pub, null, 2)}\n`);
    console.error(`[build-snapshot] run ${runId} FAILED validation; nothing published:\n  ${result.errors.join("\n  ")}`);
    process.exit(2);
  }

  fs.mkdirSync(snapshotsDir, { recursive: true });
  writeAtomic(snapshotFile, `${JSON.stringify(result.snapshot)}\n`);
  const pub: Publication = publication ?? { latest_run_id: runId, published_at: new Date().toISOString(), days: {}, last_failure: null };
  pub.latest_run_id = runId;
  pub.published_at = new Date().toISOString();
  pub.days[result.snapshot.observed_at] = runId;
  pub.last_failure = null;
  writeAtomic(publishedFile, `${JSON.stringify(pub, null, 2)}\n`);
  const s = result.snapshot;
  console.error(
    `[build-snapshot] published ${runId} (${s.observed_at}): ${s.titles.length} listings, ${s.titles.filter((t) => t.tropes.length > 0).length} tagged; ` +
      s.platforms.map((p) => `${p.id}=${p.status}:${p.title_count}`).join(" ")
  );
}

main();
