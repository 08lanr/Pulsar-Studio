// Download names for every export. A title's English name is the stem when
// it has one (a Chinese stem survives in modern browsers but breaks in
// Content-Disposition without RFC 5987 encoding, so the route passes the
// ASCII name and lets the UTF-8 one ride as filename*). Anything that is not
// a letter, digit, dot or dash becomes one dash; the external id keeps two
// titles with the same name apart.

export type ExportFormat = "srt" | "vtt" | "csv" | "diff" | "brief" | "package" | "script";

const EXTENSION: Record<ExportFormat, string> = {
  script: "html",
  srt: "srt",
  vtt: "vtt",
  csv: "csv",
  diff: "html",
  brief: "html",
  package: "html",
};

export const CONTENT_TYPE: Record<ExportFormat, string> = {
  script: "text/html; charset=utf-8",
  srt: "application/x-subrip; charset=utf-8",
  vtt: "text/vtt; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  diff: "text/html; charset=utf-8",
  brief: "text/html; charset=utf-8",
  package: "text/html; charset=utf-8",
};

/** ASCII-only slug: "Love on the Road" -> "love-on-the-road"; "" when nothing survives. */
export function slugify(s: string | null | undefined, max = 60): string {
  return (s ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, max)
    .replace(/[-.]+$/g, "");
}

/** Keeps any script's letters (for the filename* form) but strips path and control characters. */
export function safeFilename(s: string, max = 120): string {
  const cleaned = s
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  return (cleaned || "export").slice(0, max);
}

export type ExportNameInput = {
  title: { name_en: string | null; name_zh: string; external_id: string };
  /** Episode number for per-episode formats; omit for title-level documents. */
  episode?: number | null;
  /** ver_ id of the version the file was rendered from, when there is one. */
  version_external_id?: string | null;
  format: ExportFormat;
};

/**
 * `love-on-the-road-ttl_x-ep01-ver_y-diff.html`. When the title has no
 * English name the external id alone is the stem (`ttl_x-ep01-srt.srt`).
 */
export function exportFilename(i: ExportNameInput): string {
  const stem = slugify(i.title.name_en);
  const parts = stem ? [stem, i.title.external_id] : [i.title.external_id];
  if (i.episode !== undefined && i.episode !== null) parts.push(`ep${String(i.episode).padStart(2, "0")}`);
  if (i.version_external_id) parts.push(i.version_external_id);
  parts.push(i.format);
  return `${safeFilename(parts.join("-"))}.${EXTENSION[i.format]}`;
}

/**
 * The full Content-Disposition value: an ASCII filename for every client and
 * a UTF-8 filename* carrying the Chinese name for the ones that read it.
 */
export function contentDisposition(asciiName: string, utf8Name?: string): string {
  const ascii = asciiName.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  const parts = [`attachment; filename="${ascii}"`];
  if (utf8Name && utf8Name !== asciiName) parts.push(`filename*=UTF-8''${encodeURIComponent(safeFilename(utf8Name))}`);
  return parts.join("; ");
}
