// Read-only: the iPhone lander ad group's ads (creative, text, link) and their spend today and yesterday.
import fs from "node:fs";
for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}
async function main() {
  const { tiktokTransport, accessTokenFor } = await import("@/lib/tiktok");
  const tt = tiktokTransport(); const adv = "7686288484534599696"; const token = accessTokenFor(adv)!;
  const AG = "1880451603633474";
  const ads = await tt.get("/ad/get/", token, { advertiser_id: adv, filtering: JSON.stringify({ adgroup_ids: [AG] }) });
  for (const d of (ads.data?.list ?? []) as Record<string, unknown>[]) {
    const keys = Object.keys(d).filter((k) => /item|video|text|url|name|identity|status|creative/i.test(k));
    console.log("AD", d.ad_id, JSON.stringify(Object.fromEntries(keys.map((k) => [k, d[k]]))).slice(0, 700));
  }
  const g = await tt.get("/adgroup/get/", token, { advertiser_id: adv, filtering: JSON.stringify({ adgroup_ids: [AG] }) });
  const ag = (g.data?.list ?? [])[0] as Record<string, unknown>;
  console.log("ADGROUP", ag?.secondary_status, ag?.operation_status, ag?.budget_mode, ag?.budget);
  for (const level of ["AUCTION_AD", "AUCTION_ADGROUP"]) {
    const rep = await tt.get("/report/integrated/get/", token, { advertiser_id: adv, report_type: "BASIC", data_level: level, dimensions: JSON.stringify([level === "AUCTION_AD" ? "ad_id" : "adgroup_id", "stat_time_day"]), metrics: JSON.stringify(["spend", "impressions", "clicks", "conversion", "cpc", "ctr"]), start_date: "2026-10-29", end_date: "2026-10-30", filtering: JSON.stringify([{ field_name: "adgroup_ids", filter_type: "IN", filter_value: JSON.stringify([AG]) }]), page_size: 100 });
    if (rep.code !== 0) console.log(level, "report:", rep.message);
    for (const r of (rep.data?.list ?? []) as { dimensions: Record<string, string>; metrics: Record<string, string> }[]) console.log(level, JSON.stringify(r.dimensions), JSON.stringify(r.metrics));
  }
}
main().catch((e) => { console.error("error:", (e as Error).message); process.exit(1); });
