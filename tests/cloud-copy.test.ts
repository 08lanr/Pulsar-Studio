// Imported films in the cloud (lib/cloud-copy.ts and the cloud half of
// lib/data/storage.ts; decision 2026-09-24, choice B) over an in-memory
// bucket: the rows decide what is wanted, the listing what is there; only a
// file on this computer's disk is uploaded, and only with the switch on; a
// file over the size limit is reported and left for an hour unless a person
// asks; an existing object counts as uploaded; and a computer without a file
// fetches it from the cloud, checked against the hash in its name, before
// any reader opens it.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { systemSession } from "@/lib/auth";
import { TOO_BIG_RETRY_MS, contentTypeOf, resetCloudCopyForTests, syncCloudCopies, wantedFiles } from "@/lib/cloud-copy";
import { isDataError, type DataLayer } from "@/lib/data";
import { CloudError, ensureLocalTierFile, localPathOf, readStoredBytes, setCloudStoreForTests, sha8OfStored, type CloudStore } from "@/lib/data/storage";

class FakeBucket implements CloudStore {
  objects = new Map<string, Buffer>();
  uploads: string[] = [];
  constructor(private readonly maxBytes = Infinity) {}
  async list(folder: string) {
    const prefix = `${folder}/`;
    return [...this.objects.entries()].filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/")).map(([k, v]) => ({ name: k.slice(prefix.length), size: v.length }));
  }
  async upload(key: string, file: string) {
    this.uploads.push(key);
    const bytes = readFileSync(file);
    if (bytes.length > this.maxBytes) throw new CloudError("too_big", "The object exceeded the maximum allowed size");
    if (this.objects.has(key)) throw new CloudError("exists", "The resource already exists");
    this.objects.set(key, bytes);
  }
  async download(key: string, to: string) {
    const bytes = this.objects.get(key);
    if (!bytes) throw new CloudError("missing", "Object not found");
    writeFileSync(to, bytes);
  }
  async signedUrl(key: string) {
    return this.objects.has(key) ? `https://bucket.test/${key}?token=x` : null;
  }
}

const T = "11111111-2222-4333-8444-555555555555";
let dir: string;
const savedTier = process.env.STUDIO_LOCAL_MEDIA_DIR;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "studio-cloud-"));
  process.env.STUDIO_LOCAL_MEDIA_DIR = path.join(dir, "local");
  resetCloudCopyForTests();
});

afterEach(() => {
  setCloudStoreForTests(undefined);
  resetCloudCopyForTests();
  rmSync(dir, { recursive: true, force: true });
  if (savedTier === undefined) delete process.env.STUDIO_LOCAL_MEDIA_DIR;
  else process.env.STUDIO_LOCAL_MEDIA_DIR = savedTier;
});

/** A local-tier file named by the hash of its bytes, as the import names them. */
function tierFile(stem: string, ext: string, bytes: Buffer, onDisk = true): string {
  const sha8 = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
  const key = `local/${T}/ws/a-film/${stem}-${sha8}${ext}`;
  if (onDisk) {
    const abs = localPathOf(key);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);
  }
  return key;
}

function fakeData(rows: { cover?: string | null; episodes: (string | null)[]; assets: string[] }): DataLayer {
  return {
    listImportedTitles: async () => [{ id: T, name_en: "A Film", name_zh: "一部影片", source_ref: "low-quality/a-film", cover_path: rows.cover ?? null }],
    listTitleEpisodes: async () => rows.episodes.map((video_path, i) => ({ id: `e${i}`, number: i + 1, video_path })),
    listFilmAssets: async () => rows.assets.map((storage_path, i) => ({ id: `a${i}`, storage_path })),
  } as unknown as DataLayer;
}

test("the wanted files are the rows' local-tier files, each once: the cover, the assets, then the episodes in order", () => {
  const ep = (n: number) => `local/${T}/ws/a-film/ep${n}-0000000${n}.mp4`;
  const files = wantedFiles({ cover_path: `local/${T}/ws/a-film/poster-aaaaaaaa.jpg` }, [{ video_path: ep(10) }, { video_path: ep(2) }, { video_path: `${T}/e1/upload.mp4` }, { video_path: null }], [{ storage_path: `local/${T}/ws/a-film/plan-bbbbbbbb.json` }, { storage_path: `local/${T}/ws/a-film/plan-bbbbbbbb.json` }]);
  assert.deepEqual(files.map((f) => f.kind), ["cover", "asset", "episode", "episode"]);
  assert.deepEqual(files.slice(2).map((f) => f.key), [ep(2), ep(10)], "numeric order; a bucket upload and a missing video are not the tier's");
  assert.equal(contentTypeOf(ep(2)), "video/mp4");
  assert.equal(contentTypeOf("x.json"), "application/json");
  assert.equal(sha8OfStored(ep(2)), "00000002");
});

test("a sweep uploads only what is here and not in the cloud; the other computer's files count as elsewhere; too big waits an hour", async () => {
  const bucket = new FakeBucket(1000);
  const small = tierFile("ep01", ".mp4", Buffer.alloc(500, 1));
  const big = tierFile("ep02", ".mp4", Buffer.alloc(2000, 2));
  const already = tierFile("ep03", ".mp4", Buffer.alloc(300, 3));
  bucket.objects.set(already, Buffer.alloc(300, 3));
  const elsewhere = tierFile("ep04", ".mp4", Buffer.alloc(400, 4), false);
  const asset = tierFile("plan", ".json", Buffer.from("{}"));
  const data = fakeData({ episodes: [small, big, already, elsewhere], assets: [asset] });
  let now = 1_000_000;
  const run = (force = false) => syncCloudCopies({ store: bucket, data, session: systemSession(), upload: true, now: () => now, force });

  const first = await run();
  const t = first.titles[0];
  assert.equal(t.files, 5);
  assert.equal(t.in_cloud, 3, "the one already there, the asset and ep01");
  assert.equal(t.elsewhere, 1);
  assert.deepEqual(t.too_big.map((x) => [x.file, x.bytes]), [[path.posix.basename(big), 2000]]);
  assert.deepEqual(bucket.uploads, [asset, small, big], "the asset first, then the episodes; never the file already there");
  assert.ok(bucket.objects.has(small) && !bucket.objects.has(big));

  bucket.uploads = [];
  now += 60_000;
  const second = await run();
  assert.deepEqual(bucket.uploads, [], "a file over the limit is not sent again within the hour");
  assert.equal(second.titles[0].too_big.length, 1, "and is still reported");
  await run(true);
  assert.deepEqual(bucket.uploads, [big], "a person's Upload now tries it at once");
  bucket.uploads = [];
  now += TOO_BIG_RETRY_MS;
  await run();
  assert.deepEqual(bucket.uploads, [big], "and the hourly retry does too");
});

test("with the switch off nothing is uploaded, and an object that already exists counts as uploaded", async () => {
  const bucket = new FakeBucket();
  const a = tierFile("ep01", ".mp4", Buffer.alloc(10, 1));
  const data = fakeData({ episodes: [a], assets: [] });
  const off = await syncCloudCopies({ store: bucket, data, session: systemSession(), upload: false });
  assert.equal(off.titles[0].waiting_here, 1);
  assert.deepEqual(bucket.uploads, []);
  // Listed as empty (a race with the other computer), then refused as existing on upload: done, not failed.
  const racing = Object.assign(new FakeBucket(), { list: async () => [] as { name: string; size: number }[] });
  racing.objects.set(a, Buffer.alloc(10, 1));
  const r = await syncCloudCopies({ store: racing, data, session: systemSession(), upload: true });
  assert.equal(r.titles[0].in_cloud, 1);
  assert.equal(r.titles[0].failed.length, 0);
});

test("without a bucket nothing runs: the picture says so", async () => {
  const r = await syncCloudCopies({ store: null, data: fakeData({ episodes: [], assets: [] }), session: systemSession() });
  assert.equal(r.available, false);
  assert.deepEqual(r.titles, []);
});

test("a computer without a file fetches it from the cloud, checked against the hash in its name", async () => {
  const bucket = new FakeBucket();
  setCloudStoreForTests(bucket);
  const bytes = Buffer.from("episode bytes");
  const key = tierFile("ep05", ".mp4", bytes, false);
  bucket.objects.set(key, bytes);
  const abs = await ensureLocalTierFile(key);
  assert.equal(abs, localPathOf(key));
  assert.deepEqual(readFileSync(abs), bytes);
  assert.deepEqual(await readStoredBytes(key), bytes, "readStoredBytes reads the fetched copy");

  // A cloud object that does not match its name is never used, and leaves nothing behind.
  const wrong = tierFile("ep06", ".mp4", Buffer.from("the real bytes"), false);
  bucket.objects.set(wrong, Buffer.from("something else"));
  await assert.rejects(ensureLocalTierFile(wrong), (e: unknown) => isDataError(e) && /does not match its name/.test(e.message));
  assert.equal(existsSync(localPathOf(wrong)), false);
  assert.deepEqual(readdirSync(path.dirname(localPathOf(wrong))).filter((f) => f.includes("download")), [], "no half-written file stays");

  // In neither place: a plain sentence.
  const nowhere = tierFile("ep07", ".mp4", Buffer.from("x"), false);
  await assert.rejects(ensureLocalTierFile(nowhere), (e: unknown) => isDataError(e) && /not in the cloud yet/.test(e.message));

  // No bucket (fixture): the path, as before.
  setCloudStoreForTests(null);
  assert.equal(await ensureLocalTierFile(nowhere), localPathOf(nowhere));
});
