// The /creators screens' one way to call their routes (decision 2026-10-12).
import type { CreatorMedia } from "@/lib/creators/types";

/** A library item as the routes answer it: its file through the staff route, no storage path. */
export type MediaView = Omit<CreatorMedia, "path"> & { url: string; used_in: number };

export async function call<T>(url: string, method: string, body?: unknown): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, {
      method,
      headers: body instanceof FormData || body === undefined ? undefined : { "content-type": "application/json" },
      body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) return { ok: false, error: json.error ?? `HTTP ${res.status}` };
    return { ok: true, data: json };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
