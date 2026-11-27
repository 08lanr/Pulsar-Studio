// Read-only: the ad account's own budget and the campaigns' daily spend caps.
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
  const info = await tt.get("/advertiser/info/", token, { advertiser_ids: JSON.stringify([adv]), fields: JSON.stringify(["budget", "budget_mode", "currency", "timezone", "status"]) });
  console.log("advertiser:", info.code === 0 ? JSON.stringify(info.data?.list) : info.message);
  const c = await tt.get("/campaign/get/", token, { advertiser_id: adv, filtering: JSON.stringify({ campaign_ids: ["1878611340514610", "1878618615160274"] }) });
  for (const x of (c.data?.list ?? []) as Record<string, unknown>[]) console.log(x.campaign_id, "budget", x.budget, x.budget_mode, "spending_limit", JSON.stringify((x as Record<string, unknown>).campaign_spending_limit ?? null), "sec", x.secondary_status);
}
main().catch((e) => { console.error("error:", (e as Error).message); process.exit(1); });
