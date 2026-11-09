// The AdMob connection (decision 2026-11-09, "Ad unlocks in Studio"): the one Google refresh token a staff member
// obtained with "Connect AdMob", kept as one small JSON file in Studio's own storage (the private studio-media
// bucket in live mode, .uploads/ in fixture mode), as the stats team list is (lib/crazydramas/stats-team.ts), so
// Andrew's Studio on the same database sees the same connection. Server-only.
//
// The token is read in exactly one function (`readAdmobRefreshToken`) and handed only to ./oauth.ts; it is never
// logged, rendered, returned by a route or put in an error. Screens learn who connected and when, nothing else.

import { z } from "zod";
import { putStoredBytes, readStoredBytes } from "@/lib/data/storage";

export const ADMOB_FILE = "settings/admob-oauth.json";

const ConnectionFile = z.object({
  refresh_token: z.string().min(1).nullable(),
  connected_at: z.string().nullable().optional(),
  connected_by: z.string().nullable().optional(),
});

/** What a screen may know about the connection. */
export type AdmobConnection = { connected: boolean; connected_at: string | null; connected_by: string | null };

async function readFile(): Promise<z.infer<typeof ConnectionFile> | null> {
  if (typeof window !== "undefined") throw new Error("the AdMob connection is server-only.");
  try {
    const parsed = ConnectionFile.safeParse(JSON.parse((await readStoredBytes(ADMOB_FILE)).toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Who connected AdMob and when; not connected when nothing was saved, it was disconnected, or the file cannot be read. */
export async function readAdmobConnection(): Promise<AdmobConnection> {
  const f = await readFile();
  if (!f?.refresh_token) return { connected: false, connected_at: null, connected_by: null };
  return { connected: true, connected_at: f.connected_at ?? null, connected_by: f.connected_by ?? null };
}

/** The one read of the stored refresh token (./oauth.ts only). */
export async function readAdmobRefreshToken(): Promise<string | null> {
  return (await readFile())?.refresh_token ?? null;
}

/** Keeps a new refresh token (the OAuth callback), replacing any earlier one. */
export async function saveAdmobRefreshToken(refreshToken: string, by: string | null): Promise<void> {
  const file = { refresh_token: refreshToken, connected_at: new Date().toISOString(), connected_by: by };
  await putStoredBytes(ADMOB_FILE, new TextEncoder().encode(`${JSON.stringify(file, null, 2)}\n`), "application/json");
}

/** Forgets the token (Disconnect): the file stays, with no token in it. */
export async function clearAdmobRefreshToken(by: string | null): Promise<void> {
  const file = { refresh_token: null, connected_at: null, connected_by: null, disconnected_at: new Date().toISOString(), disconnected_by: by };
  await putStoredBytes(ADMOB_FILE, new TextEncoder().encode(`${JSON.stringify(file, null, 2)}\n`), "application/json");
}
