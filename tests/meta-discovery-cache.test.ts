import assert from "node:assert/strict";
import { test } from "node:test";
import { currentMetaInventory } from "../lib/meta/discovery";

test("fixture discovery never returns a cached live Meta inventory", async () => {
  const before = process.env.DATA_SOURCE;
  const store = globalThis as unknown as { __studioMetaInventory?: { at: number; value: Awaited<ReturnType<typeof currentMetaInventory>> } };
  const cached = store.__studioMetaInventory;
  try {
    process.env.DATA_SOURCE = "fixture";
    store.__studioMetaInventory = { at: Date.now(), value: { accounts: [{ id: "act_real", name: "Private", account_status: 1, currency: "USD", timezone_name: "" }], pages: [], instagram: [] } };
    const result = await currentMetaInventory();
    assert.equal(result.accounts.some(a => a.id === "act_real"), false);
    assert.equal(result.accounts[0]?.id, "act_9000000000000001");
  } finally {
    if (before === undefined) delete process.env.DATA_SOURCE; else process.env.DATA_SOURCE = before;
    if (cached) store.__studioMetaInventory = cached; else delete store.__studioMetaInventory;
  }
});
