// Browser → our own API for the TikTok panels: throws on any non-2xx with
// the server's sentence, so a panel's catch block is the one error path.

export async function call<T>(url: string, method: "GET" | "POST" | "PUT" | "DELETE" = "GET", body?: unknown): Promise<T> {
  const res = await fetch(url, { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
  if (res.status === 401) {
    window.location.href = "/login";
    return new Promise<T>(() => {});
  }
  const json = (await res.json().catch(() => ({}))) as T & { error?: string; detail?: { message?: string } };
  if (!res.ok) throw new Error(json.error ? (json.detail?.message && json.detail.message !== json.error ? `${json.error} — ${json.detail.message}` : json.error) : `HTTP ${res.status}`);
  return json;
}

export const usd = (v: number | null | undefined, digits = 2) => (v == null ? "—" : `$${v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`);
export const int = (v: number | null | undefined) => (v == null ? "—" : Math.round(v).toLocaleString("en-US"));
export const pct = (v: number | null | undefined, digits = 2) => (v == null ? "—" : `${(v * 100).toFixed(digits)}%`);
