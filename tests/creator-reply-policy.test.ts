// The comment rules (decision 2026-10-12): a table of comments and what Studio
// does with each, before any model sees them, and the guard every reply passes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { preFilter, replyDueAt, replyProblem, type PolicyDecision } from "@/lib/creators/reply-policy";

const now = new Date("2026-10-12T20:00:00Z");
const decide = (text: string, over: Partial<Parameters<typeof preFilter>[0]> = {}) => preFilter({
  text, username: "a_fan", own_username: "chloelin.diary", parent_ig_id: null, commented_at: "2026-10-12T19:00:00Z",
  now, window_days: 14, seed: "17900000000000001", ...over,
});

const TABLE: [string, PolicyDecision, RegExp?][] = [
  // ordinary comments go to the model
  ["this light is so pretty, where is this?", "llm"],
  ["love the coat!! where's it from", "llm"],
  ["qué bonita foto", "llm"],
  ["sf fog never misses", "llm"],
  // emoji only: a short emoji back
  ["😍😍", "reply", /emoji/],
  ["🔥", "reply"],
  ["🤍 !!", "reply"],
  // tags and spam: skip
  ["@bestie_jo", "skip", /tags a friend/],
  ["@bestie_jo 😂", "skip", /tags a friend/],
  ["check out my page for collabs", "skip", /promotion/],
  ["Promote it on @growthpage", "skip", /promotion/],
  ["get followers at www.cheapfollows.com", "skip", /link/],
  ["https://bit.ly/abc", "skip", /link/],
  ["   ", "skip", /empty/],
  // flags: a person looks, Studio never answers
  ["are you real?", "flag", /real/],
  ["r u a bot", "flag", /real/],
  ["this is so obviously AI", "flag", /real/],
  ["is this real or photoshopped", "flag", /real/],
  ["catfish lol", "flag", /real/],
  ["you're so sexy", "flag", /sexual/],
  ["send nudes", "flag", /sexual/],
  ["🍑🍑", "flag", /sexual/],
  ["i'm 15 and you're my idol", "flag", /minor/],
  ["my 14 year old sister loves you", "flag", /minor/],
  ["ugly", "flag", /hostile/],
  ["kys", "flag", /hostile/],
  ["let's meet up sometime", "flag", /meet/],
  ["want to grab a coffee with me?", "flag", /meet/],
  ["what's your snapchat", "flag", /contact/],
  ["can i get your number", "flag", /contact/],
  ["check your dms", "flag", /DM/],
  ["dm me babe", "flag", /DM/],
  ["any stock tips? what do you invest in", "flag", /money/],
  ["send me $50 on venmo", "flag", /money/],
];

test("the comment table: every row gets its decision", () => {
  for (const [text, decision, reason] of TABLE) {
    const got = decide(text);
    assert.equal(got.decision, decision, `${JSON.stringify(text)} → ${got.decision} (${got.reason})`);
    if (reason) assert.match(got.reason, reason, text);
  }
});

test("the account's own words, thread replies and old comments are skipped", () => {
  assert.equal(decide("thank you!", { username: "chloelin.diary" }).decision, "skip");
  assert.equal(decide("thank you!", { username: "@ChloeLin.Diary" }).decision, "skip");
  assert.match(decide("same!!", { parent_ig_id: "179" }).reason, /thread/);
  assert.match(decide("so cute", { commented_at: "2026-09-01T00:00:00Z" }).reason, /reply window/);
});

test("an emoji reply is chosen deterministically per comment and passes the reply guard", () => {
  const a = decide("😍", { seed: "1" }), b = decide("😍", { seed: "1" });
  assert.equal(a.reply_text, b.reply_text);
  assert.equal(replyProblem(a.reply_text!), null);
});

test("the reply guard refuses links, hashtags, CrazyDramas, claims about what she is, employers and offers", () => {
  assert.equal(replyProblem("haha thank you, it's a little spot in hayes valley 🤍"), null);
  assert.equal(replyProblem("gracias, es en sf 🤍"), null);
  const bad: [string, RegExp][] = [
    ["", /empty/],
    ["a".repeat(151), /longer/],
    ["one. two. three. four.", /one short sentence/],
    ["see more at chloe.com", /link/],
    ["thanks! #sf", /hashtag/],
    ["thanks @jo", /mentions an account/],
    ["watch my show on CrazyDramas", /CrazyDramas/],
    ["i'm a real person haha", /what she is/],
    ["i'm not a bot i promise", /what she is/],
    ["as an AI i can't say", /what she is/],
    ["i work at goldman so it's busy", /employer/],
    ["i'm a CFA charterholder", /employer/],
    ["dm me and i'll tell you", /offers/],
  ];
  for (const [reply, why] of bad) assert.match(replyProblem(reply) ?? "", why, reply);
});

test("a reply is due after a delay inside the account's window, never before the comment", () => {
  const due = replyDueAt("2026-10-12T19:59:00Z", now, 4, 45, () => 0.5);
  assert.equal(Date.parse(due) - now.getTime(), Math.round(24.5 * 60_000));
  const lo = replyDueAt("2026-10-12T19:00:00Z", now, 4, 45, () => 0);
  assert.equal(Date.parse(lo) - now.getTime(), 4 * 60_000);
  const future = replyDueAt("2026-10-12T21:00:00Z", now, 4, 4, () => 0);
  assert.equal(due > now.toISOString(), true);
  assert.equal(Date.parse(future), Date.parse("2026-10-12T21:04:00Z"));
});
