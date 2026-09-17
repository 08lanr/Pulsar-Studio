// The content decides the platform (docs/launch-ux-round-2.md §1.1, §1.2, §1.3):
// a campaign gets one ad set per platform that actually has content, the signed
// budget is split across them, and the campid is stamped from the first one the
// producer typed. Everything a Meta draft must fix arrives as one list.

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLaunchPlan, campidSeries, defaultLaunchDraft, deriveAdSets, metaDraftIssues, nextCampidStart } from "@/lib/launch/plan";
import type { LaunchConnection, LaunchContent, LaunchDraft } from "@/lib/launch/types";

const account = (over: Partial<LaunchConnection> = {}): LaunchConnection => ({
  id: "meta-one", producer_id: "company", provider: "meta", advertiser_id: "act_9001", name: "Meta Demo",
  currency: "USD", timezone: "America/Los_Angeles", page_id: "111", instagram_id: "222",
  business_id: null, assigned_by: "staff", verified_at: "2026-09-16T00:00:00.000Z", enabled: true, ...over,
});
const fb = (value = "111_1001"): LaunchContent => ({ kind: "facebook_post", value });
const ig = (value = "9001"): LaunchContent => ({ kind: "instagram_post", value });
const clip = (value = "clip-one"): LaunchContent => ({ kind: "video", value });
const both: ("facebook" | "instagram")[] = ["facebook", "instagram"];

function draft(over: Partial<LaunchDraft> = {}): LaunchDraft {
  const base = defaultLaunchDraft("meta");
  return {
    ...base, account_ids: ["meta-one"], destination_url: "https://crazydramas.com/watch",
    content: [fb()], content_per_campaign: 1, total_budget_cents: 50_000, ...over,
  };
}
const platforms = (sets: { platform: string }[]) => sets.map(set => set.platform);
const values = (sets: { content: LaunchContent[] }[]) => sets.map(set => set.content.map(item => item.value));

test("a post keeps its own platform, a clip follows the placements, and an empty platform gets no ad set", () => {
  assert.deepEqual(platforms(deriveAdSets([fb(), fb("111_1002")], both, 10_000, null)), ["facebook"]);
  assert.deepEqual(platforms(deriveAdSets([ig()], both, 10_000, null)), ["instagram"]);
  assert.deepEqual(platforms(deriveAdSets([fb(), ig()], ["facebook"], 10_000, null)), ["facebook", "instagram"]);
  const clipsOnly = deriveAdSets([clip()], both, 10_000, null);
  assert.deepEqual(platforms(clipsOnly), ["facebook", "instagram"]);
  assert.deepEqual(values(clipsOnly), [["clip-one"], ["clip-one"]]);
  assert.deepEqual(platforms(deriveAdSets([clip()], ["instagram"], 10_000, null)), ["instagram"]);
  const mixed = deriveAdSets([clip(), ig()], both, 10_000, null);
  assert.deepEqual(values(mixed), [["clip-one"], ["clip-one", "9001"]]);
  assert.deepEqual(deriveAdSets([], both, 10_000, null), []);
});

test("ad sets share the campaign budget equally, remainder first, in both budget shapes", () => {
  const lifetime = deriveAdSets([fb(), ig()], both, 10_001, null);
  assert.deepEqual(lifetime.map(set => set.budget_cents), [5_001, 5_000]);
  assert.deepEqual(lifetime.map(set => set.daily_budget_cents), [null, null]);
  assert.equal(lifetime.reduce((sum, set) => sum + set.budget_cents, 0), 10_001);
  const daily = deriveAdSets([fb(), ig()], both, 10_000, 4_001);
  assert.deepEqual(daily.map(set => set.daily_budget_cents), [2_001, 2_000]);
  const plan = buildLaunchPlan(draft({ content: [fb(), ig()], content_per_campaign: 2 }), [account()]);
  assert.deepEqual(platforms(plan.rows[0].ad_sets!), ["facebook", "instagram"]);
  assert.deepEqual(plan.rows[0].ad_sets!.map(set => set.budget_cents), [25_000, 25_000]);
});

test("an ad-set share below Meta's minimum refuses the plan instead of creating an unservable ad set", () => {
  const thin = draft({ content: [fb(), ig()], content_per_campaign: 2, total_budget_cents: 150 });
  assert.deepEqual(metaDraftIssues(thin, [account()]).map(issue => issue.code), ["adSetMinimum"]);
  assert.throws(() => buildLaunchPlan(thin, [account()]), /Each ad set needs at least \$1/);
  const enough = { ...thin, total_budget_cents: 200 };
  assert.equal(metaDraftIssues(enough, [account()]).length, 0);
  assert.deepEqual(buildLaunchPlan(enough, [account()]).rows[0].ad_sets!.map(set => set.budget_cents), [100, 100]);
});

test("campids count up from the first one typed, preserving its padding, and stay unique in the run", () => {
  assert.deepEqual(campidSeries("rlapple01", 3), ["rlapple01", "rlapple02", "rlapple03"]);
  assert.deepEqual(campidSeries("rlapple09", 2), ["rlapple09", "rlapple10"]);
  assert.deepEqual(campidSeries("rlapple099", 2), ["rlapple099", "rlapple100"]);
  assert.deepEqual(campidSeries("gravy", 2), ["gravy01", "gravy02"]);
  assert.deepEqual(campidSeries("  RLApple01 ", 2), ["rlapple01", "rlapple02"]);
  const series = campidSeries("rlapple01", 40);
  assert.equal(new Set(series).size, 40);
});

test("a typed first campid names the campaigns and their tracking links; an empty one keeps Studio's own", () => {
  const stamped = buildLaunchPlan(draft({ campid_start: "rlapple01", campaigns_per_account: 3, content_per_campaign: 1,
    content: [fb("111_1"), fb("111_2"), fb("111_3")] }), [account()]);
  assert.deepEqual(stamped.rows.map(row => row.campid), ["rlapple01", "rlapple02", "rlapple03"]);
  assert.deepEqual(stamped.rows.map(row => row.name), ["rlapple01", "rlapple02", "rlapple03"]);
  assert.deepEqual(stamped.rows.map(row => new URL(row.tracking_url!).searchParams.get("campid")), ["rlapple01", "rlapple02", "rlapple03"]);
  const derived = buildLaunchPlan(draft(), [account()], "lr_0123456789ab");
  assert.equal(derived.rows[0].campid, "launch-0123456789ab-001");
  assert.equal(buildLaunchPlan(draft({ campid_start: "  " }), [account()]).rows[0].campid, undefined);
});

test("an unusable campid is refused by shape, in the same collected list", () => {
  for (const bad of ["rl apple01", "-rlapple01", "rlapple01!", "r".repeat(41)]) {
    assert.deepEqual(metaDraftIssues(draft({ campid_start: bad }), [account()]).map(issue => issue.code), ["campidShape"]);
    assert.throws(() => buildLaunchPlan(draft({ campid_start: bad }), [account()]), /campid uses 2 to 40/);
  }
  assert.equal(metaDraftIssues(draft({ campid_start: "rl_apple-01" }), [account()]).length, 0);
});

test("the shape problems every launch can have join the same list instead of refusing one at a time", () => {
  const codes = (over: Partial<LaunchDraft>, accounts = [account()]) => metaDraftIssues(draft(over), accounts).map(issue => issue.code);
  assert.deepEqual(codes({ destination_url: "not-a-url" }), ["destinationUrl"]);
  assert.deepEqual(codes({ destination_url: "https://user:secret@example.com/watch" }), ["destinationUrl"]);
  assert.deepEqual(codes({ account_ids: ["meta-one", "meta-one"], content: [fb(), fb("111_2")], content_per_campaign: 1 }), ["duplicateAccounts"]);
  assert.deepEqual(codes({ content: [fb(), ig()] }), ["contentCount"]);
  assert.deepEqual(codes({ content: [fb(), fb()], content_per_campaign: 2 }), ["duplicateContent"]);
  // …and the whole list reaches a refused preview in one message.
  let refusal = "";
  try { buildLaunchPlan(draft({ destination_url: "ftp://example.com", content: [fb(), fb()], content_per_campaign: 2 }), [account()]); }
  catch (error) { refusal = (error as Error).message; }
  assert.match(refusal, /destination URL/i);
  assert.match(refusal, /duplicate content/i);
});

test("a campid the ad account already holds is refused at preview, before the launch reaches Meta", () => {
  const taken = ["rlapple02", "somebody-else"];
  const input = draft({ campid_start: "rlapple01", campaigns_per_account: 3, content_per_campaign: 1, content: [fb("111_1"), fb("111_2"), fb("111_3")] });
  assert.deepEqual(metaDraftIssues(input, [account()], taken).map(issue => issue.code), ["campidTaken"]);
  assert.throws(() => buildLaunchPlan(input, [account()], undefined, taken), /already has a campaign named rlapple02/);
  assert.equal(metaDraftIssues(input, [account()], ["rlapple09"]).length, 0);
  assert.equal(buildLaunchPlan(input, [account()], undefined, ["rlapple09"]).rows.length, 3);
});

test("the next round starts from the campid after the last one this round stamped", () => {
  assert.equal(nextCampidStart("rlapple01", 3), "rlapple04");
  assert.equal(nextCampidStart("rlapple09", 2), "rlapple11");
  assert.equal(nextCampidStart("gravy", 4), "gravy05");
  assert.equal(nextCampidStart("", 3), null);
  assert.equal(nextCampidStart(null, 3), null);
  assert.equal(nextCampidStart("rlapple01", 0), null);
});

test("every reason a Meta draft cannot run arrives at once, not one refused preview at a time", () => {
  const broken = draft({
    content: [{ kind: "spark", value: "SPARK-1" }, fb("not-a-reference"), ig("not-a-media-id")],
    content_per_campaign: 3, total_budget_cents: 150, campid_start: "!",
    meta_settings: { ...defaultLaunchDraft("meta").meta_settings, placements: both,
      start_time: "2030-01-08T00:00:00.000Z", end_time: "2030-01-01T00:00:00.000Z",
      bid_strategy: "LOWEST_COST_WITH_BID_CAP", bid_cents: null },
  });
  const codes = metaDraftIssues(broken, [account({ page_id: null, instagram_id: null })]).map(issue => issue.code);
  for (const expected of ["contentSpark", "contentFacebookRef", "contentInstagramRef", "accountPage", "accountInstagram", "schedule", "bid", "adSetMinimum", "campidShape"])
    assert.ok(codes.includes(expected), `missing ${expected} in ${codes.join(", ")}`);
  assert.equal(new Set(codes).size, codes.length, "each reason is listed once");
  let refusal = "";
  try { buildLaunchPlan(broken, [account({ page_id: null, instagram_id: null })]); }
  catch (error) { refusal = (error as Error).message; }
  assert.match(refusal, /Facebook Page/);
  assert.match(refusal, /Instagram identity/);
  assert.equal(metaDraftIssues(draft(), [account()]).length, 0);
});

test("an end time already behind the clock is refused before approval, not by Meta after the campaign exists", () => {
  const settings = defaultLaunchDraft("meta").meta_settings;
  const day = 86_400_000;
  const stale = draft({ meta_settings: { ...settings, start_time: new Date(Date.now() - 8 * day).toISOString(), end_time: new Date(Date.now() - day).toISOString() } });
  const codes = metaDraftIssues(stale, [account()]).map(issue => issue.code);
  assert.ok(codes.includes("scheduleEnded"), codes.join(", "));
  assert.ok(!codes.includes("schedule"), "the window itself is well-formed; only its place in time is wrong");
  assert.throws(() => buildLaunchPlan(stale, [account()]), /end time has passed/);
  // A start that has slipped into the past is the driver's to move up; the end still lies ahead.
  const slipped = draft({ meta_settings: { ...settings, start_time: new Date(Date.now() - day).toISOString(), end_time: new Date(Date.now() + day).toISOString() } });
  assert.equal(metaDraftIssues(slipped, [account()]).length, 0);
});
