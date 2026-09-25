import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireProducer, requireStaff } from "@/lib/auth";
import { getData } from "@/lib/data";
import { invalid } from "@/lib/data/errors";
import { handle } from "@/app/api/titles/_lib/handler";
import { draftSchema } from "./plan";
import { controlLaunch, queueLaunch, refreshLaunches } from "./service";
import { runTitleIds } from "./title-stats";

const money = z.number().int().min(1).max(100_000_000);
export const controlSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pause") }), z.object({ action: z.literal("resume") }), z.object({ action: z.literal("end") }),
  z.object({ action: z.literal("budget"), budget_cents: money }), z.object({ action: z.literal("daily_budget"), daily_budget_cents: money }),
  z.object({ action: z.literal("bid"), bid_cents: money }), z.object({ action: z.literal("schedule"), end_time: z.string().datetime({ offset: true }) }),
  z.object({ action: z.literal("duplicate") }), z.object({ action: z.literal("group"), group_id: z.string().min(1).max(100), enabled: z.boolean() }),
]);
type Operation = "workspace" | "scan" | "list" | "create" | "get" | "update" | "preview" | "launch" | "round" | "retry" | "controls" | "rename";
const bodySchema = {
  create: z.object({ draft: draftSchema, producer_id: z.string().uuid().optional() }),
  update: z.object({ draft: draftSchema, revision: z.number().int().positive() }),
  launch: z.object({ revision: z.number().int().positive(), note: z.string().trim().max(2000).optional() }),
  controls: z.object({ campaign_id: z.string().uuid(), control: controlSchema }),
  // The name people read on the monitor. Meta and TikTok objects are never renamed by it.
  rename: z.object({ name: z.string().trim().min(1).max(80) }),
};
function publicJson(value: unknown) {
  // Local storage paths and content hashes are server-side provenance, never
  // part of client editable drafts. Downloads use the authorized media route.
  return NextResponse.json(JSON.parse(JSON.stringify(value, (key, v) => ["file_path", "sha256"].includes(key) ? undefined : v)), { headers: { "Cache-Control": "no-store" } });
}
async function parse<S extends z.ZodTypeAny>(req: NextRequest, schema: S): Promise<z.infer<S>> {
  const value = schema.safeParse(await req.json().catch(() => null));
  if (!value.success) throw invalid(value.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; "));
  return value.data;
}
/**
 * "Watch on TikTok": a redirect to TikTok's own preview of one ad of a launch
 * the session may read (lib/launch/tiktok-posts.ts), so a person sees the ad
 * that exists, whatever it was made from. A plain link, so it opens in a tab.
 */
export function adPreviewRoute(req: NextRequest, staff: boolean, id: string, adId: string) {
  return handle(req, async () => {
    const guard = staff ? await requireStaff() : await requireProducer();
    if (guard.response) return guard.response;
    const { tiktokAdPreviewLink } = await import("./tiktok-posts");
    return NextResponse.redirect(await tiktokAdPreviewLink(guard.session, id, adId), { status: 302, headers: { "Cache-Control": "no-store" } });
  });
}

export function launchRoute(req: NextRequest, staff: boolean, op: Operation, id = "") {
  return handle(req, async () => {
    const guard = staff ? await requireStaff() : await requireProducer();
    if (guard.response) return guard.response;
    const s = guard.session, data = getData();
    if (op === "workspace") return publicJson({ workspace: await data.getLaunchWorkspace(s, req.nextUrl.searchParams.get("producer_id") || undefined) });
    if (op === "scan") {
      const b = await parse(req, z.object({ connection_ids: z.array(z.string()).min(1).max(30), producer_id: z.string().uuid().optional(), force: z.boolean().optional() }));
      return publicJson(await (await import("./account-scan")).scanLaunchAccounts(s, b.producer_id, b.connection_ids, b.force));
    }
    if (op === "list") {
      const runs = await refreshLaunches(s, req.nextUrl.searchParams.get("force") === "1");
      // The titles the launches promote, by name, for the Monitor's title
      // column, its Title filter and its "By title" table.
      const ids = new Set(runs.flatMap(runTitleIds));
      const titles = ids.size ? (await data.listTitles(s)).filter(t => ids.has(t.id)).map(t => ({ id: t.id, name: t.name_en || t.name_zh, producer_id: t.producer_id })) : [];
      return publicJson({
      runs, titles,
      can_edit: s.kind === "staff" || ["reviewer", "approver"].includes(s.producerRole || ""),
      can_launch: s.kind === "staff" ? s.staffRole === "admin" : s.producerRole === "approver",
      ...(s.kind === "staff" ? { producers: (await data.listProducers(s)).map(p => ({ id: p.id, name_zh: p.name_zh, name_en: p.name_en })) } : {}),
      });
    }
    if (op === "create") { const b = await parse(req, bodySchema.create); return publicJson({ run: await data.saveLaunchDraft(s, b.draft, { producerId: b.producer_id }) }); }
    if (op === "get") return publicJson({ run: await data.getLaunchRun(s, id) });
    if (op === "update") { const b = await parse(req, bodySchema.update); return publicJson({ run: await data.saveLaunchDraft(s, b.draft, { id, expectedRevision: b.revision }) }); }
    if (op === "preview") {
      // Planner errors are user-correctable validation, not internal failures.
      try { return publicJson({ plan: await data.previewLaunchRun(s, id) }); }
      catch (e) { if (e instanceof Error && e.name === "Error") throw invalid(e.message); throw e; }
    }
    if (op === "round") return publicJson({ run: await data.newLaunchRound(s, id) });
    if (op === "retry") { const run = await data.retryLaunchRun(s, id); queueLaunch(run.id); return publicJson({ run }); }
    if (op === "controls") { const b = await parse(req, bodySchema.controls); return publicJson({ run: await controlLaunch(s, id, b.campaign_id, b.control) }); }
    if (op === "rename") { const b = await parse(req, bodySchema.rename); return publicJson({ run: await data.renameLaunchRun(s, id, b.name) }); }
    const b = await parse(req, bodySchema.launch);
    let run;
    try { run = await data.submitLaunchRun(s, id, b.revision, b.note); }
    catch (e) { if (e instanceof Error && e.name === "Error") throw invalid(e.message); throw e; }
    queueLaunch(run.id); return publicJson({ run });
  });
}
