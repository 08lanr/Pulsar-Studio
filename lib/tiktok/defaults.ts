// The operator's TikTok launch account (decision 2026-09-23, "TikTok launch:
// crazydramas link contract + pixel + one account"). Server-only: read from
// .env.local per call. The pixel code, the other launch default, is
// lib/tiktok/pixel.ts tiktokPixelCode().

/**
 * TIKTOK_DEFAULT_ADVERTISER_ID: the one ad account launches start on for now.
 * It only preselects: a company launches on it when its own staff-assigned
 * Business Center (or single-account assignment) reaches it, never otherwise.
 * TIKTOK_ADVERTISER_ID is something else (the sandbox token's account).
 */
export function tiktokDefaultAdvertiserId(): string | null {
  const value = process.env.TIKTOK_DEFAULT_ADVERTISER_ID?.trim() ?? "";
  return /^\d{5,30}$/.test(value) ? value : null;
}
