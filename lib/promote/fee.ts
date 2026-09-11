// Pulsar's service fee on ad spend (founder decision 2026-09-10): shown wherever a
// budget is proposed or approved so the producer sees ad spend, fee and the total
// billed. The fee never reaches TikTok: the ad group's budget stays exactly the
// approved ad spend (lib/tiktok/launch.ts); the fee is Pulsar's own invoice line.

export const PULSAR_SERVICE_FEE_RATE = 0.15;

export function serviceFeeUsd(adSpendUsd: number): number {
  return Math.round(adSpendUsd * PULSAR_SERVICE_FEE_RATE * 100) / 100;
}

export function billedTotalUsd(adSpendUsd: number): number {
  return Math.round((adSpendUsd + serviceFeeUsd(adSpendUsd)) * 100) / 100;
}

/** Interpolation values for the fee line, with whole dollars when the amounts are whole. */
export function feeLineVars(adSpendUsd: number): { budget: string; fee: string; total: string; pct: number } {
  const money = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
  return { budget: money(adSpendUsd), fee: money(serviceFeeUsd(adSpendUsd)), total: money(billedTotalUsd(adSpendUsd)), pct: Math.round(PULSAR_SERVICE_FEE_RATE * 100) };
}
