// The Clips tab and the launch content popup, staff and producer alike
// (docs/meta-organic-plan.md §4). House shape: same-origin guard -> role ->
// zod -> data layer / publishing engine -> publicJson.
//
// Reading — `list`, `get`, `pagePosts` — is open to any signed-in member of the
// company and to any staff member: a viewer sees the state of a post, which is
// what the Clips page is for. Publishing — `post`, `retry` — needs the
// company's approver or a staff administrator, the same rule as launching, and
// is enforced again inside the data layer and the engine. A foreign clip, post
// or connection is not found; its existence is never leaked.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireProducer, requireSession, requireStaff, type ProducerRole, type Session, type StaffRole } from "@/lib/auth";
import { getData } from "@/lib/data";
import { invalid } from "@/lib/data/errors";
import { handle } from "@/app/api/titles/_lib/handler";
import type { ClipLibraryFilter } from "./clip-posts";

export type ClipOperation = "list" | "post" | "get" | "retry" | "pagePosts";

const postSchema = z.object({
  platform: z.enum(["facebook", "instagram"]),
  connection_id: z.string().min(1).max(150),
  caption: z.string().max(2200).optional(),
  again: z.boolean().optional(),
}).strict();

const filterSchema = z.object({
  producer_id: z.string().uuid().optional(),
  title_id: z.string().uuid().optional(),
  episode_id: z.string().uuid().optional(),
  posted: z.enum(["any", "not_posted", "posted", "failed"]).optional(),
  search: z.string().trim().max(200).optional(),
});

/** Storage paths, content hashes and poster paths are server-side provenance. */
function publicJson(value: unknown, status = 200) {
  return NextResponse.json(
    JSON.parse(JSON.stringify(value, (key, v) => ["file_path", "sha256", "thumbnail_path"].includes(key) ? undefined : v)),
    { status, headers: { "Cache-Control": "no-store" } });
}

function query(req: NextRequest): ClipLibraryFilter {
  const raw = Object.fromEntries([...req.nextUrl.searchParams.entries()].filter(([, v]) => v !== ""));
  const parsed = filterSchema.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; "));
  return parsed.data;
}

async function body(req: NextRequest) {
  const parsed = postSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw invalid(parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; "));
  return parsed.data;
}

/** The company a staff request is acting for; a producer session is always its own. */
function actingProducer(s: Session, requested: string | null): string {
  if (s.kind === "producer") return s.producerId!;
  if (!requested) throw invalid("Choose a company.");
  return requested;
}

/** The role each operation needs; `undefined` means "any staff" / "any member of the company". */
export function clipRouteRoles(op: ClipOperation): { staffRole?: StaffRole; producerMinRole?: ProducerRole } {
  return op === "post" || op === "retry" ? { staffRole: "admin", producerMinRole: "approver" } : {};
}

export function clipRoute(req: NextRequest, staff: boolean, op: ClipOperation, id = "") {
  return handle(req, async () => {
    const roles = clipRouteRoles(op);
    // A read on the producer route takes any signed-in session: a member of the
    // company, or staff previewing the portal, whom the data layer scopes. That
    // matches the other producer reads (the episode clips route, the presets
    // route). Publishing still needs the company's approver or a staff admin.
    const guard = staff
      ? await requireStaff(roles.staffRole ? { role: roles.staffRole } : undefined)
      : roles.producerMinRole
        ? await requireProducer({ minRole: roles.producerMinRole })
        : await requireSession();
    if (guard.response) return guard.response;
    const s = guard.session, data = getData();
    if (op === "list") return publicJson({ clips: await data.listClipLibrary(s, query(req)) });
    if (op === "get") return publicJson({ post: await data.getClipPost(s, id) });
    if (op === "retry") {
      const { retryClipPost } = await import("@/lib/meta/publish");
      return publicJson({ post: await retryClipPost(s, id) });
    }
    if (op === "pagePosts") {
      const { listMetaPagePosts } = await import("@/lib/meta/publish");
      const producerId = actingProducer(s, req.nextUrl.searchParams.get("producer_id"));
      const connectionId = req.nextUrl.searchParams.get("connection_id") || "";
      if (!connectionId) throw invalid("Choose an advertising account.");
      return publicJson(await listMetaPagePosts(s, producerId, connectionId));
    }
    const input = await body(req);
    const { publishClip } = await import("@/lib/meta/publish");
    // Detached: the request returns as soon as the row exists, and the screen
    // polls GET …/clips/posts/[id] until it settles.
    return publicJson({ post: await publishClip(s, { ...input, clip_id: id }) }, 202);
  });
}
