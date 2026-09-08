import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireProducer } from "@/lib/auth";
import { getData } from "@/lib/data";
import { REPORT_METRICS, previewImport } from "@/lib/research/reports";
import { handle } from "@/app/api/titles/_lib/handler";

// Report imports. GET lists batches; POST with {preview:true} validates a
// CSV against the company's existing rows and catalog and returns the
// row-level preview without writing; POST with {commit:true} writes the
// rows the browser confirmed. The server re-validates the committed rows
// with zod; the data layer refuses viewers and staff.

const previewSchema = z.object({
  preview: z.literal(true),
  filename: z.string().trim().min(1).max(200),
  text: z.string().min(1).max(4_000_000),
  column_map: z.record(z.string()).optional(),
});

const rowSchema = z.object({
  title_id: z.string().uuid().nullable(),
  title_name: z.string().trim().min(1).max(200),
  platform: z.string().trim().min(1).max(80),
  period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  metric: z.enum(REPORT_METRICS as [string, ...string[]]),
  value: z.number().finite().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  source_row: z.number().int().nonnegative(),
});

const commitSchema = z.object({
  commit: z.literal(true),
  filename: z.string().trim().min(1).max(200),
  column_map: z.record(z.string()),
  rows: z.array(rowSchema).min(1).max(5000),
  skipped_count: z.number().int().nonnegative(),
});

export async function GET(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireProducer();
    if (g.response) return g.response;
    return NextResponse.json({ batches: await getData().listReportBatches(g.session) });
  });
}

export async function POST(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireProducer({ minRole: "reviewer" });
    if (g.response) return g.response;
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (body && body.preview === true) {
      const parsed = previewSchema.safeParse(body);
      if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "invalid" }, { status: 400 });
      const data = getData();
      const [existing, catalog] = await Promise.all([data.listReportRows(g.session), data.listCatalogForMatching(g.session)]);
      const preview = previewImport({ text: parsed.data.text, column_map: parsed.data.column_map, existing, catalog: catalog.rows });
      return NextResponse.json({ preview });
    }
    const parsed = commitSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "invalid" }, { status: 400 });
    const batch = await getData().commitReportBatch(g.session, {
      filename: parsed.data.filename,
      column_map: parsed.data.column_map,
      rows: parsed.data.rows.map((r) => ({ ...r, metric: r.metric as (typeof REPORT_METRICS)[number] })),
      skipped_count: parsed.data.skipped_count,
    });
    return NextResponse.json({ batch }, { status: 201 });
  });
}

export const dynamic = "force-dynamic";
