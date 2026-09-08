import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import { fixtureSession } from "@/lib/auth";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { guessColumnMap, parseCsv, previewImport, summarizeReports } from "@/lib/research/reports";
import { shortlist } from "@/lib/research/shortlist";
import type { CatalogMatch } from "@/lib/research/engine";

afterEach(() => resetFixtureStore());

const producer = () => fixtureSession("producer");
const staff = () => fixtureSession("staff");
const viewer = () => ({ ...fixtureSession("producer"), producerRole: "viewer" as const });
const otherCompany = () => ({ ...fixtureSession("producer"), producerId: "00000000-0000-4000-8000-00000000ffff" });

// ---- watchlist ---------------------------------------------------------------------

test("watchlist is company-scoped and editor-only", async () => {
  resetFixtureStore();
  assert.deepEqual(await fixtureData.listWatchlist(producer()), []);
  await fixtureData.addWatch(producer(), "reelshort-abc123");
  await fixtureData.addWatch(producer(), "reelshort-abc123"); // idempotent
  assert.equal((await fixtureData.listWatchlist(producer())).length, 1);
  assert.deepEqual(await fixtureData.listWatchlist(otherCompany()), [], "another company sees nothing");
  assert.deepEqual(await fixtureData.listWatchlist(staff()), [], "staff previewing has no company watchlist");
  await assert.rejects(fixtureData.addWatch(viewer(), "reelshort-x"), (e: Error & { code?: string }) => e.code === "forbidden");
  await assert.rejects(fixtureData.addWatch(staff(), "reelshort-x"), (e: Error & { code?: string }) => e.code === "forbidden");
  await assert.rejects(fixtureData.addWatch(producer(), "youtube-x"), (e: Error & { code?: string }) => e.code === "invalid");
  await fixtureData.removeWatch(otherCompany(), "reelshort-abc123");
  assert.equal((await fixtureData.listWatchlist(producer())).length, 1, "another company cannot remove our watch");
  await fixtureData.removeWatch(producer(), "reelshort-abc123");
  assert.equal((await fixtureData.listWatchlist(producer())).length, 0);
});

// ---- CSV parsing and preview -----------------------------------------------------

const CSV = `剧名,平台,开始,结束,指标,数值,币种
向园,ReelShort,2026-08-01,2026-08-31,views,"12,340",
向园,ReelShort,2026-08-01,2026-08-31,revenue,1500.50,USD
Unknown Drama,YouTube,2026/08/01,,starts,90,
向园,ReelShort,2026-08-01,2026-08-31,views,12340,
向园,ReelShort,not-a-date,2026-08-31,views,5,
向园,ReelShort,2026-08-01,2026-08-31,spend,200,
向园,ReelShort,2026-08-01,2026-08-31,likes,5,
`;

test("CSV parsing handles quotes and CRLF; Chinese headers are mapped", () => {
  const { headers, rows } = parseCsv('a,b\r\n"x, y","he said ""hi"""\r\n');
  assert.deepEqual(headers, ["a", "b"]);
  assert.deepEqual(rows[0], ["x, y", 'he said "hi"']);
  const map = guessColumnMap(["剧名", "平台", "开始", "结束", "指标", "数值", "币种"]);
  assert.equal(map.title, "剧名");
  assert.equal(map.period_end, "结束");
  assert.equal(map.currency, "币种");
});

test("preview validates rows, detects duplicates in file and against existing rows, links titles", () => {
  const catalog = [{ id: "t1", name_zh: "向园", name_en: "Xiang Yuan", genre: null, synopsis_zh: null, synopsis_en: null }];
  const p = previewImport({ text: CSV, existing: [], catalog });
  assert.deepEqual(p.missing_columns, []);
  const byRow = new Map(p.rows.map((r) => [r.row, r]));
  assert.equal(byRow.get(2)?.ok, true);
  assert.equal(byRow.get(2)?.data?.value, 12340, "thousands separators are stripped");
  assert.equal(byRow.get(2)?.data?.title_id, "t1");
  assert.equal(byRow.get(3)?.data?.currency, "USD");
  assert.equal(byRow.get(4)?.ok, true);
  assert.equal(byRow.get(4)?.data?.title_id, null, "unmatched title imports unlinked");
  assert.equal(byRow.get(4)?.data?.period_end, "2026-08-01", "missing period_end defaults to period_start");
  assert.equal(byRow.get(5)?.duplicate, true, "same title/platform/period/metric as row 2");
  assert.equal(byRow.get(6)?.ok, false);
  assert.match(byRow.get(6)!.errors[0], /period_start/);
  assert.equal(byRow.get(7)?.ok, false, "spend needs a currency");
  assert.equal(byRow.get(8)?.ok, false, "unknown metric");
  assert.equal(p.valid, 3);
  assert.equal(p.invalid, 3);
  assert.equal(p.duplicates, 1);
  assert.equal(p.unmatched_titles, 1);
  // Against existing rows: row 2 becomes a duplicate.
  const again = previewImport({ text: CSV, existing: [{ ...byRow.get(2)!.data!, id: "r", batch_id: "b", producer_id: "p" }], catalog });
  assert.equal(again.rows.find((r) => r.row === 2)?.duplicate, true);
});

test("missing required columns mark every row invalid", () => {
  const p = previewImport({ text: "name,value\nx,1\n", existing: [], catalog: [] });
  assert.ok(p.missing_columns.includes("platform"));
  assert.equal(p.valid, 0);
  assert.equal(p.rows[0].ok, false);
});

// ---- commit, revert, tenant isolation -------------------------------------------

test("report batches commit for editors only, are scoped, and revert hides rows", async () => {
  resetFixtureStore();
  const title = await fixtureData.createTitle(producer(), { name_zh: "向园", name_en: "Xiang Yuan", producer_id: "ignored" });
  const rows = [
    { title_id: title.id, title_name: "向园", platform: "ReelShort", period_start: "2026-08-01", period_end: "2026-08-31", metric: "views" as const, value: 12340, currency: null, source_row: 2 },
    { title_id: "00000000-0000-4000-8000-00000000dead", title_name: "someone else's", platform: "X", period_start: "2026-08-01", period_end: "2026-08-31", metric: "views" as const, value: 1, currency: null, source_row: 3 },
  ];
  await assert.rejects(fixtureData.commitReportBatch(viewer(), { filename: "a.csv", column_map: {}, rows, skipped_count: 0 }), (e: Error & { code?: string }) => e.code === "forbidden");
  await assert.rejects(fixtureData.commitReportBatch(staff(), { filename: "a.csv", column_map: {}, rows, skipped_count: 0 }), (e: Error & { code?: string }) => e.code === "forbidden");
  await assert.rejects(fixtureData.commitReportBatch(producer(), { filename: "a.csv", column_map: {}, rows: [], skipped_count: 0 }), (e: Error & { code?: string }) => e.code === "invalid");
  const batch = await fixtureData.commitReportBatch(producer(), { filename: "a.csv", column_map: { title: "剧名" }, rows, skipped_count: 1 });
  assert.equal(batch.row_count, 2);
  const stored = await fixtureData.listReportRows(producer());
  assert.equal(stored.length, 2);
  assert.equal(stored.find((r) => r.source_row === 3)?.title_id, null, "a foreign title id is stored unlinked");
  assert.equal((await fixtureData.listReportRows(producer(), { titleId: title.id })).length, 1);
  assert.deepEqual(await fixtureData.listReportRows(otherCompany()), []);
  assert.deepEqual(await fixtureData.listReportBatches(otherCompany()), []);
  await assert.rejects(fixtureData.revertReportBatch(otherCompany(), batch.id), (e: Error & { code?: string }) => e.code === "not_found");
  const reverted = await fixtureData.revertReportBatch(producer(), batch.id);
  assert.ok(reverted.reverted_at);
  assert.deepEqual(await fixtureData.listReportRows(producer()), [], "reverted rows disappear");
  assert.equal((await fixtureData.listReportBatches(producer())).length, 1, "the batch stays on record");
  const summary = summarizeReports(stored);
  assert.equal(summary.get(title.id)?.[0].metric, "views");
});

// ---- shortlist ---------------------------------------------------------------------

test("shortlist is an explained hypothesis: reasons, missing inputs, versioned score", () => {
  const match: CatalogMatch = { title_id: "t1", tropes: ["revenge"], market_score: 40, hot_tropes: ["revenge"], comparable_keys: ["reelshort-a", "dramabox-x"], explanation: [{ trope: "revenge", cohort_share: 0.4 }] };
  const entries = shortlist({
    titles: [
      { id: "t1", name_zh: "A", name_en: null, license_start: "2026-01-01", license_end: "2027-01-01", percent_adapted: 100, has_approved_version: true, episodes_ingested: 4, episode_count: 4, has_synopsis: true },
      { id: "t2", name_zh: "B", name_en: null, license_start: null, license_end: null, percent_adapted: 0, has_approved_version: false, episodes_ingested: 0, episode_count: 0, has_synopsis: false },
      { id: "t3", name_zh: "C", name_en: null, license_start: "2020-01-01", license_end: "2021-01-01", percent_adapted: 50, has_approved_version: false, episodes_ingested: 2, episode_count: 4, has_synopsis: true },
    ],
    matches: [match],
    profile: { tropes: ["revenge"], audience: null, titles_per_year: null, distribution: [], target_markets: ["US"], updated_at: "x" },
    reports: [],
    today: "2026-09-07",
  });
  assert.equal(entries[0].title_id, "t1");
  assert.equal(entries[0].version, "1.0");
  assert.equal(entries[0].score, 20 + 15 + 20 + 10, "comparables 40×0.5, rights, approved subtitles, US target");
  assert.deepEqual(entries[0].missing, ["own_evidence"]);
  const c = entries.find((e) => e.title_id === "t3")!;
  assert.ok(c.reasons.some((r) => r.kind === "rights" && r.ok === false), "outside the license window argues against");
  const b = entries.find((e) => e.title_id === "t2")!;
  assert.ok(b.missing.includes("comparables") && b.missing.includes("rights") && b.missing.includes("localization"));
  assert.equal(b.score, 10, "only the stated US target counts; nothing invented");
});
