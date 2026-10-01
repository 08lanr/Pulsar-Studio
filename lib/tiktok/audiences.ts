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
