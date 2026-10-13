// Shared fixtures for the creator-account tests: an account, and media rows
// whose stored bytes really exist (fixture storage under .uploads/), so the
// publishing engine's hash re-verification runs for real.

import { createHash, randomBytes } from "node:crypto";
import { fixtureSession, type Session } from "@/lib/auth";
import { getData } from "@/lib/data";
import { putStoredBytes } from "@/lib/data/storage";
import type { CreatorAccount, CreatorMedia } from "@/lib/creators/types";
import { EMPTY_PERSONA } from "@/lib/creators/types";

export const admin = (): Session => fixtureSession("staff");
export const editor = (): Session => ({ ...fixtureSession("staff"), userId: "00000000-0000-4000-8000-0000000000e1", staffRole: "editor", displayName: "Editor" });
export const producer = (): Session => fixtureSession("producer");

/** A minimal JPEG header (SOI + SOF0) carrying a pixel size, plus random bytes so every call hashes differently. */
export function fakeJpeg(width: number, height: number): Buffer {
  const sof = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  return Buffer.concat([sof, randomBytes(64), Buffer.from([0xff, 0xd9])]);
}

let seq = 0;
export async function seedAccount(over: Partial<{ handle: string; instagram_id: string; page_id: string | null }> = {}): Promise<CreatorAccount> {
  seq += 1;
  const { account } = await getData().upsertCreatorAccount(admin(), {
    handle: over.handle ?? `test.creator${seq}`, display_name: "Test Creator", instagram_id: over.instagram_id ?? `1784140000000${1000 + seq}`,
    page_id: over.page_id ?? null,
    persona: { ...EMPTY_PERSONA, summary: "A test creator.", age: 25, city: "San Francisco", voice: "lowercase, warm" },
  });
  return account;
}

export async function addMedia(account: CreatorAccount, kind: "image" | "video" = "image", over: Partial<CreatorMedia> = {}): Promise<CreatorMedia> {
  const bytes = kind === "image" ? fakeJpeg(1080, 1350) : Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), randomBytes(256)]);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const path = `creators/${account.id}/${sha.slice(0, 16)}.${kind === "image" ? "jpg" : "mp4"}`;
  await putStoredBytes(path, bytes, kind === "image" ? "image/jpeg" : "video/mp4");
  const { media } = await getData().createCreatorMedia(admin(), {
    account_id: account.id, kind, path, sha256: sha, stored_sha256: sha,
    width: kind === "image" ? 1080 : 1080, height: kind === "image" ? 1350 : 1920, duration_s: kind === "video" ? 20 : null,
    mime: kind === "image" ? "image/jpeg" : "video/mp4", bytes: bytes.length, description: `${kind} ${seq}: a coffee on a marble table`, tags: [],
    filename: `${kind}-${seq}`, ...over,
  });
  return media;
}
