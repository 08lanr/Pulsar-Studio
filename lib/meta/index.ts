import { dataSource } from "@/lib/data-source";
import { fakeMetaTransport } from "./fake";
import { liveMetaPublishTransport, liveMetaTransport, type MetaTransport } from "./transport";

/** A credential or live-write flag can never make fixture mode reach Meta. */
export function metaTransport(): MetaTransport {
  if (typeof window !== "undefined") throw new Error("Meta is server-only.");
  return dataSource() === "fixture" ? fakeMetaTransport : liveMetaTransport;
}

/**
 * Organic publishing, comments and insights (decision 2026-10-12): the same
 * fake in fixture mode, the publish token (META_PUBLISH_TOKEN, falling back to
 * META_ACCESS_TOKEN) in Supabase mode.
 */
export function metaPublishTransport(): MetaTransport {
  if (typeof window !== "undefined") throw new Error("Meta is server-only.");
  return dataSource() === "fixture" ? fakeMetaTransport : liveMetaPublishTransport;
}
