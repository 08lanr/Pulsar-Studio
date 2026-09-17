import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { FIXTURE_PRODUCER_ID, fixtureSession, systemSession, type Session } from "@/lib/auth";
import { getData } from "@/lib/data";
import { resetFixtureStore } from "@/lib/data/fixture";
import { launchHash, resetLaunchFixture } from "@/lib/data/launch";
import { buildLaunchPlan, defaultLaunchDraft, parseContentList, splitBudget } from "@/lib/launch/plan";
import { defaultLaunchSettings } from "@/lib/tiktok/settings";
import { approvedCampaignBudget } from "@/lib/launch/budget";
import type { LaunchConnection, LaunchDraft, LaunchRun } from "@/lib/launch/types";
import { resetFakeTikTok } from "@/lib/tiktok/fake";

const producer = () => fixtureSession("producer");
const admin = () => fixtureSession("staff");
const reviewer = (): Session => ({ ...producer(), producerRole: "reviewer" });
const viewer = (): Session => ({ ...producer(), producerRole: "viewer" });
const staffEditor = (): Session => ({ ...admin(), staffRole: "editor" });
const hasCode = (code: string) => (error: unknown) => (error as { code?: string }).code === code;

beforeEach(() => {
  process.env.DATA_SOURCE = "fixture";
  process.env.FIXTURE_SEED = "empty";
  process.env.FIXTURE_PERSIST = "off";
  delete process.env.TIKTOK_LIVE;
  resetFixtureStore(); resetLaunchFixture(); resetFakeTikTok();
});

function connection(id: string, provider: "tiktok" | "meta" = "tiktok"): LaunchConnection {
  return { id, producer_id: FIXTURE_PRODUCER_ID, provider, advertiser_id: `account-${id}`, name: `Account ${id}`, currency: "USD", timezone: "America/Los_Angeles",
    page_id: provider === "meta" ? "111" : null, instagram_id: provider === "meta" ? "222" : null,
    business_id: "business-1", assigned_by: admin().userId, verified_at: "2026-09-16T00:00:00.000Z", enabled: true };
}
function draft(accounts = ["one", "two"]): LaunchDraft {
  return { ...defaultLaunchDraft(), tiktok_settings: defaultLaunchSettings(), daily_budget_cents: null, name: "Two-account test", account_ids: accounts, campaigns_per_account: 2, content_per_campaign: 2,
    content: Array.from({ length: accounts.length * 4 }, (_, i) => ({ kind: "spark", value: `spark-${i + 1}` })),
    destination_url: "https://crazydramas.com/watch", total_budget_cents: 40003 };
}
test("new TikTok drafts suggest five Spark codes per campaign and Meta drafts one item", () => {
  assert.equal(defaultLaunchDraft("tiktok").content_per_campaign, 5);
  assert.equal(defaultLaunchDraft("meta").content_per_campaign, 1);
});
async function assignedDraft(opts: { owner?: string; provider?: "tiktok" | "meta"; count?: number } = {}) {
  const data = getData();
  const ids: string[] = [];
  for (let i = 1; i <= (opts.count ?? 2); i++) {
    const { id: _id, assigned_by: _assigned, verified_at: _verified, ...input } = connection(`test-${i}`, opts.provider);
    const result = await data.assignLaunchConnection(admin(), { ...input, producer_id: opts.owner ?? FIXTURE_PRODUCER_ID });
    ids.push(result.id);
  }
  return { data, input: draft(ids) };
}
async function approvedRun(): Promise<LaunchRun> {
  const { data, input } = await assignedDraft();
  const saved = await data.saveLaunchDraft(reviewer(), input);
  return data.submitLaunchRun(producer(), saved.id, saved.revision);
}

test("unique allocation fans codes across accounts with an exact whole-cent launch ceiling", () => {
  const input = draft();
  const plan = buildLaunchPlan(input, [connection("one"), connection("two")]);
  assert.equal(plan.account_count, 2);
  assert.equal(plan.campaign_count, 4);
  assert.deepEqual(plan.rows.map(r => r.budget_cents), [10001, 10001, 10001, 10000]);
  assert.equal(plan.rows.reduce((sum, r) => sum + r.budget_cents, 0), input.total_budget_cents);
  assert.deepEqual(plan.rows.map(r => r.connection_id), ["one", "one", "two", "two"]);
  assert.deepEqual(plan.rows.map(r => r.content.map(c => c.value)), [["spark-1", "spark-2"], ["spark-3", "spark-4"], ["spark-5", "spark-6"], ["spark-7", "spark-8"]]);
  plan.rows[0].content[0].value = "changed";
  assert.equal(input.content[0].value, "spark-1", "preview content is an independent snapshot");
});

test("saved preview campids are stable, unique across rounds, and frozen on approval", async () => {
  const { data, input } = await assignedDraft();
  input.name = "Xinghai Summer";
  input.destination_url = "https://example.com/watch?source=studio&campid=old#trailer";
  const saved = await data.saveLaunchDraft(producer(), input);
  const preview = await data.previewLaunchRun(producer(), saved.id);
  const ids = preview.rows.map(row => row.campid);
  assert.equal(new Set(ids).size, preview.campaign_count);
  assert.ok(preview.rows.every(row => row.name === row.campid));
  assert.ok(preview.rows.every(row => row.campid?.startsWith("xinghai-summer-")));
  for (const row of preview.rows) {
    const url = new URL(row.tracking_url!);
    assert.equal(url.searchParams.get("source"), "studio");
    assert.equal(url.searchParams.get("campid"), row.campid);
    assert.equal(url.hash, "#trailer");
  }
  assert.deepEqual((await data.previewLaunchRun(producer(), saved.id)).rows.map(row => row.campid), ids);
  const approved = await data.submitLaunchRun(producer(), saved.id, saved.revision);
  assert.deepEqual(approved.campaigns.map(row => row.campid), ids);
  assert.deepEqual(approved.campaigns.map(row => row.name), ids);
  assert.deepEqual(approved.campaigns.map(row => row.tracking_url), preview.rows.map(row => row.tracking_url));
  const changed = structuredClone(approved);
  changed.campaigns[0].tracking_url = "https://example.com/changed";
  assert.throws(() => approvedCampaignBudget(changed, changed.campaigns[0]), /approval is missing or changed/);
  const renamed = structuredClone(approved);
  renamed.campaigns[0].campid = "foreign-campaign-id";
  assert.throws(() => approvedCampaignBudget(renamed, renamed.campaigns[0]), /approval is missing or changed/);
  const next = await data.newLaunchRound(producer(), approved.id);
  const nextPreview = await data.previewLaunchRun(producer(), next.id);
  assert.ok(nextPreview.rows.every(row => !ids.includes(row.campid)));
});

test("shared allocation reuses the same codes everywhere without requiring files or a clip library", () => {
  const input = { ...draft(), allocation: "shared" as const, content: [{ kind: "spark" as const, value: "manual-code-one" }, { kind: "spark" as const, value: "manual-code-two" }] };
  const plan = buildLaunchPlan(input, [connection("one"), connection("two")]);
  assert.equal(plan.content_count, 2);
  for (const row of plan.rows) assert.deepEqual(row.content.map(c => c.value), ["manual-code-one", "manual-code-two"]);
  plan.rows[0].content[0].value = "mutated";
  assert.equal(plan.rows[1].content[0].value, "manual-code-one");
  assert.throws(() => buildLaunchPlan({ ...input, allocation: "unique" }, [connection("one"), connection("two")]), /exactly 8/);
  assert.deepEqual(parseContentList(" one\n two,one\tthree "), ["one", "two", "three"]);
});

test("planned copies reserve lifetime shares and daily pacing preview covers every campaign", () => {
  const input = draft(); input.tiktok_settings.duplicate_copies = 2;
  const plan = buildLaunchPlan(input, [connection("one"), connection("two")]);
  assert.equal(plan.rows.reduce((n, r) => n + r.budget_cents, 0), 40003);
  assert.match(plan.warnings.join(" "), /planned ad group copies/);
  assert.throws(() => buildLaunchPlan({ ...input, total_budget_cents: 23999 }, [connection("one"), connection("two")]), /minimum/);
  input.daily_budget_cents = 6000;
  const daily = buildLaunchPlan(input, [connection("one"), connection("two")]);
  assert.deepEqual(daily.rows.map(r => r.daily_budget_cents), [6000, 6000, 6000, 6000]);
  assert.equal(daily.daily_total_cents, 24000);
  assert.throws(() => buildLaunchPlan({ ...input, daily_budget_cents: 5999 }, [connection("one"), connection("two")]), /minimum|at least \$20/);
});

test("planner refuses unassigned, disabled, foreign-platform and non-USD accounts", () => {
  const input = draft(["one"]);
  for (const bad of [[], [{ ...connection("one"), assigned_by: "" }], [{ ...connection("one"), enabled: false }], [connection("one", "meta")]]) {
    assert.throws(() => buildLaunchPlan(input, bad), /unassigned|unavailable|platform/);
  }
  assert.throws(() => buildLaunchPlan(input, [{ ...connection("one"), currency: "EUR" }]), /USD/);
  assert.throws(() => buildLaunchPlan({ ...input, account_ids: ["one", "one"] }, [connection("one")]), /only once/);
  assert.throws(() => buildLaunchPlan({ ...input, destination_url: "https://user:password@example.com" }, [connection("one")]), /without credentials/);
  assert.throws(() => splitBudget(1.5, 1), /Invalid budget/);
});

test("Meta posts require assigned identities and TikTok refuses uploaded-video launch content", () => {
  const input = { ...defaultLaunchDraft("meta"), account_ids: ["meta-one"], destination_url: "https://crazydramas.com/watch", content: [{ kind: "facebook_post" as const, value: "111_333" }] };
  assert.equal(buildLaunchPlan(input, [connection("meta-one", "meta")]).campaign_count, 1);
  assert.throws(() => buildLaunchPlan(input, [{ ...connection("meta-one", "meta"), page_id: null }]), /Facebook Page/);
  assert.throws(() => buildLaunchPlan({ ...input, content: [{ kind: "instagram_post", value: "333" }] }, [{ ...connection("meta-one", "meta"), instagram_id: null }]), /Instagram identity/);
  const spark = draft(["one"]);
  spark.content[0] = { kind: "video", value: "clip-id" };
  assert.throws(() => buildLaunchPlan(spark, [connection("one")]), /Spark codes/);
});

test("an approved Meta run carries its derived ad sets and its typed campids onto the campaign rows", async () => {
  const data = getData();
  const { id: _id, assigned_by: _assigned, verified_at: _verified, ...input } = connection("meta-one", "meta");
  const account = await data.assignLaunchConnection(admin(), { ...input, producer_id: FIXTURE_PRODUCER_ID });
  const meta: LaunchDraft = { ...defaultLaunchDraft("meta"), name: "Xinghai Meta", account_ids: [account.id],
    destination_url: "https://crazydramas.com/watch", content_per_campaign: 2, campid_start: "rlapple07",
    content: [{ kind: "facebook_post", value: "111_500" }, { kind: "instagram_post", value: "900500" }] };
  const saved = await data.saveLaunchDraft(producer(), meta);
  const preview = await data.previewLaunchRun(producer(), saved.id);
  assert.deepEqual(preview.rows[0].ad_sets?.map(set => [set.platform, set.budget_cents]), [["facebook", 25_000], ["instagram", 25_000]]);
  assert.equal(preview.rows[0].campid, "rlapple07");
  assert.equal(preview.rows[0].name, "rlapple07");
  assert.equal(new URL(preview.rows[0].tracking_url!).searchParams.get("campid"), "rlapple07");
  const approved = await data.submitLaunchRun(producer(), saved.id, saved.revision);
  assert.deepEqual(approved.campaigns[0].ad_sets?.map(set => set.content.map(item => item.value)), [["111_500"], ["900500"]]);
  assert.equal(approvedCampaignBudget(approved, approved.campaigns[0]), 50_000);
  const renamed = structuredClone(approved);
  renamed.campaigns[0].campid = "rlapple99";
  assert.throws(() => approvedCampaignBudget(renamed, renamed.campaigns[0]), /approval is missing or changed/);
});

test("reviewers save and preview, viewers read only, and only an approver or evidenced staff admin can submit", async () => {
  const { data, input } = await assignedDraft();
  await assert.rejects(data.saveLaunchDraft(viewer(), input), hasCode("forbidden"));
  const saved = await data.saveLaunchDraft(reviewer(), input);
  assert.equal((await data.previewLaunchRun(viewer(), saved.id)).campaign_count, 4);
  await assert.rejects(data.submitLaunchRun(reviewer(), saved.id, saved.revision), hasCode("forbidden"));
  await assert.rejects(data.submitLaunchRun(staffEditor(), saved.id, saved.revision, "Approval on behalf"), hasCode("forbidden"));
  await assert.rejects(data.submitLaunchRun(admin(), saved.id, saved.revision), /on-behalf authorization/);
  const submitted = await data.submitLaunchRun(producer(), saved.id, saved.revision);
  assert.equal(submitted.approved_by, producer().userId);
  assert.ok(submitted.snapshot_hash);
  assert.equal(submitted.campaigns.length, 4);
  assert.equal(submitted.status, "pending");
  const other = await data.saveLaunchDraft(reviewer(), input);
  const onBehalf = await data.submitLaunchRun(admin(), other.id, other.revision, "Producer approved in signed email 16 September");
  assert.equal(onBehalf.approval_note, "Producer approved in signed email 16 September");
  assert.equal(onBehalf.approved_by, admin().userId);
});

test("company boundaries hide foreign runs and reject foreign advertising accounts", async () => {
  const { data, input } = await assignedDraft();
  const saved = await data.saveLaunchDraft(producer(), input);
  const company = await data.createProducer(admin(), { name_zh: "另一家公司", name_en: "Other producer" });
  const other = fixtureSession("producer", company.id);
  await assert.rejects(data.getLaunchRun(other, saved.id), hasCode("not_found"));
  await assert.rejects(data.previewLaunchRun(other, saved.id), hasCode("not_found"));
  await assert.rejects(data.submitLaunchRun(other, saved.id, saved.revision), hasCode("not_found"));
  await assert.rejects(data.newLaunchRound(other, saved.id), hasCode("not_found"));
  await assert.rejects(data.saveLaunchDraft(other, input), /assigned accounts from this company/);
  assert.equal((await data.getLaunchWorkspace(other)).runs.length, 0);
  await assert.rejects(data.assignLaunchConnection(producer(), { ...connection("injected"), producer_id: FIXTURE_PRODUCER_ID }), hasCode("forbidden"));
});

test("stale revisions cannot overwrite a draft or approve a preview that changed", async () => {
  const { data, input } = await assignedDraft();
  const saved = await data.saveLaunchDraft(reviewer(), input);
  const outcomes = await Promise.allSettled([
    data.saveLaunchDraft(reviewer(), { ...input, name: "Edit one" }, { id: saved.id, expectedRevision: saved.revision }),
    data.saveLaunchDraft(reviewer(), { ...input, name: "Edit two" }, { id: saved.id, expectedRevision: saved.revision }),
  ]);
  assert.equal(outcomes.filter(v => v.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(v => v.status === "rejected").length, 1);
  await assert.rejects(data.submitLaunchRun(producer(), saved.id, saved.revision), /stale/);
  const current = await data.getLaunchRun(producer(), saved.id);
  const submissions = await Promise.all([
    data.submitLaunchRun(producer(), current.id, current.revision),
    data.submitLaunchRun(producer(), current.id, current.revision),
  ]);
  assert.deepEqual(submissions[0].campaigns.map(c => c.id), submissions[1].campaigns.map(c => c.id));
  await assert.rejects(data.saveLaunchDraft(producer(), input, { id: current.id, expectedRevision: submissions[0].revision }), /frozen/);
});

test("submission strips client file metadata, freezes account mapping and hashes the approved intent", async () => {
  const { data, input } = await assignedDraft();
  input.content[0] = { ...input.content[0], file_path: "C:/foreign/private.mp4", sha256: "client-controlled", creative_id: "foreign-creative" };
  const saved = await data.saveLaunchDraft(producer(), input);
  assert.equal(saved.draft.content[0].file_path, undefined);
  assert.equal(saved.draft.content[0].creative_id, undefined);
  const approved = await data.submitLaunchRun(producer(), saved.id, saved.revision);
  assert.equal(approved.snapshot_hash, launchHash(approved.draft, approved.connections!, approved.campaigns));
  assert.notEqual(approved.snapshot_hash, launchHash({ ...approved.draft, total_budget_cents: approved.draft.total_budget_cents + 1 }, approved.connections!));
  const frozen = approved.connections![0];
  await data.assignLaunchConnection(admin(), { ...frozen, name: "Renamed after approval", enabled: false });
  const fetched = await data.getLaunchRun(producer(), approved.id);
  assert.equal(fetched.snapshot_hash, approved.snapshot_hash);
  assert.equal(fetched.connections![0].name, frozen.name);
  assert.equal(fetched.connections![0].enabled, true);
});

test("new rounds preserve chosen sparks but require a new budget approval and fresh external objects", async () => {
  const original = await approvedRun();
  const data = getData();
  const next = await data.newLaunchRound(reviewer(), original.id);
  assert.notEqual(next.id, original.id);
  assert.equal(next.parent_run_id, original.id);
  assert.equal(next.round, 2);
  assert.equal(next.status, "draft");
  assert.equal(next.approved_by, null);
  assert.equal(next.approved_at, null);
  assert.equal(next.snapshot_hash, null);
  assert.deepEqual(next.campaigns, []);
  assert.deepEqual(next.draft.content, original.draft.content);
  await assert.rejects(data.submitLaunchRun(reviewer(), next.id, next.revision), hasCode("forbidden"));
  const signed = await data.submitLaunchRun(producer(), next.id, next.revision);
  assert.ok(signed.campaigns.every(c => !original.campaigns.some(old => old.id === c.id)));
  assert.ok(signed.campaigns.every(c => Object.keys(c.state).length === 0));
});

test("retry preserves successful campaigns, external ids and the original approval", async () => {
  const original = await approvedRun();
  const data = getData();
  const worker = systemSession();
  let claimed = (await data.claimLaunchRun(worker, original.id, "test-worker"))!;
  claimed.status = "failed"; claimed.error = "one row failed";
  claimed.campaigns[0].status = "done"; claimed.campaigns[0].state = { campaign_id: "existing-campaign", groups: [{ id: "existing-group" }] };
  claimed.campaigns[1].status = "failed"; claimed.campaigns[1].state = { campaign_id: "partial-campaign", posts: [{ code: "spark-3" }] }; claimed.campaigns[1].error = "temporary failure";
  claimed.campaigns[2].status = "failed"; claimed.campaigns[2].state = { desired_status: "ended", campaign_id: "ended-campaign" };
  claimed.lease_owner = null; claimed.lease_until = null;
  claimed = await data.updateLaunchRun(worker, claimed, "test-worker");
  await assert.rejects(data.retryLaunchRun(reviewer(), original.id), hasCode("forbidden"));
  const retried = await data.retryLaunchRun(producer(), original.id);
  assert.equal(retried.status, "pending");
  assert.equal(retried.snapshot_hash, original.snapshot_hash);
  assert.equal(retried.approved_by, original.approved_by);
  assert.equal(retried.campaigns[0].status, "done");
  assert.deepEqual(retried.campaigns[0].state, claimed.campaigns[0].state);
  assert.equal(retried.campaigns[1].status, "pending");
  assert.equal(retried.campaigns[1].error, null);
  assert.deepEqual(retried.campaigns[1].state, claimed.campaigns[1].state);
  assert.equal(retried.campaigns[2].state.desired_status, "ended");
  assert.equal(retried.campaigns[2].status, "failed");
});

test("pre-campid approved rows retain their original names and legacy signature on retry", async () => {
  const current = await approvedRun();
  const data = getData();
  const owner = "legacy-test-worker";
  const legacy = (await data.claimLaunchRun(systemSession(), current.id, owner))!;
  for (const campaign of legacy.campaigns) {
    delete campaign.campid;
    delete campaign.tracking_url;
    campaign.name = `${legacy.draft.name}-${campaign.index}-${legacy.external_id}-r${legacy.round}`;
  }
  legacy.snapshot_hash = launchHash(legacy.draft, legacy.connections!);
  legacy.status = "failed";
  legacy.campaigns[0].status = "failed";
  legacy.campaigns[0].error = "temporary provider error";
  legacy.lease_owner = null; legacy.lease_until = null;
  const stored = await data.updateLaunchRun(systemSession(), legacy, owner);
  assert.equal(approvedCampaignBudget(stored, stored.campaigns[0]), stored.campaigns[0].budget_cents);
  const retried = await data.retryLaunchRun(producer(), stored.id);
  assert.equal(retried.campaigns[0].name, legacy.campaigns[0].name);
  assert.equal(retried.campaigns[0].campid, undefined);
  assert.equal(retried.campaigns[0].tracking_url, undefined);
  assert.equal(retried.snapshot_hash, legacy.snapshot_hash);
});

test("worker leases reject browser identities, concurrent owners and stale checkpoints", async () => {
  const original = await approvedRun();
  const data = getData();
  await assert.rejects(data.claimLaunchRun(admin(), original.id, "browser-worker"), hasCode("forbidden"));
  const first = (await data.claimLaunchRun(systemSession(), original.id, "worker-one"))!;
  assert.ok(first);
  assert.equal(await data.claimLaunchRun(systemSession(), original.id, "worker-two"), null);
  const saved = await data.updateLaunchRun(systemSession(), { ...first, status: "running" }, "worker-one");
  assert.ok(saved.revision > first.revision);
  await assert.rejects(data.updateLaunchRun(systemSession(), first, "worker-one"), /state changed/);
  await assert.rejects(data.updateLaunchRun(systemSession(), saved, "worker-two"), /lease lost/);
});
