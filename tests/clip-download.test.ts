import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { downloadClips, MAX_ARCHIVE_BYTES, zipClips } from "../lib/launch/clip-download";
import type { LaunchLibraryItem } from "../lib/launch/types";

const bytes = Buffer.from("finished-clip-\n");
const clip = (id: string, title_name = "A 中文 / title"): LaunchLibraryItem => ({
  id, title_name, kind: "video", value: id, file_path: `stored/${id}.mp4`,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  media_url: null, spark_code: null, post_url: null,
});

test("ZIP has valid UTF-8 names, CRC, sizes and central directory offsets", () => {
  const zip = zipClips([{ name: "01-中文.mp4", bytes }, { name: "02-second.mp4", bytes }]);
  let pos = 0;
  for (const name of ["01-中文.mp4", "02-second.mp4"]) {
    assert.equal(zip.readUInt32LE(pos), 0x04034b50);
    assert.equal(zip.readUInt16LE(pos + 6), 0x800);
    assert.equal(zip.readUInt32LE(pos + 18), bytes.length);
    const len = zip.readUInt16LE(pos + 26);
    assert.equal(zip.subarray(pos + 30, pos + 30 + len).toString(), name);
    assert.deepEqual(zip.subarray(pos + 30 + len, pos + 30 + len + bytes.length), bytes);
    pos += 30 + len + bytes.length;
  }
  const directoryStart = pos;
  assert.equal(zip.readUInt32LE(pos), 0x02014b50);
  assert.equal(zip.readUInt32LE(pos + 16), zip.readUInt32LE(14));
  assert.equal(zip.readUInt32LE(pos + 42), 0);
  pos += 46 + Buffer.byteLength("01-中文.mp4");
  assert.equal(zip.readUInt32LE(pos), 0x02014b50);
  assert.equal(zip.readUInt32LE(pos + 42), 30 + Buffer.byteLength("01-中文.mp4") + bytes.length);
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  assert.equal(zip.readUInt16LE(end + 10), 2);
  assert.equal(zip.readUInt32LE(end + 16), directoryStart);
  assert.equal(zip.readUInt32LE(end + 12), end - directoryStart);
});

test("all IDs are authorized before any storage read", async () => {
  let reads = 0;
  await assert.rejects(downloadClips(["own", "other-company"], [clip("own")], async () => { reads++; return bytes; }), { code: "not_found" });
  assert.equal(reads, 0);
  await assert.rejects(downloadClips(["own", "own"], [clip("own")], async () => { reads++; return bytes; }), { code: "invalid" });
  assert.equal(reads, 0);
});

test("hash mismatch and total download limit stop the archive", async () => {
  await assert.rejects(downloadClips(["own"], [clip("own")], async () => Buffer.from("tampered")), { code: "invalid" });
  const many = Array.from({ length: 4 }, (_, n) => clip(`clip-${n}`));
  const large = Buffer.alloc(32 * 1024 * 1024);
  for (const item of many) item.sha256 = createHash("sha256").update(large).digest("hex");
  const limits: number[] = [];
  await assert.rejects(downloadClips(many.map(x => x.id), many, async (_path, limit) => {
    limits.push(limit);
    if (limit < large.length) throw new Error("bounded read");
    return large;
  }), { code: "invalid" });
  assert.deepEqual(limits, [large.length, large.length, large.length]);
  assert.equal(MAX_ARCHIVE_BYTES, 3 * large.length);
});
