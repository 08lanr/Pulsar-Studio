import { dataSource } from "@/lib/data-source";
import { fakeMetaTransport } from "./fake";
import { liveMetaTransport, type MetaTransport } from "./transport";

/** A credential or live-write flag can never make fixture mode reach Meta. */
export function metaTransport(): MetaTransport {
  if (typeof window !== "undefined") throw new Error("Meta is server-only.");
  return dataSource() === "fixture" ? fakeMetaTransport : liveMetaTransport;
}
