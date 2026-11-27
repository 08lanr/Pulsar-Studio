// Read-only: the campaigns created tonight, their ad groups and ads.
import fs from "node:fs";
for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}
async function main() {
  const { tiktokTransport, accessTokenFor } = await import("@/lib/tiktok");
  const tt = tiktokTransport(); const adv = "7686288484534599696"; const token = accessTokenFor(adv)!;
  const c = await tt.get("/campaign/get/", token, { advertiser_id: adv, page_size: 100, filtering: JSON.stringify({ campaign_name: "route-b-lander-ios" }) });
  for (const x of (c.data?.list ?? []) as Record<string, unknown>[]) {
    console.log("CAMPAIGN", x.campaign_id, x.campaign_name, x.objective_type, x.operation_status, x.secondary_status, "campaign_type=" + (x.campaign_type ?? ""));
    const g = await tt.get("/adgroup/get/", token, { advertiser_id: adv, filtering: JSON.stringify({ campaign_ids: [String(x.campaign_id)] }) });
    for (const a of (g.data?.list ?? []) as Record<string, unknown>[]) console.log("  ADGROUP", a.adgroup_id, a.budget_mode, a.budget, a.schedule_type, a.schedule_start_time, "os=" + JSON.stringify(a.operating_systems), "min_ios=" + (a.min_ios_version ?? ""), "goal=" + a.optimization_goal, "event=" + a.optimization_event, "loc=" + JSON.stringify(a.location_ids), "ages=" + JSON.stringify(a.age_groups), a.secondary_status);
    const ads = await tt.get("/ad/get/", token, { advertiser_id: adv, filtering: JSON.stringify({ campaign_ids: [String(x.campaign_id)] }) });
    for (const d of (ads.data?.list ?? []) as Record<string, unknown>[]) console.log("  AD", d.ad_id, "item=" + d.tiktok_item_id, String(d.landing_page_url ?? ""), d.secondary_status);
  }
}
main().catch((e) => { console.error("error:", (e as Error).message); process.exit(1); });
