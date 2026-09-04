// The one export action. Per-episode formats (srt, vtt, csv, diff) render
// from the data layer's export snapshot — the approved version's frozen
// snapshot when one exists, else the in_review one, else a live snapshot of
// the current draft — and the document says which: the diff header prints
// the version state and hash, the VTT carries a NOTE block, and every
// response carries X-Studio-Export-Source (SRT and CSV have no place for a
// header without breaking the format). Title-level formats (brief, package)
// render from the live variants and clips; brief accepts &episode=n to
// narrow the clip table. Untimed episodes cannot become subtitle files
// (400). Filenames come from lib/export/filename.ts; the Chinese name rides
// as filename* when there is no English one.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/api-guard";
import { requireMember } from "@/lib/auth";
import { DataError, getData, type ExportSnapshot } from "@/lib/data";
import {
  CONTENT_TYPE,
  briefHtml,
  contentDisposition,
  csvRowsFromSnapshot,
  diffDocumentHtml,
  exportFilename,
  packageHtml,
  scriptHtml,
  toCsv,
  toSrt,
  toVtt,
  type DocLocale,
  type ExportFormat,
} from "@/lib/export";
import type { TitleDetail } from "@/lib/types";
import { episodeNumber, handle, isResponse } from "../../_lib/handler";

const Query = z.object({
  format: z.enum(["srt", "vtt", "csv", "diff", "brief", "package", "script"]),
  episode: z.string().optional(),
  locale: z.enum(["zh", "en"]).optional(),
});

const PER_EPISODE: ReadonlySet<ExportFormat> = new Set(["srt", "vtt", "csv", "diff", "script"]);

/** The diff is the partner's document, so it reads Chinese unless asked; the editor's documents read English. */
function defaultLocale(format: ExportFormat): DocLocale {
  return format === "diff" ? "zh" : "en";
}

function fileResponse(
  body: string,
  format: ExportFormat,
  detail: TitleDetail,
  episode: number | null,
  snap: ExportSnapshot | null
): NextResponse {
  const ascii = exportFilename({
    title: detail.title,
    episode,
    version_external_id: snap?.version.external_id ?? null,
    format,
  });
  // No English name: the ASCII stem is the external id alone; the Chinese name rides as filename*.
  const utf8 = detail.title.name_en ? undefined : `${detail.title.name_zh}-${ascii}`;
  const headers = new Headers({
    "Content-Type": CONTENT_TYPE[format],
    "Content-Disposition": contentDisposition(ascii, utf8),
    "Cache-Control": "no-store",
    "X-Studio-Export-Source": snap?.source ?? "live",
  });
  if (snap?.sha256) headers.set("X-Studio-Snapshot-Sha256", snap.sha256);
  return new NextResponse(body, { status: 200, headers });
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  return handle(req, async () => {
    const g = await requireMember();
    if (g.response) return g.response;
    const q = Query.safeParse(Object.fromEntries(req.nextUrl.searchParams));
    if (!q.success) return apiError("Invalid request", q.error.flatten(), 400);
    const { format } = q.data;
    const locale = q.data.locale ?? defaultLocale(format);

    // The creative pack (brief, package) is Pulsar-internal in V1; producers
    // export their script and diff.
    if (g.session.kind !== "staff" && !PER_EPISODE.has(format)) {
      return apiError("This export is Pulsar-internal", undefined, 403);
    }

    let episode: number | null = null;
    if (q.data.episode !== undefined) {
      const n = episodeNumber(q.data.episode);
      if (isResponse(n)) return n;
      episode = n;
    }
    if (PER_EPISODE.has(format) && episode === null) {
      return apiError(`format=${format} needs &episode=n`, undefined, 400);
    }

    const data = getData();
    const detail = await data.getTitle(g.session, params.id);

    if (format === "package") {
      const variants = await data.listVariants(g.session, params.id);
      return fileResponse(packageHtml({ title: detail.title, variants, locale }), format, detail, null, null);
    }
    if (format === "brief") {
      const [clips, variants] = await Promise.all([
        data.listClips(g.session, params.id, episode ?? undefined),
        data.listVariants(g.session, params.id),
      ]);
      const html = briefHtml({ title: detail.title, clips, variants, episodes: detail.episodes, locale });
      return fileResponse(html, format, detail, episode, null);
    }

    const snap = await data.getExportSnapshot(g.session, params.id, episode as number);
    const s = snap.snapshot;
    const provenance = `${snap.source} ${s.version.external_id}${snap.sha256 ? ` sha256 ${snap.sha256}` : ""}`;

    if (format === "srt" || format === "vtt") {
      if (!s.episode.has_timecodes) {
        throw new DataError("invalid", `episode ${episode} has no timecodes; a subtitle export needs a timed source`);
      }
      const lines = s.scenes.flatMap((sc) => sc.adapted_lines);
      const sources = s.scenes.flatMap((sc) => sc.lines);
      const body =
        format === "srt"
          ? toSrt(lines, sources)
          : toVtt(
              lines,
              sources,
              `Pulsar Studio | ${s.title.name_en ?? s.title.name_zh} | Episode ${s.episode.number} | ${provenance}`
            );
      return fileResponse(body, format, detail, episode, snap);
    }
    if (format === "csv") {
      return fileResponse(toCsv(csvRowsFromSnapshot(s)), format, detail, episode, snap);
    }
    if (format === "script") {
      // The clean report: JUST the English script plus stats (docs/decisions.md 2026-09-04).
      return fileResponse(scriptHtml({ title: detail.title, snapshot: s, version: snap.version, locale }), format, detail, episode, snap);
    }

    // diff: the version row tells the header draft / in_review / approved and the hash.
    const html = diffDocumentHtml({
      title: detail.title,
      episode: s.episode,
      snapshot: s,
      locale,
      version: {
        status: snap.source === "draft" ? "draft" : snap.version.status,
        snapshot_sha256: snap.sha256,
        submitted_at: snap.version.submitted_at,
        approved_at: snap.version.approved_at,
        approval_mode: snap.version.approval_mode,
      },
      producer_name: locale === "zh" ? detail.producer.name_zh : detail.producer.name_en ?? detail.producer.name_zh,
    });
    return fileResponse(html, format, detail, episode, snap);
  });
}
