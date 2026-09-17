import assert from "node:assert/strict";
import test from "node:test";
import { magicEmailFailure } from "../lib/auth-magic-error";

test("magic email failures disclose operational failures but mask account errors", () => {
  assert.equal(magicEmailFailure({ status: 429 }), "rate_limited");
  assert.equal(magicEmailFailure({ code: "email_rate_limit_exceeded" }), "rate_limited");
  assert.equal(magicEmailFailure({ code: "over_email_send_rate_limit" }), "rate_limited");
  assert.equal(magicEmailFailure({ status: 503 }), "unavailable");
  assert.equal(magicEmailFailure({ status: 422, code: "user_not_found" }), null);
  assert.equal(magicEmailFailure(null), null);
});
