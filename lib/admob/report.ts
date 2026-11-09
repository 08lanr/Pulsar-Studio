// Google AdMob's network report (decision 2026-11-09, "Ad unlocks in Studio"): the request Studio sends and the
// parse of what Google answers. Pure and client-safe; the read itself (OAuth, the 15-minute keep) is ./read.ts.
//
// AdMob API v1, `POST https://admob.googleapis.com/v1/accounts/<publisher>/networkReport:generate`. The answer is a
// JSON array streamed in one body: a `header` item, one `row` item per (day, app, platform), a `footer` item (with
// `matchingRowCount` and any `warnings`). A row's dimension values are `{ value, displayLabel? }`; its metric values
// are `{ integerValue: "123" }` (counts, as strings), `{ microsValue: "6500000" }` (money in millionths of the
// currency) or `{ doubleValue: 0.95 }` (rates, and the RPM in whole currency units). Days are `YYYYMMDD` in the
// report's time zone, which Studio asks to be America/Los_Angeles, crazydramas' day.

/** The AdMob account (`pub-…`), from ADMOB_PUBLISHER_ID (not a secret), default CrazyDramas' account. */
export const DEFAULT_ADMOB_PUBLISHER_ID = "pub-5711183345077823";
export const ADMOB_TIMEZONE = "America/Los_Angeles";

export function admobPublisherId(): string {
  const raw = process.env.ADMOB_PUBLISHER_ID?.trim();
  return raw && /^pub-\d{6,20}$/.test(raw) ? raw : DEFAULT_ADMOB_PUBLISHER_ID;
}

export function admobReportUrl(publisher = admobPublisherId()): string {
  return `https://admob.googleapis.com/v1/accounts/${publisher}/networkReport:generate`;
}

export const ADMOB_DIMENSIONS = ["DATE", "APP", "PLATFORM"] as const;
export const ADMOB_METRICS = ["ESTIMATED_EARNINGS", "IMPRESSIONS", "AD_REQUESTS", "MATCHED_REQUESTS", "MATCH_RATE", "IMPRESSION_RPM", "CLICKS"] as const;

const dateOf = (day: string) => {
  const [year, month, d] = day.split("-").map(Number);
  return { year, month, day: d };
};

/** The request body: the days (inclusive, Pacific), by day, app and platform, in US dollars. */
export function admobReportSpec(from: string, to: string) {
  return {
    reportSpec: {
      dateRange: { startDate: dateOf(from), endDate: dateOf(to) },
      dimensions: [...ADMOB_DIMENSIONS],
      metrics: [...ADMOB_METRICS],
      sortConditions: [{ dimension: "DATE", order: "ASCENDING" }],
      localizationSettings: { currencyCode: "USD", languageCode: "en-US" },
      timeZone: ADMOB_TIMEZONE,
    },
  };
}

export type AdmobPlatform = "ios" | "android" | "other";

/** One row of the report: one app on one platform on one Pacific day. Earnings in micros (USD millionths). */
export type AdmobRow = {
  day: string;
  app_id: string;
  app_name: string | null;
  platform: AdmobPlatform;
  earnings_micros: number;
  impressions: number;
  ad_requests: number;
  matched_requests: number;
  /** Google's own match rate, 0..1, or null when it sent none. */
  match_rate: number | null;
  /** Google's own RPM (dollars per 1,000 impressions), or null. */
  impression_rpm: number | null;
  clicks: number;
};

export type AdmobParse = { ok: true; rows: AdmobRow[]; currency: string | null; warnings: string[] } | { ok: false; error: string };

type Value = { value?: unknown; displayLabel?: unknown };
type Metric = { integerValue?: unknown; microsValue?: unknown; doubleValue?: unknown };

const intOf = (m: Metric | undefined): number => {
  const raw = m?.integerValue ?? m?.microsValue;
  const n = typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
  return Number.isFinite(n) ? Math.round(n) : 0;
};
const doubleOf = (m: Metric | undefined): number | null => {
  const raw = m?.doubleValue;
  const n = typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
};

function platformOf(v: unknown): AdmobPlatform {
  const s = typeof v === "string" ? v.toLowerCase() : "";
  return s === "ios" ? "ios" : s === "android" ? "android" : "other";
}

function dayOf(v: unknown): string | null {
  const s = typeof v === "string" ? v : "";
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
}

/** Google's error body (`{ error: { message, status } }`) as one plain sentence, or null. Never carries a token. */
export function googleErrorMessage(body: unknown): string | null {
  const err = (Array.isArray(body) ? body.find((x) => x && typeof x === "object" && "error" in x) : body) as { error?: unknown; error_description?: unknown } | null | undefined;
  if (!err || typeof err !== "object") return null;
  if (typeof err.error_description === "string") return err.error_description.slice(0, 300);
  const e = err.error;
  if (typeof e === "string") return e.slice(0, 300);
  if (e && typeof e === "object") {
    const { message, status } = e as { message?: unknown; status?: unknown };
    const text = typeof message === "string" ? message : typeof status === "string" ? status : null;
    return text ? text.slice(0, 300) : null;
  }
  return null;
}

/**
 * The whole answer, header to footer: every `row` item becomes an AdmobRow (a row with no readable day is skipped),
 * the header's currency and the footer's warnings are kept. Anything that is not the array, or an array carrying an
 * `error` item, is a failure with Google's message.
 */
export function parseAdmobReport(body: unknown): AdmobParse {
  if (!Array.isArray(body)) return { ok: false, error: googleErrorMessage(body) ?? "AdMob answered something that is not a report." };
  const failed = googleErrorMessage(body);
  if (failed) return { ok: false, error: failed };
  const rows: AdmobRow[] = [];
  let currency: string | null = null;
  const warnings: string[] = [];
  for (const item of body) {
    if (!item || typeof item !== "object") continue;
    const it = item as { header?: { localizationSettings?: { currencyCode?: unknown } }; row?: { dimensionValues?: Record<string, Value>; metricValues?: Record<string, Metric> }; footer?: { warnings?: unknown } };
    if (it.header) {
      const c = it.header.localizationSettings?.currencyCode;
      if (typeof c === "string") currency = c;
    }
    if (it.footer && Array.isArray(it.footer.warnings)) {
      for (const w of it.footer.warnings) {
        const d = (w as { description?: unknown; type?: unknown } | null)?.description ?? (w as { type?: unknown } | null)?.type;
        if (typeof d === "string") warnings.push(d);
      }
    }
    if (!it.row) continue;
    const dims = it.row.dimensionValues ?? {};
    const mets = it.row.metricValues ?? {};
    const day = dayOf(dims.DATE?.value);
    if (!day) continue;
    rows.push({
      day,
      app_id: typeof dims.APP?.value === "string" ? dims.APP.value : "",
      app_name: typeof dims.APP?.displayLabel === "string" ? dims.APP.displayLabel : null,
      platform: platformOf(dims.PLATFORM?.value),
      earnings_micros: intOf(mets.ESTIMATED_EARNINGS),
      impressions: intOf(mets.IMPRESSIONS),
      ad_requests: intOf(mets.AD_REQUESTS),
      matched_requests: intOf(mets.MATCHED_REQUESTS),
      match_rate: doubleOf(mets.MATCH_RATE),
      impression_rpm: doubleOf(mets.IMPRESSION_RPM),
      clicks: intOf(mets.CLICKS),
    });
  }
  return { ok: true, rows, currency, warnings };
}
