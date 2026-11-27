// Read-only: the Flirt web ad group's ads with their creative and 14-day numbers; the ad group's targeting.
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
  const AG = "1878611345096769";
  const g = await tt.get("/adgroup/get/", token, { advertiser_id: adv, filtering: JSON.stringify({ adgroup_ids: [AG] }) });
  const ag = (g.data?.list ?? [])[0] as Record<string, unknown>;
  console.log("adgroup targeting:", JSON.stringify({ location_ids: ag.location_ids, age_groups: ag.age_groups, gender: ag.gender, languages: ag.languages, operating_systems: ag.operating_systems, pacing: ag.pacing, billing_event: ag.billing_event, optimization_event: ag.optimization_event, pixel_id: ag.pixel_id, identity_id: ag.identity_id, identity_type: ag.identity_type, interest_category_ids: ag.interest_category_ids, audience_ids: ag.audience_ids }));
  const a = await tt.get("/ad/get/", token, { advertiser_id: adv, page_size: 100, filtering: JSON.stringify({ adgroup_ids: [AG] }) });
  const ads = (a.data?.list ?? []) as Record<string, unknown>[];
  const rep = await tt.get("/report/integrated/get/", token, { advertiser_id: adv, report_type: "BASIC", data_level: "AUCTION_AD", dimensions: JSON.stringify(["ad_id"]), metrics: JSON.stringify(["spend", "impressions", "clicks", "ctr", "conversion"]), start_date: "2026-10-16", end_date: "2026-10-29", filtering: JSON.stringify([{ field_name: "adgroup_ids", filter_type: "IN", filter_value: JSON.stringify([AG]) }]), page_size: 100 });
  const m = new Map<string, Record<string, string>>();
  for (const r of (rep.data?.list ?? []) as { dimensions: Record<string, string>; metrics: Record<string, string> }[]) m.set(r.dimensions.ad_id, r.metrics);
  for (const ad of ads) {
    const k = String(ad.ad_id); const x = m.get(k) ?? {};
    console.log(`${k} url=${String(ad.landing_page_url ?? "").split("?")[0]} status=${ad.operation_status}/${ad.secondary_status} spark_item=${ad.tiktok_item_id ?? ""} video=${ad.video_id ?? ""} identity=${ad.identity_type ?? ""} cta=${ad.call_to_action ?? ""} spend=${x.spend ?? 0} imp=${x.impressions ?? 0} ctr=${x.ctr ?? ""} conv=${x.conversion ?? ""} name="${String(ad.ad_name ?? "").slice(0, 50)}"`);
  }
}
main().catch((e) => { console.error("error:", (e as Error).message); process.exit(1); });
