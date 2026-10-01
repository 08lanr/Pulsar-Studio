// TikTok custom audiences an ad group may target or exclude (decision 2026-10-01,
// "TikTok launches target custom audiences"). The audiences are made in Ads
// Manager (Tools → Audience Manager → Custom audience → Website traffic, on the
// crazydramas pixel); Studio only reads them, one read-only GET per ad account:
//
//   GET /open_api/v1.3/dmp/custom_audience/list/?advertiser_id=…&page=…&page_size=100
//   data.list[]   audience_id, name, cover_num (people matched), is_valid,
//                 is_expired, audience_type
//
// The read needs the Studio app's Audience Management permission on TikTok.
// Without it TikTok answers 40001, as /pixel/list/ did for the pixel, and the
// person may still name an audience by the id Audience Manager shows: the ad
// group takes ids either way, and TikTok refuses an id the account can't use
// when the paused launch creates its ad groups.
//
// Every call goes through the transport lib/tiktok/index.ts picks (the fake in
// fixture mode models the list).

import { isPermissionRefusal } from "./pixel";
import type { TikTokTransport } from "./transport";

/** TikTok's minimum before an audience delivers (Custom audiences help article). */
export const MIN_AUDIENCE_SIZE = 1000;

export type CustomAudience = {
  id: string;
  name: string;
  /** People TikTok matched, when it says; it can take up to 48 hours after creation. */
  size: number | null;
  /** TikTok's own flags: not ready (still filling, or too small) / expired. */
  valid: boolean;
  expired: boolean;
};

export type AudienceList =
  | { ok: true; audiences: CustomAudience[] }
  | { ok: false; reason: "no_permission" | "unreadable"; message: string };

/**
 * The audiences Studio knows by name (decision 2026-10-01, "Audience dropdowns"): made in Ads Manager, saved here
 * with what each one is for, per ad account. While TikTok won't let Studio read the list (no Audience Management
 * permission) these are what the launch's dropdowns offer; once it does, TikTok's list (with sizes) is merged in and
 * these add their descriptions. Add a line here when a new audience is made.
 */
export type SavedAudience = { id: string; name: string; description: string };
export const SAVED_AUDIENCES: Record<string, SavedAudience[]> = {
  // Pulsar Entertainment, Co. — the TikTok retargeting set, made 2026-10-01 on the crazydramas pixel.
  "7686288484534599696": [
    { id: "196145287", name: "RT Checkout 14d no buy", description: "Started checkout in the last 14 days and didn't pay" },
    { id: "196145276", name: "RT Viewers 7d no buy", description: "Watched a series in the last 7 days and never bought" },
    { id: "196145200", name: "RT Buyers 180d", description: "Bought in the last 180 days (leave these out)" },
  ],
  // Fixture mode's fake ad accounts (lib/tiktok/fake.ts FAKE_AUDIENCES), so the demo reads like the real thing.
  ...Object.fromEntries(["7000000000000000001", "7000000000000000002"].map((adv) => [adv, [
    { id: "7700000000000000003", name: "RT Checkout 14d no buy", description: "Started checkout in the last 14 days and didn't pay" },
    { id: "7700000000000000002", name: "RT Viewers 7d no buy", description: "Watched a series in the last 7 days and never bought" },
    { id: "7700000000000000001", name: "RT Buyers 180d", description: "Bought in the last 180 days (leave these out)" },
  ]])),
};

/** One choice in the launch's audience dropdowns. `size` and `valid` are TikTok's when it listed the audience. */
export type AudienceChoice = CustomAudience & { description: string | null };

/** What the dropdowns offer: `listed` = TikTok answered; `note` = why it didn't, in plain words. */
export type AudienceChoices = { listed: boolean; audiences: AudienceChoice[]; note: string | null };

/**
 * Pure: TikTok's list (when it answered) with the saved descriptions, else the saved audiences alone. When TikTok
 * answers, a saved audience it no longer lists was deleted and is left out. Saved order first, then the rest.
 */
export function audienceChoices(list: AudienceList, saved: readonly SavedAudience[] = []): AudienceChoices {
  if (!list.ok) {
    return { listed: false, note: list.message, audiences: saved.map((a) => ({ id: a.id, name: a.name, description: a.description, size: null, valid: true, expired: false })) };
  }
  const byId = new Map(saved.map((a, i) => [a.id, { a, i }]));
  const audiences = list.audiences
    .map((x) => ({ ...x, description: byId.get(x.id)?.a.description ?? null }))
    .sort((x, y) => (byId.get(x.id)?.i ?? Infinity) - (byId.get(y.id)?.i ?? Infinity));
  return { listed: true, note: null, audiences };
}

type Row = Record<string, unknown>;
const text = (v: unknown) => (v === undefined || v === null ? "" : String(v));

/** Pure: one page of /dmp/custom_audience/list/ as Studio's rows; rows without an id are dropped. */
export function audiencesFromList(rows: readonly Row[]): CustomAudience[] {
  return rows.flatMap((r) => {
    const id = text(r.audience_id);
    if (!/^\d+$/.test(id)) return [];
    const size = Number(r.cover_num);
    return [{ id, name: text(r.name) || `Audience ${id}`, size: Number.isFinite(size) && r.cover_num !== null && r.cover_num !== undefined ? size : null, valid: r.is_valid !== false, expired: r.is_expired === true }];
  });
}

/** The plain sentence for a refused or failed read, the words the launch screen prints. */
export function audienceRefusal(reason: "no_permission" | "unreadable", advertiserId: string, detail = ""): string {
  return reason === "no_permission"
    ? `TikTok won't let Studio list the audiences of ad account ${advertiserId} yet${detail ? ` (${detail})` : ""}: the Studio app on TikTok doesn't have the Audience Management permission. You can still add an audience by its ID (Ads Manager → Tools → Audience Manager, the ID column). To list them here: in the TikTok for Business developer portal, add Audience Management to the Studio app, then reconnect the Business Center on Studio's TikTok page.`
    : `Studio could not read the audiences of ad account ${advertiserId} from TikTok${detail ? ` (${detail})` : ""}. Try again in a minute, or add an audience by its ID.`;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 10;

/** Every custom audience of one ad account, newest TikTok order. Read-only; never throws. */
export async function listCustomAudiences(tt: TikTokTransport, token: string, advertiserId: string): Promise<AudienceList> {
  const audiences: CustomAudience[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await tt.get("/dmp/custom_audience/list/", token, { advertiser_id: advertiserId, page, page_size: PAGE_SIZE });
    if (res.code !== 0) {
      const reason = isPermissionRefusal(res.code, res.message) ? "no_permission" : "unreadable";
      return { ok: false, reason, message: audienceRefusal(reason, advertiserId, res.message) };
    }
    const rows = (res.data?.list ?? []) as Row[];
    audiences.push(...audiencesFromList(rows));
    const info = (res.data?.page_info ?? {}) as Row;
    const totalPages = Number(info.total_page ?? 1);
    if (rows.length < PAGE_SIZE || !(page < totalPages)) break;
  }
  return { ok: true, audiences };
}
