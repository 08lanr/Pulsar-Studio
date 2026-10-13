// Creator accounts in the data layer (decision 2026-10-12): the same rules in
// both backends. The Supabase backend runs against a small in-memory stand-in
// for the PostgREST client that enforces 0024's unique constraints and the
// revision-conditional update, so the CAS path the live database takes is the
// one under test, not a fixture copy of it.

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { systemSession } from "@/lib/auth";
import { getData } from "@/lib/data";
import { resetCreatorFixture, setCreatorAuditForTests, setCreatorDbForTests } from "@/lib/data/creators";
import { EMPTY_PERSONA } from "@/lib/creators/types";
import { admin, editor, producer } from "./creator-seed";

type Row = Record<string, unknown>;
const UNIQUE: Record<string, string[][]> = {
  creator_accounts: [["handle"], ["instagram_id"]],
  creator_media: [["account_id", "sha256"]],
  creator_posts: [["ig_media_id"]],
  creator_comments: [["ig_comment_id"], ["reply_ig_id"]],
  creator_stats: [["account_id", "scope", "day"]],
};
const PREFIX: Record<string, string> = { creator_accounts: "cr", creator_media: "cm", creator_posts: "cp" };

/** Just enough of supabase-js for lib/data/creators.ts: select/eq/order, insert, update…eq…eq, upsert, maybeSingle. */
function fakeSupabase() {
  const tables = new Map<string, Row[]>();
  const rows = (t: string) => tables.get(t) ?? (tables.set(t, []), tables.get(t)!);
  const clash = (t: string, row: Row, ignoreId?: unknown) => (UNIQUE[t] ?? []).some(cols => rows(t).some(r => r.id !== ignoreId
    && cols.every(c => r[c] !== null && r[c] !== undefined && r[c] === row[c])));
  function from(table: string) {
    let op: "select" | "insert" | "update" | "upsert" = "select";
    let payload: Row | null = null;
    const eqs: [string, unknown][] = [];
    let onConflict: string[] = [];
    const run = (): { data: unknown; error: { code: string } | null } => {
      const list = rows(table);
      if (op === "select") return { data: list.filter(r => eqs.every(([k, v]) => r[k] === v)).map(r => structuredClone(r)), error: null };
      if (op === "insert") {
        const row = { created_at: new Date().toISOString(), ...(PREFIX[table] ? { external_id: `${PREFIX[table]}_${randomUUID().slice(0, 13)}` } : {}), ...payload! };
        if (clash(table, row)) return { data: null, error: { code: "23505" } };
        list.push(structuredClone(row)); return { data: [structuredClone(row)], error: null };
      }
      if (op === "upsert") {
        const existing = list.find(r => onConflict.every(c => r[c] === payload![c]));
        const row = { ...(existing ?? { id: randomUUID(), created_at: new Date().toISOString() }), ...payload! };
        if (existing) Object.assign(existing, row); else list.push(row);
        return { data: [structuredClone(row)], error: null };
      }
      const target = list.filter(r => eqs.every(([k, v]) => r[k] === v));
      if (!target.length) return { data: [], error: null };
      if (clash(table, payload!, target[0].id)) return { data: null, error: { code: "23505" } };
      Object.assign(target[0], structuredClone(payload!));
      return { data: [structuredClone(target[0])], error: null };
    };
    const q = {
      select: () => q,
      eq: (k: string, v: unknown) => { eqs.push([k, v]); return q; },
      order: () => q,
      insert: (row: Row) => { op = "insert"; payload = row; return q; },
      update: (row: Row) => { op = "update"; payload = row; return q; },
      upsert: (row: Row, opts: { onConflict: string }) => { op = "upsert"; payload = row; onConflict = opts.onConflict.split(","); return q; },
      maybeSingle: async () => { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }; },
      then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => Promise.resolve(run()).then(resolve, reject),
    };
    return q;
  }
  return { client: { schema: () => ({ from }) } as unknown as SupabaseClient, tables };
}

const saved = { DATA_SOURCE: process.env.DATA_SOURCE, FIXTURE_PERSIST: process.env.FIXTURE_PERSIST };
const audits: string[] = [];
beforeEach(() => {
  process.env.FIXTURE_PERSIST = "off";
  resetCreatorFixture();
  audits.length = 0;
  setCreatorAuditForTests(async (_s, action) => { audits.push(action); });
});
afterEach(() => {
  setCreatorDbForTests(null); setCreatorAuditForTests(null);
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

const backends: [string, () => void][] = [
  ["fixture", () => { process.env.DATA_SOURCE = "fixture"; }],
  ["supabase", () => { process.env.DATA_SOURCE = "supabase"; setCreatorDbForTests(fakeSupabase().client); }],
];
const input = (handle = "chloelin.diary", ig = "17841416495486333") => ({
  handle, display_name: "Chloe Lin", instagram_id: ig, page_id: null, persona: { ...EMPTY_PERSONA, summary: "x" },
});

for (const [name, use] of backends) {
  test(`${name}: accounts upsert by handle, refuse producers and editors' writes, and CAS their revision`, async () => {
    use();
    const data = getData();
    const { account, created } = await data.upsertCreatorAccount(admin(), input("@ChloeLin.Diary"));
    assert.equal(created, true);
    assert.equal(account.handle, "chloelin.diary");
    assert.match(account.external_id, /^cr_/);
    assert.equal(account.settings.reply_delay_min, 4);
    const again = await data.upsertCreatorAccount(admin(), { ...input(), display_name: "Chloe" });
    assert.equal(again.created, false);
    assert.equal(again.account.display_name, "Chloe");
    assert.equal(again.account.revision, 2);
    await assert.rejects(data.upsertCreatorAccount(admin(), input("chloelin.diary", "17841400000000999")), /recorded with Instagram id/);
    await assert.rejects(data.upsertCreatorAccount(editor(), input("other")), /administrator/);
    await assert.rejects(data.listCreatorAccounts(producer()), /not found/);
    await assert.rejects(data.getCreatorAccount(producer(), account.id), /not found/);
    assert.equal((await data.getCreatorAccount(editor(), "@chloelin.diary")).id, account.id);
    // Two writers at revision 2: the second loses.
    await data.updateCreatorAccount(admin(), account.id, 2, { settings: { auto_reply: false } });
    await assert.rejects(data.updateCreatorAccount(admin(), account.id, 2, { settings: { auto_reply: true } }), /changed/);
    assert.equal((await data.getCreatorAccount(admin(), account.id)).settings.auto_reply, false);
    await assert.rejects(data.updateCreatorAccount(admin(), account.id, 3, { settings: { reply_delay_min: 50, reply_delay_max: 10 } }), /minimum/);
    await assert.rejects(data.updateCreatorAccount(admin(), account.id, 3, { settings: { timezone: "Mars/Olympus" } }), /time zone/);
    assert.ok(audits.includes("creator_account_created"));
  });

  test(`${name}: media dedupes by hash, posts and comments are revision-checked, engine fields are the worker's`, async () => {
    use();
    const data = getData();
    const { account } = await data.upsertCreatorAccount(admin(), input());
    const media = {
      account_id: account.id, kind: "image" as const, path: `creators/${account.id}/abc.jpg`, sha256: "a".repeat(64), stored_sha256: "b".repeat(64),
      width: 1080, height: 1350, duration_s: null, mime: "image/jpeg", bytes: 10, description: "coffee", tags: ["Cafe", "cafe"], filename: "x.png",
    };
    const first = await data.createCreatorMedia(editor(), media);
    assert.equal(first.created, true);
    assert.deepEqual(first.media.tags, ["cafe"]);
    const dup = await data.createCreatorMedia(editor(), { ...media, path: `creators/${account.id}/other.jpg` });
    assert.equal(dup.created, false);
    assert.equal(dup.media.id, first.media.id);
    await assert.rejects(data.createCreatorMedia(editor(), { ...media, sha256: "c".repeat(64), path: "elsewhere/x.jpg" }), /creators\//);
    const described = await data.updateCreatorMedia(editor(), first.media.id, 1, { description: "a latte" });
    await assert.rejects(data.updateCreatorMedia(editor(), first.media.id, 1, { description: "stale" }), /changed/);
    assert.equal(described.description, "a latte");

    const post = await data.createCreatorPost(admin(), { account_id: account.id, kind: "image", media_ids: [first.media.id], caption: "hi", scheduled_at: null, status: "draft", source: "agent" });
    assert.match(post.external_id, /^cp_/);
    await assert.rejects(data.updateCreatorPost(admin(), post.id, 1, { step: "processing" }), /worker/);
    const sys = systemSession();
    const a = await data.updateCreatorPost(sys, post.id, 1, { status: "publishing" });
    await assert.rejects(data.updateCreatorPost(sys, post.id, 1, { status: "cancelled" }), /changed/);
    const published = await data.updateCreatorPost(sys, post.id, a.revision, { status: "published", ig_media_id: "1790001" });
    await assert.rejects(data.updateCreatorPost(sys, post.id, published.revision, { status: "failed" }), /cannot be reopened/);
    await assert.rejects(data.updateCreatorPost(admin(), post.id, published.revision, { caption: "edit" }), /cannot be edited/);
    // One Instagram media is one post row.
    const other = await data.createCreatorPost(admin(), { account_id: account.id, kind: "image", media_ids: [first.media.id], caption: "x", scheduled_at: null, status: "draft", source: "human" });
    await assert.rejects(data.updateCreatorPost(sys, other.id, 1, { ig_media_id: "1790001" }), /already records/);

    const c = { account_id: account.id, post_id: post.id, ig_media_id: "1790001", ig_comment_id: "17900000000000042", parent_ig_id: null, username: "fan", text: "so pretty", commented_at: new Date().toISOString() };
    await assert.rejects(data.recordCreatorComment(admin(), c), /worker/);
    const rec = await data.recordCreatorComment(sys, c);
    assert.equal(rec.created, true);
    assert.equal((await data.recordCreatorComment(sys, { ...c, text: "edited later" })).created, false);
    const drafted = await data.updateCreatorComment(sys, rec.comment.id, 1, { decision: "reply", reply_text: "thank you 🤍", status: "drafted" });
    await assert.rejects(data.updateCreatorComment(sys, rec.comment.id, 1, { status: "skipped" }), /changed/);
    const sent = await data.updateCreatorComment(sys, rec.comment.id, drafted.revision, { status: "sent", reply_ig_id: "17900000000000043" });
    await assert.rejects(data.updateCreatorComment(sys, rec.comment.id, sent.revision, { reply_ig_id: "17900000000000044" }), /already has a reply/);
    await assert.rejects(data.updateCreatorComment(sys, rec.comment.id, sent.revision, { status: "drafted" }), /already answered/);
  });

  test(`${name}: one stats row per account, scope and day; a second read replaces it`, async () => {
    use();
    const data = getData();
    const { account } = await data.upsertCreatorAccount(admin(), input());
    const sys = systemSession();
    const row = { account_id: account.id, scope: "account", ig_media_id: null, post_id: null, day: "2026-10-12", followers_count: 10, follows_count: null, media_count: 1,
      reach: null, profile_views: null, follows_gained: null, likes: null, comments: null, saved: null, shares: null, views: null, total_interactions: null, read_at: new Date().toISOString() };
    await data.recordCreatorStat(sys, row);
    await data.recordCreatorStat(sys, { ...row, followers_count: 12 });
    await data.recordCreatorStat(sys, { ...row, scope: "1790001", ig_media_id: "1790001", reach: 40 });
    const stats = await data.listCreatorStats(admin(), account.id);
    assert.equal(stats.length, 2);
    assert.equal(stats.find(s => s.scope === "account")!.followers_count, 12);
    assert.equal(stats.find(s => s.scope === "account")!.reach, null, "unknown stays null");
    await assert.rejects(data.recordCreatorStat(sys, { ...row, scope: "account", ig_media_id: "1" }), /account row/);
    await assert.rejects(data.recordCreatorStat(admin(), row), /worker/);
  });
}
