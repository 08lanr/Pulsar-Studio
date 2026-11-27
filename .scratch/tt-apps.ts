// Read-only: the apps registered to the ad account and whatever status TikTok reports for them.
import fs from "node:fs";
for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}
async function main() {
  const { tiktokTransport, accessTokenFor } = await import("@/lib/tiktok");
  const tt = tiktokTransport(); const adv = "7686288484534599696"; const token = accessTokenFor(adv)!;
  const r = await tt.get("/app/list/", token, { advertiser_id: adv });
  console.log("code", r.code, r.message);
  for (const a of ((r.data?.apps ?? r.data?.list ?? []) as Record<string, unknown>[])) console.log(JSON.stringify(a).slice(0, 600));
}
main().catch((e) => { console.error("error:", (e as Error).message); process.exit(1); });
