// Client-safe: no transport, no data layer. A company can hold several Meta
// connections on one ad account (one per Page, decision 2026-10-25), and they
// share the ad account's name, so every picker names the Page and its
// Instagram account as well.
import type { LaunchConnection } from "./types";

type Labelled = Pick<LaunchConnection, "provider" | "name" | "page_id" | "instagram_id" | "page_name" | "instagram_username">;

export function connectionLabel(c: Labelled): string {
  if (c.provider !== "meta") return c.name;
  const page = c.page_name || c.page_id;
  const instagram = c.instagram_username ? `@${c.instagram_username}` : c.instagram_id;
  return [c.name, page, instagram].filter(Boolean).join(" · ");
}
