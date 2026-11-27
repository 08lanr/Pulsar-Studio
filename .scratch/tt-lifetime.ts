// Read-only: lifetime spend and schedule of the four recent campaigns' ad groups.
import fs from "node:fs";
for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}
async function main() {
  const { tiktokTransport, accessTokenFor } = await import("@/lib/tiktok");
  const tt = tiktokTransport();
  const adv = "7686288484534599696";
  const token = accessTokenFor(adv)!;
  const ids = ["1878618611510481", "1878611345096769", "1878919888577745", "1878920075227729"];
  const ags = await tt.get("/adgroup/get/", token, { advertiser_id: adv, page_size: 100, filtering: JSON.stringify({ adgroup_ids: ids }) });
  for (const g of (ags.data?.list ?? []) as Record<string, unknown>[]) console.log(`${g.adgroup_id} schedule=${g.schedule_type} ${g.schedule_start_time} -> ${g.schedule_end_time} budget=${g.budget} ${g.budget_mode} sec=${g.secondary_status}`);
  const rep = await tt.get("/report/integrated/get/", token, { advertiser_id: adv, report_type: "BASIC", data_level: "AUCTION_ADGROUP", dimensions: JSON.stringify(["adgroup_id"]), metrics: JSON.stringify(["spend"]), query_lifetime: "true", filtering: JSON.stringify([{ field_name: "adgroup_ids", filter_type: "IN", filter_value: JSON.stringify(ids) }]), page_size: 100 });
  if (rep.code !== 0) console.log("report:", rep.message);
  for (const r of (rep.data?.list ?? []) as { dimensions: Record<string, string>; metrics: Record<string, string> }[]) console.log(`lifetime ${r.dimensions.adgroup_id} spend=${r.metrics.spend}`);
}
main().catch((e) => { console.error("error:", (e as Error).message); process.exit(1); });
