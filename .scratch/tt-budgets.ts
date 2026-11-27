// Read-only: list the Crazy Drama TikTok account's campaigns and ad groups with status and budgets.
import fs from "node:fs";
for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}
async function main() {
  const { tiktokTransport, accessTokenFor } = await import("@/lib/tiktok");
  const tt = tiktokTransport();
  const adv = "7686288484534599696";
  const token = accessTokenFor(adv);
  if (!token) throw new Error("no token");
  const camps = await tt.get("/campaign/get/", token, { advertiser_id: adv, page_size: 100 });
  if (camps.code !== 0) throw new Error(camps.message);
  console.log("campaigns:", (camps.data?.list ?? []).length, "mode:", tt.mode, "data keys:", Object.keys(camps.data ?? {}), JSON.stringify(camps.data?.page_info ?? null));
  for (const c of (camps.data?.list ?? []) as Record<string, unknown>[]) {
    console.log(`CAMPAIGN ${c.campaign_id} "${c.campaign_name}" objective=${c.objective_type} budget_mode=${c.budget_mode} budget=${c.budget} op=${c.operation_status} sec=${c.secondary_status} app_promo=${c.app_promotion_type ?? ""} cbo=${c.budget_optimize_on ?? ""}`);
  }
  const ags = await tt.get("/adgroup/get/", token, { advertiser_id: adv, page_size: 100 });
  if (ags.code !== 0) throw new Error(ags.message);
  for (const g of (ags.data?.list ?? []) as Record<string, unknown>[]) {
    console.log(`  ADGROUP ${g.adgroup_id} camp=${g.campaign_id} "${g.adgroup_name}" budget_mode=${g.budget_mode} budget=${g.budget} goal=${g.optimization_goal} event=${g.optimization_event ?? ""} os=${JSON.stringify(g.operating_systems ?? [])} placement=${JSON.stringify(g.placements ?? [])} bid=${g.bid_type} op=${g.operation_status} sec=${g.secondary_status}`);
  }
}
main().catch((e) => { console.error("error:", (e as Error).message); process.exit(1); });
