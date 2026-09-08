// Shared helpers for the market-research collectors (scripts/research/*).
//
// Both ReelShort and DramaBox serve their public catalog as Next.js pages
// with the page props embedded in <script id="__NEXT_DATA__">. We fetch the
// HTML like a browser, parse that JSON, and keep only the fields Studio
// uses: never play tokens, never per-user data. Politeness: one request at
// a time, a fixed pause between requests, a small retry budget, a timeout.
//
// Artifacts are per run and immutable: every collector writes into
// data/research/runs/<RUN_ID>/<platform>.json. RUN_ID is the UTC start time
// (2026-09-07T04-38-53Z); the orchestrator (npm run research:crawl) sets it
// so both collectors and the builder share one run. A collector never
// overwrites an earlier run.

import fs from "node:fs";
import path from "node:path";

export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 PulsarStudioResearch/0.2";

const PAUSE_MS = Number(process.env.RESEARCH_PAUSE_MS ?? 700);
const TIMEOUT_MS = Number(process.env.RESEARCH_TIMEOUT_MS ?? 20000);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function runId() {
  if (process.env.RESEARCH_RUN_ID) return process.env.RESEARCH_RUN_ID;
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
}

export function runDir(id = runId()) {
  const dir = path.join(process.cwd(), "data", "research", "runs", id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function fetchHtml(url, attempt = 1) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html,*/*" }, redirect: "follow", signal: ctrl.signal });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    if (attempt >= 3) throw err;
    await sleep(PAUSE_MS * attempt * 2);
    return fetchHtml(url, attempt + 1);
  } finally {
    clearTimeout(timer);
    await sleep(PAUSE_MS);
  }
}

export function nextData(html) {
  if (!html) return null;
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

export async function fetchPageProps(url) {
  const html = await fetchHtml(url);
  const data = nextData(html);
  return data?.props?.pageProps ?? null;
}

/** Write a collector artifact into the current run. Refuses to overwrite. */
export function writeArtifact(platform, payload) {
  const file = path.join(runDir(), `${platform}.json`);
  if (fs.existsSync(file)) throw new Error(`${file} exists; a run is immutable (start a new RESEARCH_RUN_ID)`);
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 1)}\n`);
  return file;
}

/** Record a collector failure in the run so the builder can mark the platform failed, not missing. */
export function writeFailure(platform, error) {
  const file = path.join(runDir(), `${platform}.failed.json`);
  fs.writeFileSync(file, `${JSON.stringify({ platform, failed_at: new Date().toISOString(), error: String(error?.message ?? error) }, null, 1)}\n`);
  return file;
}

export const nowIso = () => new Date().toISOString();

export function log(...args) {
  console.error(`[research ${new Date().toISOString().slice(11, 19)}]`, ...args);
}
