// Export renderers: pure functions from typed data to file contents. Nothing
// here touches the database, the filesystem or the request; the route
// handler at GET /api/titles/[id]/export picks the snapshot (approved, else
// in_review, else the current draft), calls one of these and sets the
// headers with the helpers in ./filename. Keeping the renderers pure is what
// lets tests/export.test.ts pin the byte-level formats.

export { scriptHtml } from "./script";
export { toSrt, toVtt, toCues, type SubtitleLine, type SubtitleSource, type Cue } from "./subtitles";
export { toCsv, csvRowsFromSnapshot, csvField, CSV_COLUMNS, CSV_BOM, type CsvRow } from "./csv";
export { diffDocumentHtml, type DiffDocumentInput } from "./diff";
export { briefHtml, type BriefInput } from "./brief";
export { packageHtml, type PackageInput } from "./package";
export { srtTime, vttTime, clockTime, clockRange } from "./time";
export { esc, docShell, type DocLocale } from "./html";
export {
  exportFilename,
  contentDisposition,
  safeFilename,
  slugify,
  CONTENT_TYPE,
  type ExportFormat,
  type ExportNameInput,
} from "./filename";
