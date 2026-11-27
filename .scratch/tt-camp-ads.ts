// Read-only: every ad group and ad under the iPhone lander campaign, and the five unknown ad ids seen on landings.
import fs from "node:fs";
for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}
async function main() {
  const { tiktokTransport, accessTokenFor } = await import("@/lib/tiktok");
  const tt = tiktokTransport(); const adv = "7686288484534599696"; const token = accessTokenFor(adv)!;
  const g = await tt.get("/adgroup/get/", token, { advertiser_id: adv, filtering: JSON.stringify({ campaign_ids: ["1880451603632306"] }) });
  for (const a of (g.data?.list ?? []) as Record<string, unknown>[]) console.log("ADGROUP", a.adgroup_id, a.adgroup_name, a.secondary_status);
  const unknown = ["1880463103249458", "1880463103548498", "1880463102378161", "1880463103421041", "1880463103395873"];
  const u = await tt.get("/ad/get/", token, { advertiser_id: adv, filtering: JSON.stringify({ ad_ids: unknown }) });
  console.log("unknown ids found:", (u.data?.list ?? []).length, u.code, u.message);
  for (const d of (u.data?.list ?? []) as Record<string, unknown>[]) console.log("AD", d.ad_id, d.campaign_name, d.adgroup_id, d.video_id, d.secondary_status, String(d.ad_name).slice(0, 80));
  const rep = await tt.get("/report/integrated/get/", token, { advertiser_id: adv, report_type: "BASIC", data_level: "AUCTION_AD", dimensions: JSON.stringify(["ad_id"]), metrics: JSON.stringify(["spend", "impressions", "campaign_id", "adgroup_id", "ad_name"]), start_date: "2026-10-30", end_date: "2026-10-30", filtering: JSON.stringify([{ field_name: "ad_ids", filter_type: "IN", filter_value: JSON.stringify(unknown) }]), page_size: 100 });
  for (const r of (rep.data?.list ?? []) as { dimensions: Record<string, string>; metrics: Record<string, string> }[]) console.log("REP", r.dimensions.ad_id, JSON.stringify(r.metrics).slice(0, 300));
}
main().catch((e) => { console.error("error:", (e as Error).message); process.exit(1); });
