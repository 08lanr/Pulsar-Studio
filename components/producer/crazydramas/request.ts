// The few helpers the "Upload to crazydramas" screens share (phase 5,
// publish spec §1–5): one way to call Studio's own crazydramas routes from
// the browser, and one way to say a refusal in words. A refusal keeps the
// words it came with — crazydramas' own sentence for series_title_exists,
// series_not_studio, iap_product_id_taken and bad_request passes through
// Studio's route, and Studio's zod issues come back as `detail` in
// development — so the person reads what the platform said, never a code.

import type { PublishError } from "@/lib/crazydramas/publish-types";

export type Refusal = PublishError & {
  /** Studio's own zod refusal (app/api/titles/_lib/handler.ts parseJson → apiError), outside production. */
  detail?: { fieldErrors?: Record<string, string[] | undefined>; formErrors?: string[] } | null;
};

export type Answer<T> = { ok: true; status: number; body: T } | { ok: false; status: number; body: Refusal };

/** The routes under /api/titles/[id]/crazydramas/. */
export function cdRoute(titleId: string, path: string): string {
  return `/api/titles/${encodeURIComponent(titleId)}/crazydramas/${path}`;
}

/** One JSON call to our own API. A 401 goes to the door (the page is leaving); a network failure is a refusal with status 0. */
export async function sendJson<T>(method: "GET" | "PUT" | "POST", url: string, body?: unknown): Promise<Answer<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  } catch (e) {
    return { ok: false, status: 0, body: { error: (e as Error).message || "The request did not reach Studio" } };
  }
  if (res.status === 401) {
    window.location.href = "/login";
    return new Promise<Answer<T>>(() => {});
  }
  const data = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) return { ok: false, status: res.status, body: (data && typeof data === "object" ? data : {}) as Refusal };
  return { ok: true, status: res.status, body: data as T };
}

function pathText(path: unknown): string {
  if (Array.isArray(path)) return path.join(".");
  return typeof path === "string" ? path : "";
}

/**
 * A refusal in words: the route's sentence, then each issue with the field
 * it names, then (series_title_exists) the series that already has the
 * title. Never an empty string: without any words the HTTP status stands in.
 */
export function refusalWords(body: Refusal | null | undefined, status: number): string {
  const parts: string[] = [];
  if (body?.error) parts.push(body.error.replace(/[.。]\s*$/, ""));
  for (const issue of body?.issues ?? []) {
    const where = pathText(issue.path);
    parts.push(where ? `${where}: ${issue.message}` : issue.message);
  }
  for (const [field, messages] of Object.entries(body?.detail?.fieldErrors ?? {})) {
    for (const m of messages ?? []) parts.push(`${field}: ${m}`);
  }
  for (const m of body?.detail?.formErrors ?? []) parts.push(m);
  const existing = body?.existing;
  if (existing && (existing.title || existing.slug)) {
    parts.push([existing.title, existing.slug ? `(${existing.slug})` : null].filter(Boolean).join(" "));
  }
  if (!parts.length) parts.push(status ? `HTTP ${status}` : "no answer");
  return parts.join(" · ");
}

/** "1, 2, 3, 5" — the explicit list the screens print (never a count alone). */
export function episodeList(ns: readonly number[]): string {
  return [...ns].sort((a, b) => a - b).join(", ");
}

/** Dollars typed by a person ("9.99", "$9.99", "10") to cents; null when it is not an amount. */
export function centsFromDollars(text: string): number | null {
  const clean = text.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(clean)) return null;
  return Math.round(Number(clean) * 100);
}

/** Cents to the dollars a person edits ("9.99"). */
export function dollarsFromCents(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "";
  return (cents / 100).toFixed(2);
}
