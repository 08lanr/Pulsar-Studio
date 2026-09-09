// Which TikTok the app talks to (decision 2026-09-09, "TikTok launch").
//
//   fixture mode   the fake transport, always: the in-memory store forgets a
//                  launch on restart, and a forgotten launch is a duplicate
//                  launch waiting to happen — so real objects are only ever
//                  created against persistent storage (DATA_SOURCE=supabase).
//                  One exception for engineers: TIKTOK_LIVE=1 with
//                  TIKTOK_MODE=sandbox reaches the sandbox from fixture mode
//                  (fake money). Production is refused in fixture mode.
//   supabase mode  the live transport; TIKTOK_MODE picks sandbox (default)
//                  or production.
//
// Every caller asks here; nothing imports transport.ts or fake.ts for a
// transport directly.

import { dataSource } from "@/lib/data-source";
import { fakeTransport } from "./fake";
import { liveTransport, tiktokMode, type TikTokTransport } from "./transport";
import { loadToken, tokenForAdvertiser } from "./tokens";

export type LaunchMode = "fake" | "sandbox" | "production";

export function launchMode(): LaunchMode {
  if (dataSource() === "fixture") {
    return process.env.TIKTOK_LIVE === "1" && tiktokMode() === "sandbox" ? "sandbox" : "fake";
  }
  return tiktokMode();
}

export function tiktokTransport(): TikTokTransport {
  return launchMode() === "fake" ? fakeTransport : liveTransport;
}

/** True when a launch could actually go somewhere: the fake always can; live needs a token. */
export function tiktokConnected(): boolean {
  return launchMode() === "fake" || loadToken() !== null;
}

/** The access token to use for an advertiser; the fake ignores it. */
export function accessTokenFor(advertiserId: string): string | null {
  if (launchMode() === "fake") return "fake-token";
  return tokenForAdvertiser(advertiserId)?.access_token ?? null;
}

export { tiktokMode } from "./transport";
export type { TikTokResponse, TikTokTransport } from "./transport";
