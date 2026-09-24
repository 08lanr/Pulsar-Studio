// What the "Upload to crazydramas" screens derive (phase 5, publish spec
// §1–5; components/producer/CrazydramasPublish.tsx and its parts under
// components/producer/crazydramas/): the IAP id and poster suggestions, the
// route bodies' zod shapes (the contract's rules on the IAP id and the
// poster, strict bodies), the words an episode's row says for each ledger
// step, which episodes the Publish dialog offers, a refusal said in the
// words it came with, and every key the screens use present in both
// locales. The routes and the ledger are the core's (5-core); this file
// covers only what the screens decide.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { publishable } from "@/components/producer/crazydramas/PublishDialog";
import { centsFromDollars, dollarsFromCents, episodeList, refusalWords } from "@/components/producer/crazydramas/request";
import { canUploadEpisode, failedAction, isActive, rowStage, STAGE_PILL } from "@/components/producer/crazydramas/UploadProgress";
import {
  IAP_PRODUCT_ID,
  LEDGER_STEPS,
  PublishBodySchema,
  PublishStateSchema,
  SERIES_STATES,
  SeriesBodySchema,
  UnpublishBodySchema,
  UploadsBodySchema,
  suggestIapProductId,
  suggestPosterUrl,
  type PublishEpisode,
} from "@/lib/crazydramas/publish-types";
import en from "@/locales/en.json";
import zh from "@/locales/zh.json";

const EN = en as Record<string, string>;
const ZH = zh as Record<string, string>;

const ep = (over: Partial<PublishEpisode> = {}): PublishEpisode => ({ n: 1, studio_frames: 120, ledger_step: null, cd_status: null, is_published: false, is_free: true, verdict: null, ...over });

test("the IAP id suggestion follows the contract: cd.series.<short_name>, at most 40 characters of [a-z0-9_.], never ending on a separator", () => {
  assert.equal(suggestIapProductId("fixture-film"), "cd.series.fixture_film");
  assert.equal(suggestIapProductId("forced-to-marry-the-mafia-boss"), "cd.series.forced_to_marry_the_mafia_boss");
  const long = suggestIapProductId("i-came-back-with-his-abandoned-son-to-ruin-his-wedding");
  assert.ok(long.length <= 40, long);
  assert.match(long, IAP_PRODUCT_ID);
  assert.doesNotMatch(long, /[._]$/);
  for (const bad of ["CD.series.x", "cd series x", "_cd.series", "cd.series.this_name_is_far_too_long_for_google_play"]) assert.doesNotMatch(bad, IAP_PRODUCT_ID, bad);
  assert.equal(suggestPosterUrl("fixture-film"), "https://crazydramas.com/posters/fixture-film.jpg");
});

test("the route bodies are strict and carry the contract's rules: the IAP format and an https poster on the series, episodes or 'all' on uploads, something to change on publish and unpublish", () => {
  assert.ok(SeriesBodySchema.safeParse({ title: "Fixture Film", iap_product_id: "cd.series.fixture_film", poster_url: "https://crazydramas.com/posters/fixture-film.jpg", free_episode_count: 2, series_price_cents: 999 }).success);
  const iap = SeriesBodySchema.safeParse({ title: "Fixture Film", iap_product_id: "CD.Series.Bad Name!" });
  assert.equal(iap.success, false);
  assert.match(JSON.stringify(iap.error?.flatten().fieldErrors), /at most 40 characters/);
  assert.equal(SeriesBodySchema.safeParse({ title: "X", poster_url: "http://crazydramas.com/posters/x.jpg" }).success, false, "an http poster is refused");
  assert.equal(SeriesBodySchema.safeParse({ title: "" }).success, false, "a title is required");
  assert.equal(SeriesBodySchema.safeParse({ title: "X", slug: "x" }).success, false, "the slug is the title's, never in the body");
  assert.ok(UploadsBodySchema.safeParse({ episodes: "all" }).success);
  assert.ok(UploadsBodySchema.safeParse({ episodes: [1, 2], replace: true }).success);
  assert.equal(UploadsBodySchema.safeParse({ episodes: [] }).success, false);
  assert.equal(UploadsBodySchema.safeParse({ episodes: [0] }).success, false);
  assert.ok(PublishBodySchema.safeParse({ episodes: [1, 2], publish_series: true }).success);
  assert.ok(PublishBodySchema.safeParse({ episodes: [3], publish_series: false, confirm_paid: true }).success);
  assert.equal(PublishBodySchema.safeParse({ episodes: [], publish_series: false }).success, false, "a publish that changes nothing is refused");
  assert.equal(UnpublishBodySchema.safeParse({}).success, false);
  assert.ok(UnpublishBodySchema.safeParse({ unpublish_series: true }).success);
});

test("the state the page reads parses with only the contract's fields, and the optional progress extras", () => {
  const state = {
    series_state: "draft",
    series: { id: "5cf460e6-0000-4000-8000-000000000001", slug: "fixture-film-draft", title: "X", status: "draft", genre: [], free_episode_count: 2, series_price_cents: 999, managed_by: "studio" },
    form_defaults: { slug: "fixture-film-draft", title: "X", tagline: null, description: null, genre: [], language: "en", free_episode_count: 5, series_price_cents: 999, iap_product_id: "cd.series.fixture_film_draft", poster_url: null },
    episodes: [{ n: 1, studio_frames: 120, ledger_step: "upload_created", cd_status: "uploading", is_published: false, is_free: true, verdict: null, bytes_sent: 262144, bytes_total: 1048576 }],
    writes_enabled: false,
    writes_disabled_reason: "CRAZYDRAMAS_LIVE_WRITES is not set to enabled",
    paywall_live: false,
  };
  const parsed = PublishStateSchema.parse(state);
  assert.equal(parsed.episodes[0].bytes_sent, 262144);
  assert.deepEqual([...SERIES_STATES], ["not_linked", "not_uploaded", "draft", "published", "cms_managed", "linked_elsewhere"]);
  assert.equal(PublishStateSchema.safeParse({ ...state, series_state: "archived" }).success, false);
});

test("each ledger step reads as the words the spec names, and a published episode reads published whatever step it came from", () => {
  const expect: Record<string, string> = { planned: "queued", upload_created: "uploading", bytes_sent: "processing", asset_ready: "checking", verified: "verified", published: "verified", failed: "failed", superseded: "replaced" };
  for (const step of LEDGER_STEPS) assert.equal(rowStage(ep({ ledger_step: step })), expect[step], step);
  assert.equal(rowStage(ep({ ledger_step: "published", is_published: true })), "published");
  assert.equal(rowStage(ep({ ledger_step: null, cd_status: "ready", is_published: true })), "published");
  assert.equal(rowStage(ep()), "none");
  assert.equal(rowStage(ep({ studio_frames: null })), "no_file");
  assert.equal(rowStage(ep({ cd_status: "ready" })), "on_cd");
  for (const stage of Object.keys(STAGE_PILL)) {
    assert.ok(EN[`cdp.stage.${stage}`] && ZH[`cdp.stage.${stage}`], `words for ${stage}`);
  }
  assert.equal(EN["cdp.stage.uploadingPct"].replace("{pct}", "42"), "Uploading 42%");
});

test("only a file Studio has and nothing on crazydramas can be uploaded; the uploader's steps poll; only verified, unpublished episodes are offered to publish", () => {
  assert.equal(canUploadEpisode(ep()), true);
  assert.equal(canUploadEpisode(ep({ studio_frames: null })), false);
  assert.equal(canUploadEpisode(ep({ ledger_step: "planned" })), false);
  assert.equal(canUploadEpisode(ep({ cd_status: "ready" })), false, "a CMS episode is never overwritten from the upload-all button");
  for (const step of ["planned", "upload_created", "bytes_sent", "asset_ready"] as const) assert.equal(isActive(ep({ ledger_step: step })), true, step);
  for (const step of ["verified", "published", "failed", "superseded"] as const) assert.equal(isActive(ep({ ledger_step: step })), false, step);
  assert.equal(publishable(ep({ ledger_step: "verified", cd_status: "ready" })), true);
  assert.equal(publishable(ep({ ledger_step: "asset_ready", cd_status: "ready" })), false, "ready but not verified never goes live");
  assert.equal(publishable(ep({ ledger_step: "failed", cd_status: "ready" })), false, "a verify mismatch never goes live");
  assert.equal(publishable(ep({ ledger_step: "published", cd_status: "ready", is_published: true })), false);
  assert.equal(publishable(ep({ ledger_step: "published", cd_status: "ready", is_published: false })), true, "an unpublished episode can go live again");
});

test("a failed row whose episode someone else's upload now holds offers Replace (with its warning), never a plain Retry, and Retry failed leaves it out", () => {
  for (const code of ["replace_required", "taken_over", "taken_over_late"]) assert.equal(failedAction(ep({ ledger_step: "failed", error_code: code, cd_status: "ready" })), "replace", code);
  for (const code of ["asset_errored", "verify_failed", "cancelled", null]) assert.equal(failedAction(ep({ ledger_step: "failed", error_code: code })), "retry", String(code));
  assert.equal(failedAction(ep({ ledger_step: "failed", error_code: "replace_required", studio_frames: null })), null, "no file, nothing to send");
  assert.equal(failedAction(ep({ ledger_step: "verified" })), null);
  assert.ok(EN["cdp.replace.impact.unchecked"] && ZH["cdp.replace.impact.unchecked"]);
  assert.match(EN["cdp.replace.impact.unchecked"], /before Studio checks it; if the check fails, unpublish the episode/, "a published episode's replace says it goes live before Studio's check");
});

test("a refusal keeps the words it came with: crazydramas' sentence, its issues, Studio's zod detail and the series that has the title", () => {
  assert.equal(
    refusalWords({ error: "A series with this title already exists.", code: "series_title_exists", existing: { title: "Forced to Marry the Mafia Boss", slug: "forced-to-marry-the-mafia-boss" } }, 409),
    "A series with this title already exists · Forced to Marry the Mafia Boss (forced-to-marry-the-mafia-boss)"
  );
  assert.equal(refusalWords({ error: "Invalid body", code: "bad_request", issues: [{ path: "iap_product_id", message: "at most 40 characters" }] }, 400), "Invalid body · iap_product_id: at most 40 characters");
  assert.equal(refusalWords({ error: "Invalid request", detail: { fieldErrors: { iap_product_id: ["at most 40 characters of a-z"] }, formErrors: [] } }, 400), "Invalid request · iap_product_id: at most 40 characters of a-z");
  assert.equal(refusalWords({} as never, 502), "HTTP 502");
  assert.equal(episodeList([3, 1, 2]), "1, 2, 3");
  assert.equal(centsFromDollars("9.99"), 999);
  assert.equal(centsFromDollars("$10"), 1000);
  assert.equal(centsFromDollars("nine"), null);
  assert.equal(dollarsFromCents(999), "9.99");
});

test("every cdp.* key the screens use has words in both locales, and the paid warning and the hand-over note say what the spec says", () => {
  const dir = path.join(process.cwd(), "components", "producer");
  const files = [path.join(dir, "CrazydramasPublish.tsx"), path.join(dir, "CrazydramasPanel.tsx"), path.join(dir, "FilmImport.tsx"), ...readdirSync(path.join(dir, "crazydramas")).map((f) => path.join(dir, "crazydramas", f))];
  const used = new Set<string>();
  for (const f of files) for (const m of readFileSync(f, "utf8").matchAll(/"(cdp\.[a-zA-Z0-9_.]+)"/g)) used.add(m[1]);
  assert.ok(used.size > 50, `found ${used.size} keys`);
  for (const key of used) {
    assert.ok(key in EN, `en has ${key}`);
    assert.ok(key in ZH, `zh has ${key}`);
  }
  for (const s of SERIES_STATES) assert.ok(EN[`cdp.state.${s}`] && ZH[`cdp.state.${s}`], `state words for ${s}`);
  assert.match(EN["cdp.publish.paidWarn"], /Paid episodes can be streamed free until the paywall fix is live on crazydramas/);
  assert.match(EN["cdp.cms.note"], /Made in the CMS — ask Jayden to hand it over \(one SQL line\) to manage it from Studio/);
  assert.doesNotMatch(ZH["cdp.publish.open"] + ZH["cdp.form.create"] + ZH["cdp.import.upload"], /您|作品/, "the portal's Chinese: 你 and 剧集/分集");
});
