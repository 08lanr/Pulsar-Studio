// Backfill or re-send Crazy Drama's ad spend from the command line (decision 2026-10-29, "The ad-spend sync"):
// TikTok's and Meta's spend per ad per day over a window, read with Studio's own credentials (GETs only), sent to
// crazydramas' PUT /api/studio/ad-spend through lib/crazydramas/spend-sync.ts, the scheduler's own path. Re-sending a
// window is safe: crazydramas replaces each (platform, day, ad) it already holds.
//
//   DATA_SOURCE=supabase TIKTOK_MODE=production node --import tsx scripts/ad-spend-sync.ts --from 2026-10-01 --to 2026-10-28 [--platform tiktok|meta] [--dry-run]
//   (npm run ad:spend -- --from … --to … with the same environment)
//
// --dry-run reads the providers and prints, per platform and per day, the spend, rows and ads, plus the accounts
// skipped (not USD) or failed; it sends NOTHING and needs no CRAZYDRAMAS_SPEND_SYNC. Without it the send needs
// DATA_SOURCE=supabase and CRAZYDRAMAS_SPEND_SYNC=enabled (and CRAZYDRAMAS_STUDIO_TOKEN), checked before any read.
import fs from "node:fs";
import path from "node:path";

function loadEnvLocal() {
  const p = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
}
const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const USAGE = "usage: --from YYYY-MM-DD --to YYYY-MM-DD [--platform tiktok|meta] [--dry-run]";

async function main() {
  const from = arg("--from"); const to = arg("--to"); const platform = arg("--platform");
  const dryRun = process.argv.includes("--dry-run");
  if (!from || !to || (platform !== undefined && platform !== "tiktok" && platform !== "meta")) { console.error(USAGE); process.exit(2); }
  loadEnvLocal();
  const { syncAdSpend, syncSummary } = await import("@/lib/crazydramas/spend-sync");
  const { dollars, spendByDay, windowProblem } = await import("@/lib/crazydramas/spend-rows");
  const problem = windowProblem(from, to);
  if (problem) { console.error(`${problem}\n${USAGE}`); process.exit(2); }
  console.log(`data source: ${process.env.DATA_SOURCE ?? "fixture"}, TikTok mode: ${process.env.TIKTOK_MODE ?? "(unset)"}, ${dryRun ? "dry run (nothing is sent)" : "sending to crazydramas"}`);

  const result = await syncAdSpend({ from, to, dryRun, platforms: platform ? [platform as "tiktok" | "meta"] : undefined });
  if (result.refused) { console.error(`Nothing read or sent: ${result.refused}`); process.exit(1); }
  for (const p of result.platforms) {
    const spent = p.rows.reduce((n, r) => n + r.spend_cents, 0);
    const days = spendByDay(p.rows);
    console.log(`\n${p.platform.toUpperCase()}  ${p.from}..${p.to}  ${dollars(spent)}  ${p.rows.length} rows  ${days.length} days  ${new Set(p.rows.map((r) => r.ad_id)).size} ads  ${new Set(p.rows.map((r) => r.campaign_id)).size} campaigns`);
    console.log(`  accounts read: ${p.accounts.join(", ") || "none"}`);
    for (const s of p.skipped) console.log(`  skipped ${s.account}: ${s.reason}`);
    for (const f of p.failed) console.log(`  failed  ${f.account}: ${f.reason}`);
    if (p.excluded.campaigns.length) console.log(`  left out (no crazydramas.com link, not a Studio launch): ${p.excluded.campaigns.length} campaigns, ${dollars(p.excluded.spend_cents)} — ${p.excluded.campaigns.join(", ")}`);
    for (const d of days) console.log(`  ${d.day}  ${dollars(d.spend_cents).padStart(11)}  ${String(d.rows).padStart(4)} rows  ${String(d.ads).padStart(4)} ads`);
  }
  console.log(`\n${syncSummary(result)}`);
  if (result.platforms.some((p) => p.outcome === "failed")) process.exit(1);
}

main().catch((e) => { console.error((e as Error).message); process.exit(1); });
