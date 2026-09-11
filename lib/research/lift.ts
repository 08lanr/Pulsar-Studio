// A "lift" (share of recent or prominent listings ÷ share of every listing) is shown as a
// signed percentage (founder decision 2026-09-10): 2.18× reads as "+118%", 0.76× as "-24%".
// The ratio stays in the data and the registry; only the display changes.

export function liftPct(lift: number): number {
  return Math.round((lift - 1) * 100);
}

export function fmtLift(lift: number): string {
  const pct = liftPct(lift);
  return `${pct > 0 ? "+" : ""}${pct}%`;
}
