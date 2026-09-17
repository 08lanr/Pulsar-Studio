import { metaTransport } from "./index";
import { metaList, type MetaTransport } from "./transport";

export type MetaInventory = {
  accounts: { id: string; name: string; account_status: number; currency: string; timezone_name: string; business?: { id: string; name: string } }[];
  pages: { id: string; name: string; instagram_business_account?: { id: string; username?: string } }[];
  instagram: { account_id: string; id: string; username: string }[];
};
const cache = globalThis as unknown as { __studioMetaInventory?: { at: number; value: MetaInventory } };
/** Short lived read cache for workspace refreshes; submission asks for a fresh inventory. */
export async function currentMetaInventory(force = false): Promise<MetaInventory> {
  const transport = metaTransport();
  if (transport.mode === "fake") return discoverMetaInventory(transport);
  const hit = cache.__studioMetaInventory;
  if (!force && hit && Date.now() - hit.at < 15_000) return hit.value;
  const value = await discoverMetaInventory(transport);
  cache.__studioMetaInventory = { at: Date.now(), value };
  return value;
}
/** Read-only discovery. Account/Page selection still requires a company-scoped staff assignment. */
export async function discoverMetaInventory(transport: MetaTransport = metaTransport()): Promise<MetaInventory> {
  if (transport.mode === "fake") return {
    accounts: ["9000000000000001", "9000000000000002"].map((id, index) => ({ id: `act_${id}`, name: `Demo Meta ${index + 1}`, account_status: 1, currency: "USD", timezone_name: "America/Los_Angeles" })),
    pages: [{ id: "9000000000000010", name: "Demo Page", instagram_business_account: { id: "9000000000000020", username: "demo_studio" } }],
    instagram: ["9000000000000001", "9000000000000002"].map(id => ({ account_id: `act_${id}`, id: "9000000000000020", username: "demo_studio" })),
  };
  const [accounts, pages] = await Promise.all([
    metaList(transport, "me/adaccounts", { fields: "id,name,account_status,currency,timezone_name,business{id,name}" }),
    metaList(transport, "me/accounts", { fields: "id,name,instagram_business_account{id,username}" }),
  ]);
  const instagram: MetaInventory["instagram"] = [];
  for (const account of accounts) {
    for (const row of await metaList(transport, `${String(account.id)}/instagram_accounts`, { fields: "id,username" })) {
      instagram.push({ account_id: String(account.id), id: String(row.id), username: String(row.username || "") });
    }
  }
  return {
    accounts: accounts.map(row => ({ id: String(row.id), name: String(row.name), account_status: Number(row.account_status), currency: String(row.currency), timezone_name: String(row.timezone_name), ...(row.business ? { business: row.business as { id: string; name: string } } : {}) })),
    pages: pages.map(row => ({ id: String(row.id), name: String(row.name), ...(row.instagram_business_account ? { instagram_business_account: row.instagram_business_account as { id: string; username?: string } } : {}) })),
    instagram,
  };
}
