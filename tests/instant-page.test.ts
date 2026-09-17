import assert from "node:assert/strict";
import test from "node:test";
import { createInstantPageDraft, customizeSalesPage, loadSalesMasterSnapshot, publishInstantPage,
  InstantPageCreateNotSentError, InstantPageCreateRejectedError, InstantPageCreateUncertainError,
  type InstantPageDependencies } from "@/lib/tiktok/instant-page";
import { SALES_MASTER_SHA256 } from "@/lib/tiktok/instant-page-master";

test("Sales master copy is pinned and campaign customization changes only the cloned CTA", () => {
  const master = loadSalesMasterSnapshot();
  assert.equal(master.sha256, SALES_MASTER_SHA256);
  const original = JSON.stringify(master.page_data);
  const changed = customizeSalesPage(master, { trackingUrl: "https://example.com/watch?source=studio&campid=summer01#offer",
    buttonText: "Watch now", background: "white", handCursor: true });
  assert.equal(JSON.stringify(master.page_data), original);
  assert.match(JSON.stringify(changed), /campid=summer01/);
  assert.match(JSON.stringify(changed), /Watch now/);
  assert.throws(() => customizeSalesPage(master, { trackingUrl: "javascript:alert(1)" }), /HTTP\(S\)/);
  assert.throws(() => customizeSalesPage(master, { trackingUrl: "https://example.com/watch" }), /campid/);
  assert.throws(() => customizeSalesPage({ ...master, template_id: "unapproved" },
    { trackingUrl: "https://example.com/watch?campid=one" }), /approved Sales capture/);
});

test("fixture Instant Page creation is deterministic and never calls a live endpoint", async () => {
  process.env.DATA_SOURCE = "fixture";
  process.env.TIKTOK_MODE = "production";
  delete process.env.TIKTOK_LIVE;
  const master = loadSalesMasterSnapshot();
  let guards = 0;
  const input = { advertiserId: "fixture-account", pageName: "summer-a1b2-001",
    trackingUrl: "https://example.com/watch?campid=summer-a1b2-001", masterSnapshot: master,
    assertActive: async () => { guards++; } };
  const first = await createInstantPageDraft(input);
  assert.match(first, /^fake-tip-/);
  assert.equal(await createInstantPageDraft(input), first);
  await publishInstantPage({ advertiserId: input.advertiserId, pageId: first, assertActive: input.assertActive });
  assert.equal(guards, 0, "fixture path has no external write to authorize");
});

const master = loadSalesMasterSnapshot();
const input = { advertiserId: "1234567890123456789", pageName: "summer-a1b2-001",
  trackingUrl: "https://example.com/watch?campid=summer-a1b2-001", masterSnapshot: master };
function production(request: (url: string, init: RequestInit) => Promise<Response>, events: string[]): InstantPageDependencies {
  return { mode: () => "production", accessToken: () => "oauth-secret",
    marketingPost: async (pathname, token, body) => {
      events.push("mint");
      assert.equal(pathname, "/oauth2/access_token/tip_sdk/create/");
      assert.equal(token, "oauth-secret");
      assert.deepEqual(body, { advertiser_id: input.advertiserId });
      return { code: 0, message: "OK", data: { tip_sdk_access_token: "tip-secret" } };
    }, request: request as typeof fetch };
}

test("production adapter guards mint/create/publish and sends campaign CTA without leaking tokens", async () => {
  const events: string[] = [];
  const deps = production(async (url, init) => {
    events.push("builder");
    assert.equal((init.headers as Record<string, string>)["ix-access-token"], "tip-secret");
    assert.equal((init.headers as Record<string, string>)["x-csrftoken"], (init.headers as Record<string, string>).cookie.replace("csrftoken=", ""));
    const body = JSON.parse(String(init.body));
    assert.equal(body.account_id, input.advertiserId);
    if (url.endsWith("/create/")) {
      assert.equal(body.title, input.pageName);
      assert.equal(body.template_id, master.template_id);
      assert.match(body.data, /campid=summer-a1b2-001/);
      return Response.json({ code: 0, data: { page_id: "9876543210987654321" } });
    }
    assert.match(url, /\/publish\/9876543210987654321\/$/);
    return Response.json({ code: 0 });
  }, events);
  const guard = async () => { events.push("guard"); };
  const pageId = await createInstantPageDraft({ ...input, assertActive: guard, beforeCreate: async () => { events.push("checkpoint"); } }, deps);
  assert.equal(pageId, "9876543210987654321");
  assert.deepEqual(events, ["guard", "mint", "guard", "checkpoint", "guard", "builder"]);
  events.length = 0;
  await publishInstantPage({ advertiserId: input.advertiserId, pageId, assertActive: guard }, deps);
  assert.deepEqual(events, ["guard", "mint", "guard", "builder"]);
});

test("create refuses definite failures and quarantines uncertain outcomes without token disclosure", async () => {
  const responses = [
    async () => { throw new Error("network dropped tip-secret"); },
    async () => new Response("server error", { status: 503 }),
    async () => new Response("not json"),
    async () => Response.json({ code: 0, data: {} }),
    async () => Response.json({ code: 0, data: { page_id: { unexpected: true } } }),
  ];
  for (const response of responses) {
    const deps = production(async () => response(), []);
    await assert.rejects(createInstantPageDraft({ ...input, assertActive: async () => {} }, deps), error => {
      assert.ok(error instanceof InstantPageCreateUncertainError);
      assert.doesNotMatch((error as Error).message, /tip-secret|oauth-secret/);
      return true;
    });
  }
  const rejected = production(async () => Response.json({ code: 401, message: "Invalid thumbnail; tip-secret", data: { err_msg: "OAuth oauth-secret expired" } }, { status: 403 }), []);
  await assert.rejects(createInstantPageDraft({ ...input, assertActive: async () => {} }, rejected), error => {
    assert.ok(error instanceof InstantPageCreateRejectedError);
    assert.match((error as Error).message, /HTTP 403, code 401: Invalid thumbnail/);
    assert.doesNotMatch((error as Error).message, /tip-secret|oauth-secret/);
    return true;
  });
  const publishRejected = production(async () => Response.json({ code: 429, message: "Rate limited tip-secret oauth-secret" }, { status: 429 }), []);
  await assert.rejects(publishInstantPage({ advertiserId: input.advertiserId, pageId: "9876543210987654321", assertActive: async () => {} }, publishRejected), error => {
    assert.match((error as Error).message, /HTTP 429, code 429: Rate limited/);
    assert.doesNotMatch((error as Error).message, /tip-secret|oauth-secret/);
    return true;
  });
  let builderCalled = false;
  const stopped = production(async () => { builderCalled = true; return Response.json({ code: 0 }); }, []);
  await assert.rejects(createInstantPageDraft({ ...input, assertActive: async () => {}, beforeCreate: async () => { throw new Error("stop"); } }, stopped), InstantPageCreateNotSentError);
  assert.equal(builderCalled, false);
  let guards = 0;
  let checkpointed = false;
  await assert.rejects(createInstantPageDraft({ ...input,
    assertActive: async () => { if (++guards === 3) throw new Error("lease revoked"); },
    beforeCreate: async () => { checkpointed = true; },
  }, stopped), InstantPageCreateNotSentError);
  assert.equal(checkpointed, true, "the intent may already have been checkpointed when the final guard refuses the write");
  assert.equal(builderCalled, false, "a refused write is definitively safe to retry after the intent is cleared");
});
