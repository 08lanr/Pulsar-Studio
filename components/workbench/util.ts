// Small pure helpers the workbench components share: timecode formatting,
// the "did the adaptation change anything" test, and a PATCH helper that
// lib/api-client.ts does not provide (it ships GET / POST / multipart only;
// adding a verb there belongs to its owner, so the one PATCH route the
// workbench calls is wrapped here with the same 401 and envelope rules).

import type { AdaptedLine, ChangeType, VersionStatus } from "@/lib/types";

/** 00:12:04 — hours always shown so every timecode is the same width. */
export function fmtTc(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "--:--:--";
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

/** keep / literal leave the line as it was; everything else is a real change. */
export function isChanged(type: ChangeType | undefined): boolean {
  return !!type && type !== "keep" && type !== "literal";
}

/** A frozen version is read-only in the workbench (trigger-enforced in SQL). */
export function isFrozen(status: VersionStatus | null | undefined): boolean {
  return status === "in_review" || status === "approved";
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 12) : "";
}

/** Index adapted lines by their anchor source line. */
export function indexByLine(adapted: AdaptedLine[]): Map<string, AdaptedLine> {
  const m = new Map<string, AdaptedLine>();
  for (const a of adapted) if (a.line_id) m.set(a.line_id, a);
  return m;
}

export type ApiEnvelope = { error?: string; code?: string; detail?: { message?: string } };

/** An envelope error with its server code attached, so a screen can put a
 * localized sentence over well-known codes (e.g. 'llm_unavailable') instead
 * of printing the server's English to a Chinese-chrome producer. */
export class ApiError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

export async function patchJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    window.location.href = "/login";
    return new Promise<T>(() => {});
  }
  return res.json();
}

/** Throw the envelope's error so every caller can `.catch` one sentence. */
export function unwrap<T extends ApiEnvelope>(data: T): T {
  if (data && typeof data === "object" && data.error) {
    const extra = data.detail?.message;
    throw new ApiError(extra && extra !== data.error ? `${data.error} — ${extra}` : data.error, data.code);
  }
  return data;
}
