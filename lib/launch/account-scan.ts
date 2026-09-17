import type { Session } from "@/lib/auth";
import { getData } from "@/lib/data";
import { dataSource } from "@/lib/data-source";
import { invalid, notFound } from "@/lib/data/errors";
import { fingerprintAccount, FULL_COUNTRY_COUNT } from "@/lib/tiktok/fingerprint";
import { metaTransport } from "@/lib/meta";
import { metaList } from "@/lib/meta/transport";

export async function scanLaunchAccounts(s: Session, producerId: string | undefined, ids: string[], force = false) {
  if (s.kind === "producer" && producerId && producerId !== s.producerId) throw notFound("Company");
  const data = getData(), workspace = await data.getLaunchWorkspace(s, producerId);
  if (!ids.length || ids.length > 30 || ids.some(id => !workspace.connections.some(c => c.id === id && c.enabled))) throw invalid("Scan up to 30 assigned accounts from this company.");
  const results = [];
  for (const id of ids) {
    const c = workspace.connections.find(c => c.id === id)!;
    try {
      if (dataSource() === "fixture") {
        const rows = workspace.runs.flatMap(r => r.campaigns).filter(row => row.connection_id === id);
        results.push({ connection_id: id, accountId: c.advertiser_id, campaigns: rows.length, active: rows.filter(r => r.snapshot?.configured_status && ["ENABLE", "ACTIVE"].includes(r.snapshot.configured_status)).length, traffic: rows.length, geoCountries: c.provider === "tiktok" ? FULL_COUNTRY_COUNT : null, scannedAt: new Date().toISOString(), demo: true });
      } else if (c.provider === "tiktok") results.push({ connection_id: id, ...await fingerprintAccount(c.advertiser_id, { force }) });
      else {
        const rows = await metaList(metaTransport(), `${c.advertiser_id}/campaigns`, { fields: "id,status,objective" });
        results.push({ connection_id: id, accountId: c.advertiser_id, campaigns: rows.filter(r => !["DELETED", "ARCHIVED"].includes(String(r.status))).length, active: rows.filter(r => r.status === "ACTIVE").length, traffic: rows.filter(r => r.objective === "OUTCOME_TRAFFIC").length, geoCountries: null, scannedAt: new Date().toISOString() });
      }
    } catch { results.push({ connection_id: id, accountId: c.advertiser_id, error: "Account scan unavailable; usage is unknown.", scannedAt: new Date().toISOString() }); }
  }
  return { results, fullCountryCount: FULL_COUNTRY_COUNT };
}
