import type { LaunchConnection } from "./types";

export type AccountScan = { connection_id: string; accountId: string; campaigns?: number; active?: number; traffic?: number; reach?: number; sales?: number; leadgen?: number; geoCountries?: number | null; error?: string; demo?: boolean };
export type AccountFilter = "all" | "never" | "active" | "inactive" | "warmed" | "unwarmed" | "full" | "limited" | "sales" | "nosales" | "leadgen" | "noleadgen";
export const accountFilterDefs: { id: AccountFilter; label: string; match: (s: AccountScan, full: number) => boolean; tiktok?: boolean }[] = [
  { id: "all", label: "All", match: () => true },
  { id: "never", label: "Never launched", match: s => s.campaigns === 0 },
  { id: "active", label: "Has active", match: s => (s.active ?? 0) > 0 },
  { id: "inactive", label: "Nothing active", match: s => s.active === 0 },
  { id: "warmed", label: "Warmed", match: s => (s.reach ?? 0) > 0, tiktok: true },
  { id: "unwarmed", label: "Never warmed", match: s => s.reach === 0, tiktok: true },
  { id: "full", label: "Full geo", match: (s, full) => !!full && (s.geoCountries ?? 0) >= full, tiktok: true },
  { id: "limited", label: "Limited geo", match: (s, full) => !!full && (s.geoCountries ?? 0) > 0 && (s.geoCountries ?? 0) < full, tiktok: true },
  { id: "sales", label: "Has Sales", match: s => (s.sales ?? 0) > 0, tiktok: true },
  { id: "nosales", label: "No Sales", match: s => s.sales === 0, tiktok: true },
  { id: "leadgen", label: "Has Leadgen", match: s => (s.leadgen ?? 0) > 0, tiktok: true },
  { id: "noleadgen", label: "No Leadgen", match: s => s.leadgen === 0, tiktok: true },
];
export function accountMatches(filter: AccountFilter, scan: AccountScan | undefined, full: number): boolean {
  if (filter === "all") return true;
  if (!scan || scan.error) return false;
  return accountFilterDefs.find(f => f.id === filter)!.match(scan, full);
}
export function accountFilterCounts(connections: LaunchConnection[], scans: Record<string, AccountScan>, full: number) {
  return Object.fromEntries(accountFilterDefs.map(f => [f.id, connections.filter(c => accountMatches(f.id, scans[c.id], full)).length])) as Record<AccountFilter, number>;
}
