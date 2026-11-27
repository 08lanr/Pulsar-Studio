// Read-only: status and today's spend of the three TikTok ad groups in the split.
import fs from "node:fs";
for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}
async function main() {
  const { tiktokTransport, accessTokenFor } = await import("@/lib/tiktok");
  const tt = tiktokTransport(); const adv = "7686288484534599696"; const token = accessTokenFor(adv)!;
  const ids = ["1880451603633474", "1878611345096769", "1878618611510481"];
  const g = await tt.get("/adgroup/get/", token, { advertiser_id: adv, filtering: JSON.stringify({ adgroup_ids: ids }) });
  for (const a of (g.data?.list ?? []) as Record<string, unknown>[]) console.log(a.adgroup_id, a.budget_mode, a.budget, a.secondary_status);
  const rep = await tt.get("/report/integrated/get/", token, { advertiser_id: adv, report_type: "BASIC", data_level: "AUCTION_ADGROUP", dimensions: JSON.stringify(["adgroup_id", "stat_time_day"]), metrics: JSON.stringify(["spend", "impressions", "clicks", "conversion"]), start_date: "2026-10-29", end_date: "2026-10-30", filtering: JSON.stringify([{ field_name: "adgroup_ids", filter_type: "IN", filter_value: JSON.stringify(ids) }]), page_size: 100 });
  if (rep.code !== 0) console.log("report:", rep.message);
  for (const r of (rep.data?.list ?? []) as { dimensions: Record<string, string>; metrics: Record<string, string> }[]) console.log(r.dimensions.stat_time_day?.slice(0, 10), r.dimensions.adgroup_id, "spend", r.metrics.spend, "imp", r.metrics.impressions, "clicks", r.metrics.clicks, "conv", r.metrics.conversion);
}
main().catch((e) => { console.error("error:", (e as Error).message); process.exit(1); });
