// Producer report import (docs/market-desk-plan.md, phase 4): CSV in,
// validated rows out, before anything is written. Pure functions; the
// route hands the preview back to the browser and only a confirmed batch
// reaches the data layer. Period, currency and metric definitions are
// mapped here and kept with every row, so an imported number is never
// compared with a platform counter by accident.

import type { CatalogRow } from "./engine";
import type { ReportMetric, ReportRow } from "./types";

export const REPORT_METRICS: ReportMetric[] = ["starts", "views", "completions", "payers", "revenue", "spend", "installs", "impressions", "clicks"];

export const CANONICAL_COLUMNS = ["title", "platform", "period_start", "period_end", "metric", "value", "currency"] as const;
export type CanonicalColumn = (typeof CANONICAL_COLUMNS)[number];

const ALIASES: Record<CanonicalColumn, string[]> = {
  title: ["title", "drama", "series", "name", "剧名", "作品", "标题", "片名"],
  platform: ["platform", "channel", "app", "平台", "渠道"],
  period_start: ["period_start", "start", "from", "date", "开始", "起始", "日期", "period"],
  period_end: ["period_end", "end", "to", "结束", "截止"],
  metric: ["metric", "measure", "kpi", "指标"],
  value: ["value", "amount", "count", "数值", "值", "数量", "金额"],
  currency: ["currency", "ccy", "币种", "货币"],
};

const METRIC_ALIASES: Record<string, ReportMetric> = {
  starts: "starts", start: "starts", 开播: "starts", 播放人数: "starts",
  views: "views", view: "views", plays: "views", 观看: "views", 播放: "views", 播放量: "views",
  completions: "completions", completion: "completions", completed: "completions", 完播: "completions",
  payers: "payers", payer: "payers", paying_users: "payers", 付费人数: "payers", 付费用户: "payers",
  revenue: "revenue", receipts: "revenue", income: "revenue", 收入: "revenue", 营收: "revenue",
  spend: "spend", cost: "spend", 花费: "spend", 投放: "spend", 消耗: "spend",
  installs: "installs", install: "installs", 安装: "installs", 下载: "installs",
  impressions: "impressions", impression: "impressions", 曝光: "impressions", 展示: "impressions",
  clicks: "clicks", click: "clicks", 点击: "clicks",
};

/** Minimal RFC 4180 parser: quotes, escaped quotes, CRLF, BOM. */
export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const src = text.replace(/^﻿/, "");
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((x) => x.trim() !== "")) out.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== "")) out.push(row);
  const headers = (out.shift() ?? []).map((h) => h.trim());
  return { headers, rows: out };
}

export type ColumnMap = Partial<Record<CanonicalColumn, string>>;

export function guessColumnMap(headers: string[]): ColumnMap {
  const map: ColumnMap = {};
  const lower = headers.map((h) => h.trim().toLowerCase());
  for (const col of CANONICAL_COLUMNS) {
    const idx = lower.findIndex((h) => ALIASES[col].includes(h));
    if (idx >= 0) map[col] = headers[idx];
  }
  return map;
}

function toIsoDate(raw: string): string | null {
  const s = raw.trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日?$/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // US m/d/y
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return null;
}

function toNumber(raw: string): number | null {
  const s = raw.replace(/[,\s$¥￥€£]/g, "").replace(/%$/, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export type NewReportRow = Omit<ReportRow, "id" | "batch_id" | "producer_id">;

export type PreviewRow = {
  row: number;
  ok: boolean;
  errors: string[];
  warnings: string[];
  duplicate: boolean;
  data: NewReportRow | null;
};

export type ImportPreview = {
  column_map: ColumnMap;
  missing_columns: CanonicalColumn[];
  rows: PreviewRow[];
  valid: number;
  invalid: number;
  duplicates: number;
  unmatched_titles: number;
};

export function duplicateKey(r: Pick<ReportRow, "title_name" | "platform" | "period_start" | "period_end" | "metric">): string {
  return [r.title_name.trim().toLowerCase(), r.platform.trim().toLowerCase(), r.period_start, r.period_end, r.metric].join("|");
}

/**
 * Validate a CSV against the canonical columns. Rows with errors are
 * reported and never imported; a row that matches an existing row on
 * (title, platform, period, metric) is a duplicate and skipped unless the
 * caller allows it. Title matching to the producer's catalog is by exact
 * name (zh or en, case-insensitive); an unmatched title is a warning, the
 * row still imports with title_id null.
 */
export function previewImport(input: { text: string; column_map?: ColumnMap; existing: ReportRow[]; catalog: CatalogRow[]; max_rows?: number }): ImportPreview {
  const { headers, rows } = parseCsv(input.text);
  const column_map = { ...guessColumnMap(headers), ...(input.column_map ?? {}) };
  const required: CanonicalColumn[] = ["title", "platform", "period_start", "metric", "value"];
  const missing_columns = required.filter((c) => !column_map[c] || !headers.includes(column_map[c]!));
  const idx = (c: CanonicalColumn) => (column_map[c] ? headers.indexOf(column_map[c]!) : -1);
  const catalogByName = new Map<string, string>();
  for (const c of input.catalog) {
    catalogByName.set(c.name_zh.trim().toLowerCase(), c.id);
    if (c.name_en) catalogByName.set(c.name_en.trim().toLowerCase(), c.id);
  }
  const existingKeys = new Set(input.existing.map(duplicateKey));
  const seenInFile = new Set<string>();
  const out: PreviewRow[] = [];
  const limit = input.max_rows ?? 5000;
  rows.slice(0, limit).forEach((cells, i) => {
    const rowNo = i + 2; // 1-based, after the header
    const errors: string[] = [];
    const warnings: string[] = [];
    if (missing_columns.length) {
      out.push({ row: rowNo, ok: false, errors: [`missing columns: ${missing_columns.join(", ")}`], warnings, duplicate: false, data: null });
      return;
    }
    const get = (c: CanonicalColumn) => (idx(c) >= 0 ? (cells[idx(c)] ?? "").trim() : "");
    const title_name = get("title");
    const platform = get("platform");
    const period_start = toIsoDate(get("period_start"));
    const period_end = get("period_end") ? toIsoDate(get("period_end")) : period_start;
    const metricRaw = get("metric").toLowerCase();
    const metric = METRIC_ALIASES[metricRaw] ?? (REPORT_METRICS.includes(metricRaw as ReportMetric) ? (metricRaw as ReportMetric) : null);
    const value = toNumber(get("value"));
    const currency = get("currency") ? get("currency").toUpperCase() : null;
    if (!title_name) errors.push("title is empty");
    if (!platform) errors.push("platform is empty");
    if (!period_start) errors.push(`period_start is not a date: "${get("period_start")}"`);
    if (get("period_end") && !period_end) errors.push(`period_end is not a date: "${get("period_end")}"`);
    if (period_start && period_end && period_end < period_start) errors.push("period_end is before period_start");
    if (!metric) errors.push(`unknown metric "${get("metric")}" (expected one of ${REPORT_METRICS.join(", ")})`);
    if (value == null) errors.push(`value is not a number: "${get("value")}"`);
    if (value != null && value < 0) errors.push("value is negative");
    if ((metric === "revenue" || metric === "spend") && !currency) errors.push(`${metric} needs a currency`);
    if (currency && !/^[A-Z]{3}$/.test(currency)) errors.push(`currency should be a 3-letter code, got "${currency}"`);
    const title_id = catalogByName.get(title_name.toLowerCase()) ?? null;
    if (!title_id && title_name) warnings.push("title not in your catalog; imported without a link");
    if (errors.length) {
      out.push({ row: rowNo, ok: false, errors, warnings, duplicate: false, data: null });
      return;
    }
    const data: NewReportRow = { title_id, title_name, platform, period_start: period_start!, period_end: period_end!, metric: metric!, value: value!, currency, source_row: rowNo };
    const key = duplicateKey(data);
    const duplicate = existingKeys.has(key) || seenInFile.has(key);
    seenInFile.add(key);
    if (duplicate) warnings.push("duplicate of an existing row (same title, platform, period, metric)");
    out.push({ row: rowNo, ok: true, errors, warnings, duplicate, data });
  });
  return {
    column_map,
    missing_columns,
    rows: out,
    valid: out.filter((r) => r.ok && !r.duplicate).length,
    invalid: out.filter((r) => !r.ok).length,
    duplicates: out.filter((r) => r.duplicate).length,
    unmatched_titles: out.filter((r) => r.ok && r.data && !r.data.title_id).length,
  };
}

/** Per-title, per-metric latest period for the My titles panel. */
export function summarizeReports(rows: ReportRow[]): Map<string, { metric: ReportMetric; value: number; currency: string | null; period_start: string; period_end: string; platform: string }[]> {
  const byTitle = new Map<string, ReportRow[]>();
  for (const r of rows) {
    if (!r.title_id) continue;
    const arr = byTitle.get(r.title_id) ?? [];
    arr.push(r);
    byTitle.set(r.title_id, arr);
  }
  const out = new Map<string, { metric: ReportMetric; value: number; currency: string | null; period_start: string; period_end: string; platform: string }[]>();
  for (const [id, arr] of byTitle) {
    const latestByMetric = new Map<string, ReportRow>();
    for (const r of arr) {
      const k = `${r.metric}|${r.platform}`;
      const cur = latestByMetric.get(k);
      if (!cur || r.period_end > cur.period_end) latestByMetric.set(k, r);
    }
    out.set(
      id,
      Array.from(latestByMetric.values())
        .sort((a, b) => a.metric.localeCompare(b.metric))
        .map((r) => ({ metric: r.metric, value: r.value, currency: r.currency, period_start: r.period_start, period_end: r.period_end, platform: r.platform }))
    );
  }
  return out;
}
