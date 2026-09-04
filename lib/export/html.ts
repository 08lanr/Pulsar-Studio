// The shell every printed document shares: escaping, the inline stylesheet
// and the page frame. The documents are opened by the partner in mainland
// China and printed by a U.S. editor, so they are self-contained — one file,
// system font stacks, no font, script or asset from any host. The look
// follows the app's design system (white surface, 1px borders, one blue,
// nothing above weight 600) so a PDF of the diff reads as the same product
// as the review screen it came from.

export type DocLocale = "zh" | "en";

export function esc(s: string | number | null | undefined): string {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escapes and turns newlines into <br>, for free text such as a synopsis. */
export function escMultiline(s: string | null | undefined): string {
  return esc(s).replace(/\r?\n/g, "<br>");
}

/** The two font stacks: Latin first, then the CJK faces the two platforms ship. */
const FONT_STACK =
  '-apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
const MONO_STACK = 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

export const DOC_STYLE = `
  :root {
    --bg: #f4f5f7; --surface: #ffffff; --surface-2: #f8f9fa;
    --text: #16181d; --text-muted: #5c6470; --text-faint: #8a919e;
    --border: #e6e8ec; --border-strong: #c9cdd4;
    --brand: #2557d6; --brand-tint: #f0f5ff; --accent-text: #1a44b8;
    --success: #0b7a4b; --success-bg: #e6f6ee;
    --warning: #9a5b06; --warning-bg: #fdf3e2;
    --error: #c92a2a; --error-bg: #fdecec;
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: ${FONT_STACK}; font-size: 14px; line-height: 1.55;
    font-variant-numeric: tabular-nums; font-weight: 400;
  }
  .doc { max-width: 880px; margin: 0 auto; padding: 32px 20px 64px; }
  .sheet { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 28px 32px; }
  h1, h2, h3, h4 { font-weight: 600; margin: 0; line-height: 1.2; letter-spacing: -0.02em; }
  h1 { font-size: 23px; }
  h2 { font-size: 16px; margin-top: 28px; padding-top: 16px; border-top: 1px solid var(--border); }
  h3 { font-size: 14px; }
  p { margin: 0; }
  .muted { color: var(--text-muted); }
  .faint { color: var(--text-faint); }
  .small { font-size: 12.5px; }
  .micro { font-size: 11px; }
  .label { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-faint); font-weight: 500; }
  .mono { font-family: ${MONO_STACK}; font-size: 12px; }
  .head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px 24px; align-items: flex-start; }
  .head .sub { margin-top: 4px; }
  .meta { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin-top: 16px; font-size: 12.5px; }
  .meta dt { color: var(--text-faint); }
  .meta dd { margin: 0; overflow-wrap: anywhere; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 500; line-height: 18px; border: 1px solid transparent; vertical-align: middle; white-space: nowrap; }
  .pill-neutral { background: var(--surface-2); color: var(--text-muted); border-color: var(--border); }
  .pill-accent { background: var(--brand-tint); color: var(--accent-text); }
  .pill-success { background: var(--success-bg); color: var(--success); }
  .pill-warning { background: var(--warning-bg); color: var(--warning); }
  .pill-error { background: var(--error-bg); color: var(--error); }
  .tags { display: inline-flex; flex-wrap: wrap; gap: 4px; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 13px; }
  th { text-align: left; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-faint); font-weight: 500; padding: 6px 8px; border-bottom: 1px solid var(--border-strong); vertical-align: bottom; }
  td { padding: 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
  td.num, th.num { text-align: right; white-space: nowrap; }
  .scene { margin-top: 24px; border-top: 1px solid var(--border); padding-top: 16px; }
  .scene-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 12px; }
  .context { margin-top: 6px; padding: 10px 12px; background: var(--surface-2); border-radius: 8px; font-size: 13px; color: var(--text-muted); }
  .line { display: grid; grid-template-columns: 56px 1fr; gap: 4px 12px; padding: 12px 0; border-bottom: 1px solid var(--border); }
  .line:last-child { border-bottom: 0; }
  .line .at { font-size: 11px; color: var(--text-faint); padding-top: 3px; }
  .line .who { font-size: 12.5px; font-weight: 500; color: var(--text-muted); }
  .line .zh { font-size: 15px; }
  .line .bt { font-size: 15px; padding: 6px 10px; margin-top: 4px; border-left: 2px solid var(--brand); background: var(--brand-tint); border-radius: 0 6px 6px 0; }
  .line .en { font-size: 12.5px; color: var(--text-muted); margin-top: 4px; }
  .line .why { font-size: 12.5px; margin-top: 6px; }
  .line .why b { font-weight: 500; color: var(--text-faint); }
  .line .cut { font-size: 12.5px; color: var(--error); }
  .line .flags { margin-top: 4px; display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
  .card { border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; margin-top: 10px; }
  .card.pick { border-color: var(--brand); }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  ol.plain { margin: 8px 0 0; padding-left: 20px; }
  ol.plain li { margin: 4px 0; }
  .foot { margin-top: 32px; font-size: 11px; color: var(--text-faint); text-align: center; }
  @media (max-width: 640px) { .sheet { padding: 20px 16px; } .grid2 { grid-template-columns: 1fr; } .line { grid-template-columns: 1fr; } }
  @media print {
    body { background: #fff; }
    .doc { max-width: none; padding: 0; }
    .sheet { border: 0; padding: 0; }
    .scene { break-before: page; page-break-before: always; border-top: 0; padding-top: 0; }
    .scene:first-of-type { break-before: auto; page-break-before: auto; }
    .line, .card, tr { break-inside: avoid; page-break-inside: avoid; }
    a { color: inherit; text-decoration: none; }
    @page { margin: 18mm 16mm; }
  }
`;

/** Wraps a body in the document frame. `lang` sets the CJK/Latin fallback the browser picks. */
export function docShell(o: { lang: DocLocale; title: string; body: string }): string {
  return [
    "<!doctype html>",
    `<html lang="${o.lang === "zh" ? "zh-CN" : "en"}">`,
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    `<title>${esc(o.title)}</title>`,
    `<style>${DOC_STYLE}</style>`,
    "</head>",
    "<body>",
    '<main class="doc"><div class="sheet">',
    o.body,
    "</div></main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/** A status pill for a version status or a clip status. */
export function pill(text: string, tone: "neutral" | "accent" | "success" | "warning" | "error" = "neutral"): string {
  return `<span class="pill pill-${tone}">${esc(text)}</span>`;
}

/** A <dl class="meta"> from label/value pairs; empty values are skipped. */
export function metaList(pairs: Array<[string, string | null | undefined]>): string {
  const rows = pairs.filter(([, v]) => v !== null && v !== undefined && v !== "");
  if (!rows.length) return "";
  return `<dl class="meta">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`;
}

/** "3 Sept 2026, 09:20 UTC" without a locale-dependent library; ISO date falls through untouched. */
export function fmtDate(iso: string | null | undefined, locale: DocLocale): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return locale === "zh" ? `${y}年${m}月${day}日 ${hh}:${mm} UTC` : `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")} ${hh}:${mm} UTC`;
}
