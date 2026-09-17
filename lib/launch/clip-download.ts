import { createHash } from "node:crypto";
import { invalid, notFound } from "@/lib/data/errors";
import { safeFilename } from "@/lib/data/storage";
import { MAX_ARCHIVE_BYTES, MAX_CLIP_BYTES, readClipBytes } from "@/lib/launch/clip-bytes";
import type { LaunchLibraryItem } from "@/lib/launch/types";

// The bounded reader moved to lib/launch/clip-bytes.ts so the organic
// publishing engine reads clip bytes through exactly the same ceilings.
export { MAX_ARCHIVE_BYTES, MAX_CLIP_BYTES };

export type ZipEntry = { name: string; bytes: Buffer };

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let i = 0; i < 8; i++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (c >>> 8) ^ crcTable[(c ^ byte) & 255];
  return (c ^ 0xffffffff) >>> 0;
}

/** Standard uncompressed ZIP; UTF-8 names, per-file CRC, central directory. */
export function zipClips(entries: ZipEntry[]): Buffer {
  if (entries.length < 1 || entries.length > 30) throw invalid("Choose 1–30 clips.");
  const chunks: Buffer[] = [], directory: Buffer[] = [];
  let offset = 0, directorySize = 0;
  for (const { name, bytes } of entries) {
    const filename = Buffer.from(name, "utf8");
    if (!filename.length || filename.length > 65535 || name.includes("/") || name.includes("\\")) throw invalid("Invalid clip filename.");
    const crc = crc32(bytes), flags = 0x800;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(0x21, 12); // 1980-01-01, a valid deterministic DOS date.
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8); central.writeUInt32LE(crc, 16);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    chunks.push(local, filename, bytes); directory.push(central, filename);
    offset += local.length + filename.length + bytes.length;
    directorySize += central.length + filename.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directorySize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...directory, end], offset + directorySize + end.length);
}

export async function downloadClips(ids: string[], library: LaunchLibraryItem[], read = readClipBytes): Promise<Buffer> {
  if (ids.length < 1 || ids.length > 30 || new Set(ids).size !== ids.length) throw invalid("Choose 1–30 different clips.");
  const own = new Map(library.filter(item => item.kind === "video" && item.file_path && item.sha256).map(item => [item.id, item]));
  const selected = ids.map(id => own.get(id));
  if (selected.some(item => !item)) throw notFound("Finished clip");
  const entries: ZipEntry[] = [];
  let total = 0;
  for (const [index, item] of selected.entries()) {
    const clip = item!;
    const remaining = MAX_ARCHIVE_BYTES - total;
    if (remaining <= 0) throw invalid("Selected clips exceed the download limit.");
    const bytes = await read(clip.file_path!, Math.min(MAX_CLIP_BYTES, remaining));
    total += bytes.length;
    if (bytes.length > MAX_CLIP_BYTES || total > MAX_ARCHIVE_BYTES) throw invalid("Selected clips exceed the download limit.");
    if (createHash("sha256").update(bytes).digest("hex") !== clip.sha256) throw invalid("A finished clip changed after rendering. Please render it again.");
    const title = safeFilename(clip.title_name).slice(0, 65) || "clip";
    entries.push({ name: `${String(index + 1).padStart(2, "0")}-${title}.mp4`, bytes });
  }
  return zipClips(entries);
}
