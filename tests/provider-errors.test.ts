import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adSetPlatforms, campaignPlatforms, explainProviderError, monitorState, needsFirstSweep,
  providerCampaignId, providerErrorCode, switchIsKnown,
} from "@/lib/launch/provider-errors";
import { defaultLaunchDraft } from "@/lib/launch/plan";
import type { DeliverySnapshot, LaunchCampaign, LaunchContent } from "@/lib/launch/types";

// The transports' own shape: `Meta rejected the request (HTTP 400, code 100/1885183): <sentence>`.
const meta = (where: string, said = "Some sentence from Meta.") => `Meta rejected the request (${where}): ${said}`;

test("a known Meta code becomes one plain-language next step, an unknown one does not", () => {
  const cases: [string, string][] = [
    ["HTTP 400, code 100/1885183", "mr2.hint.meta.devMode"],
    ["HTTP 403, code 10", "mr2.hint.meta.appPermission"],
    ["HTTP 401, code 190", "mr2.hint.meta.token"],
    ["HTTP 400, code 368", "mr2.hint.meta.policyBlock"],
    ["HTTP 400, code 100/1487194", "mr2.hint.meta.funding"],
    ["HTTP 400, code 100/1487742", "mr2.hint.meta.spendLimit"],
    ["HTTP 400, code 100/1487390", "mr2.hint.meta.accountDisabled"],
    ["HTTP 400, code 100/1487000", "mr2.hint.meta.adAccount"],
    ["HTTP 500, code 2", "mr2.hint.meta.transient"],
    ["HTTP 429, code 17", "mr2.hint.meta.transient"],
  ];
  for (const [where, hint] of cases) {
    const explained = explainProviderError("meta", meta(where));
    assert.equal(explained.hint, hint, where);
    assert.ok(explained.code, `${where} keeps its code`);
  }
  // Every hint is a locale key, never a sentence: the monitor renders it with tt().
  for (const [, hint] of cases) assert.match(hint, /^mr2\.hint\./);
});

test("an unrecognised code and a message with no code show only the provider's own sentence", () => {
  const unknown = explainProviderError("meta", meta("HTTP 400, code 9999"));
  assert.equal(unknown.hint, null);
  assert.equal(unknown.code, "9999");
  const plain = explainProviderError("meta", "Meta request did not return a verifiable response; read back before retrying.");
  assert.deepEqual(plain, { hint: null });
  // TikTok's transport carries no codes yet; its sentence stands alone.
  assert.deepEqual(explainProviderError("tiktok", "campaign/create/: Balance is insufficient."), { hint: null });
  assert.equal(providerErrorCode(meta("HTTP 400, code 100/1885183")), "100/1885183");
  assert.equal(providerErrorCode("no code here"), undefined);
});

const snapshot = (over: Partial<DeliverySnapshot> = {}): DeliverySnapshot => ({
  delivery: "paused", note: null, checked_at: "2026-09-17T00:00:00.000Z",
  spend_cents: 0, impressions: 0, clicks: 0, conversions: 0, cpc_cents: null, ...over,
});
const campaign = (over: Partial<LaunchCampaign> = {}): Pick<LaunchCampaign, "status" | "state" | "snapshot"> =>
  ({ status: "done", state: {}, snapshot: null, ...over });

test("a launch nobody has swept reads 'not checked yet', not a verdict", () => {
  assert.equal(monitorState(campaign()), "not_checked");
  assert.equal(monitorState(campaign({ status: "pending" })), "not_checked");
  // "unknown" only ever meant "this sweep told us nothing"; it folds back.
  assert.equal(monitorState(campaign({ state: { meta: { campaign_id: "120" } }, snapshot: snapshot({ delivery: "unknown", configured_status: "PAUSED" }) })), "not_checked");
  assert.equal(needsFirstSweep([campaign(), campaign({ snapshot: snapshot({ configured_status: "PAUSED" }) })]), true);
  assert.equal(needsFirstSweep([campaign({ state: { campaign_id: "9" }, snapshot: snapshot({ configured_status: "PAUSED" }) })]), false);
  // A launch with no campaigns has nothing out there to check, so no sweep is
  // started for it and the monitor's footer says "not launched yet" instead.
  assert.equal(needsFirstSweep([]), false);
});

test("objects created but the switch not read reads 'created paused', with the pill still unread", () => {
  const created = campaign({ state: { meta: { campaign_id: "120200000000000" } }, snapshot: snapshot({ delivery: "submitted" }) });
  assert.equal(monitorState(created), "created_paused");
  assert.equal(switchIsKnown(created), false);
  assert.equal(providerCampaignId(created), "120200000000000");
  // Once the switch is read, the sweep's own word wins and the pill is live.
  const read = campaign({ state: { campaign_id: "77" }, snapshot: snapshot({ delivery: "live", configured_status: "ACTIVE" }) });
  assert.equal(monitorState(read), "live");
  assert.equal(switchIsKnown(read), true);
  assert.equal(providerCampaignId(read), "77");
  // A verdict is never softened into "created paused".
  assert.equal(monitorState(campaign({ state: { meta: { campaign_id: "1" } }, snapshot: snapshot({ delivery: "rejected" }) })), "rejected");
  assert.equal(monitorState(campaign({ status: "failed", state: {}, snapshot: null })), "failed");
});

test("ad-set platforms are derived from the content when the driver has not recorded them", () => {
  const draft = defaultLaunchDraft("meta");
  draft.meta_settings.placements = ["facebook", "instagram"];
  const content = (kind: LaunchContent["kind"], value: string): LaunchContent => ({ kind, value });
  const posts = { content: [content("facebook_post", "1_2"), content("instagram_post", "9")], state: {} };
  assert.deepEqual(campaignPlatforms(draft, posts), ["facebook", "instagram"]);
  assert.deepEqual(campaignPlatforms(draft, { content: [content("facebook_post", "1_2")], state: {} }), ["facebook"]);
  assert.deepEqual(campaignPlatforms(draft, { content: [content("video", "clip")], state: {} }), ["facebook", "instagram"]);
  const onlyFacebook = { ...draft, meta_settings: { ...draft.meta_settings, placements: ["facebook" as const] } };
  assert.deepEqual(campaignPlatforms(onlyFacebook, { content: [content("video", "clip")], state: {} }), ["facebook"]);
  // The driver's own record wins once it exists, and maps each ad set to its platform.
  const recorded = { content: [content("video", "clip")], state: { meta: { adset_ids: { instagram: "23848" } } } };
  assert.deepEqual(campaignPlatforms(draft, recorded), ["instagram"]);
  assert.deepEqual(adSetPlatforms(recorded), { "23848": "instagram" });
  assert.deepEqual(campaignPlatforms(defaultLaunchDraft("tiktok"), { content: [content("spark", "code")], state: {} }), []);
});

test("an operator's End outranks a failed launch, and a provider's wait is a wait, not a failure", () => {
  // Failed to launch, then ended by a person: the row reads Ended and offers nothing.
  const endedAfterFailure = campaign({ status: "failed", state: { stop_applied: "ended", desired_status: "ended", meta: {} }, snapshot: snapshot({ delivery: "failed" }) });
  assert.equal(monitorState(endedAfterFailure), "ended");
  // Meta still transcoding the clip: pending with a waiting note, resumed by the worker.
  const waiting = campaign({ status: "pending", state: { waiting: { reason: "Meta is still processing the uploaded clip.", since: "2026-09-17T00:00:00.000Z", retry_after_ms: 45000 } } });
  assert.equal(monitorState(waiting), "waiting");
  assert.equal(needsFirstSweep([waiting]), false, "a waiting row is not an unchecked one");
});

test("a launch that failed before the provider held anything reads 'failed', even after a sweep", () => {
  // The TikTok sweep can only say "unknown" about a campaign that was never created.
  const failed = campaign({ status: "failed", state: {}, snapshot: snapshot({ delivery: "unknown", configured_status: undefined, note: "No Spark code resolved." }) });
  assert.equal(monitorState(failed), "failed");
  assert.equal(needsFirstSweep([failed]), false, "there is nothing out there to check");
  // A failure after the campaign exists still shows what the provider holds.
  const partial = campaign({ status: "failed", state: { campaign_id: "1700" }, snapshot: snapshot({ delivery: "submitted", configured_status: undefined }) });
  assert.equal(monitorState(partial), "created_paused");
});
