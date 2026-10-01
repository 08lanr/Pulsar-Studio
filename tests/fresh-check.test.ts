// An old Studio refuses to start (scripts/fresh-check.cjs, 2026-10-01): two computers share the live database.
import assert from "node:assert/strict";
import test from "node:test";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { freshnessVerdict, staleMessage } = require("../scripts/fresh-check.cjs");

test("a copy behind GitHub stops, unless started old on purpose; up to date or unknown starts", () => {
  assert.equal(freshnessVerdict({ behind: 7, allowOld: false }), "stop");
  assert.equal(freshnessVerdict({ behind: 7, allowOld: true }), "start");
  assert.equal(freshnessVerdict({ behind: 0, allowOld: false }), "start");
  assert.equal(freshnessVerdict({ behind: null, allowOld: false }), "unknown", "no git or offline never blocks");
  const msg = staleMessage({ behind: 1, mine: "aaa 2026-09-30 old", newest: "bbb 2026-10-01 new" });
  assert.match(msg, /1 update behind GitHub/);
  assert.match(msg, /git pull/);
  assert.match(msg, /STUDIO_ALLOW_OLD=1/);
});
