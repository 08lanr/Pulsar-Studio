// Save and preview a TikTok launch DRAFT from the command line (2026-10-07). Nothing is approved and nothing
// spends: the draft appears on the Launch page like one made there, and the approver signs it in Studio.
// It writes as the system actor, like scripts/upload-ad.ts, so a set of ads chosen in a chat reaches the Launch
// page as a ready draft without a browser session. The same saveLaunchDraft -> previewLaunchRun path as the page.
//
//   DATA_SOURCE=supabase TIKTOK_MODE=production node --import tsx scripts/launch-draft-from-cli.ts --spec set.json
//
// spec.json: { "name": "Winners A · Oct 7", "clips": ["<clip uuid or prefix>", ...], "total_budget_usd": 100,
//              "duration_days": 4, "age_groups": ["AGE_13_17", ...] (optional: default 18+),
//              "comments_disabled": true, "producer_id": "<uuid>", "account_id": "tiktok:<producer>:<advertiser>" }
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

async function main() {
  const i = process.argv.indexOf("--spec");
  if (i < 0 || !process.argv[i + 1]) { console.error("usage: --spec set.json"); process.exit(2); }
  loadEnvLocal();
  const { getData } = await import("@/lib/data");
  const { systemSession } = await import("@/lib/auth");
  const { tiktokAdText } = await import("@/lib/launch/plan");
  const { defaultTikTokLaunchSettings } = await import("@/lib/tiktok/settings");
  const { withUserSupabase, createServiceSupabase } = await import("@/lib/supabase/server");
  const data = getData(); const session = systemSession();
  console.log(`data source: ${process.env.DATA_SOURCE ?? "fixture"}, TikTok mode: ${process.env.TIKTOK_MODE ?? "(unset)"}`);
  const spec = JSON.parse(fs.readFileSync(process.argv[i + 1], "utf8"));
  // The launch data layer reads the clip library and connections through the request's cookie client; a script has
  // no request, so the service client is bound for this call (the system session is Pulsar staff, as in upload-ad.ts).
  await withUserSupabase(createServiceSupabase(), async () => {
  const producerId: string = spec.producer_id; const accountId: string = spec.account_id;

  const ws = await data.getLaunchWorkspace(session, producerId);
  const library = (ws.library ?? []) as Record<string, unknown>[];
  if (library.length) console.log(`library: ${library.length} clips; row keys: ${Object.keys(library[0]).join(",")}`);
  const content = [];
  for (const want of spec.clips as string[]) {
    const rows = library.filter(r => String(r.id).startsWith(want) || String(r.value ?? "").startsWith(want));
    if (rows.length !== 1) throw new Error(`clip ${want}: ${rows.length} library matches`);
    const r = rows[0];
    const text = tiktokAdText({ text: (r.text as string) ?? (r.hook_en as string) ?? (r.hook as string) ?? "", headline: (r.headline as string) ?? (r.title_name as string) ?? "" });
    content.push({ kind: "video" as const, value: String(r.value ?? r.id), label: `${r.title_name ?? ""} · ${r.label ?? text}`.slice(0, 200),
      creative_id: String(r.creative_id ?? r.id), clip_id: String(r.id), title_id: r.title_id as string | undefined, text, headline: (r.headline as string) ?? (r.title_name as string) ?? undefined });
    console.log(`  clip ${String(r.id).slice(0, 8)}  ${String(r.title_name ?? "").slice(0, 40).padEnd(40)}  "${text}"`);
  }
  const settings = { ...defaultTikTokLaunchSettings(), duration_days: spec.duration_days ?? 4, comments_disabled: spec.comments_disabled ?? true,
    ...(spec.age_groups ? { age_groups: spec.age_groups } : {}) };
  const start = new Date(); const end = new Date(start.getTime() + (spec.duration_days ?? 4) * 86400e3);
  const draft = {
    provider: "tiktok" as const, name: spec.name, account_ids: [accountId], campaigns_per_account: 1, content_per_campaign: content.length,
    allocation: "unique" as const, content, destination_url: "", total_budget_cents: Math.round(spec.total_budget_usd * 100), daily_budget_cents: null,
    start_paused: false, tiktok_settings: settings,
    meta_settings: { countries: ["US"], placements: ["facebook"], objective: "OUTCOME_TRAFFIC", optimization_goal: "LINK_CLICKS", conversion_event: null, pixel_id: null,
      bid_strategy: "LOWEST_COST_WITHOUT_CAP", bid_cents: null, call_to_action: "LEARN_MORE", start_time: start.toISOString(), end_time: end.toISOString() },
    campid_start: null, title_id: null,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const run = await data.saveLaunchDraft(session, draft as any, { producerId });
  console.log(`draft saved: ${run.id} (${run.external_id}) "${run.draft.name}" $${(run.draft.total_budget_cents / 100).toFixed(0)} total, ${run.draft.content.length} ads, ages ${settings.age_groups.join("/")}, profile posts ${settings.profile_posts}`);

  const plan = await data.previewLaunchRun(session, run.id);
  console.log(`preview: ${plan.campaign_count} campaign(s), ${plan.content_count} ads, $${(plan.total_budget_cents / 100).toFixed(0)}; pixel ${plan.tiktok_pixel?.code ?? "-"} event ${plan.tiktok_pixel?.event ?? "-"}`);
  const ident = plan.tiktok_identity;
  if (ident) console.log(`identity: ${ident.clips} clips, profile=${ident.profile ?? false}; accounts ${ident.accounts.map(a => `${a.handle} (ads_only=${a.ads_only})`).join(", ")}`);
  for (const w of plan.warnings ?? []) console.log(`  warning: ${w}`);
  for (const row of plan.rows) console.log(`  row ${row.index}: ${row.name} $${(row.budget_cents / 100).toFixed(0)} ads=${row.content.length} ${row.content.map(c => `${(c.clip_id ?? c.value).slice(0, 8)}→${(c.landing_url ?? "").replace("https://crazydramas.com/watch/", "").split("?")[0].slice(0, 30)}`).join(" | ")}`);
  console.log("draft only: approve it on the Launch page");
  });
}
main().catch(e => { console.error("error:", e instanceof Error ? e.message : e); process.exit(1); });
