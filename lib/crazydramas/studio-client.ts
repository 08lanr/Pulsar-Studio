// The authenticated client for crazydramas' Studio API (phase 5, "Upload to
// crazydramas"; the contract is crazydramas docs/STUDIO_API.md, the shapes
// its apps/web/lib/studio-service.ts on main). One method per route:
//
//   GET  /api/studio/series/:series                    getSeries
//   PUT  /api/studio/series/:slug                      putSeries
//   POST /api/studio/series/:series/episodes/:n/upload createUpload
//   GET  /api/studio/uploads/:uploadId                 getUpload
//   POST /api/studio/uploads/:uploadId/sync            syncUpload
//   POST /api/studio/uploads/:uploadId/cancel          cancelUpload
//   POST /api/studio/series/:series/publish            publish
//   POST /api/studio/series/:series/unpublish          unpublish
//
// plus the resumable Mux PUTs behind an upload URL (putChunk, queryUpload)
// and the poster check (checkImage).
//
// Every success body is parsed with zod from the contract — whitelists: an
// episode's `playback_id` and an asset's `playback_ids` never survive a
// parse (the paywall leak), and an `upload_url` exists only on the upload
// answer, for the uploader's memory (never a row, a log or a response).
// Every refusal comes back as a value with crazydramas' own `code`, `error`
// and details VERBATIM (`series_title_exists` with `existing`,
// `episodes_changed` with `published` / `not_published`, …); "no answer" is
// `unreachable`, a body Studio cannot read `bad_response`.
//
// Two refusals happen here, before any call:
//   writes_disabled     the live-write gate of spec §6: a write needs
//                       DATA_SOURCE=supabase AND CRAZYDRAMAS_LIVE_WRITES=
//                       enabled AND the token; fixture mode writes to the
//                       fake only, and fixture mode reading the live site
//                       (CRAZYDRAMAS_LIVE_READ=1) writes nowhere
//   series_not_studio   a series Studio knows was made in the CMS (the
//                       caller passes what it read: `{ managed_by: "cms" }`);
//                       crazydramas would refuse it too, but Studio never
//                       even asks (spec §5)
//
// The token is never seen here: transport.ts reads it and puts it in the
// header. Which transport: the fake in fixture mode, the live one in
// Supabase mode or with CRAZYDRAMAS_LIVE_READ=1 (`crazydramasStudioMode`).

import { z } from "zod";
import { dataSource } from "@/lib/data-source";
import type { PlatformManagedBy } from "@/lib/types";
import { fakeCrazydramasTransport } from "./fake";
import { CdSeriesSchema, type CdSeries } from "./publish-types";
import {
  CrazydramasApiError,
  liveCrazydramasStudioTransport,
  studioReadRefusal,
  studioWriteRefusal,
  type ChunkAnswer,
  type ChunkRange,
  type CrazydramasStudioTransport,
  type ImageCheck,
} from "./transport";

// ---- which crazydramas, and may Studio write to it ---------------------------------------------------------

export type StudioMode = {
  /** fake: fixture mode's in-memory crazydramas; live: the site; off: the live reads are not allowed (no token). */
  read: "fake" | "live" | "off";
  write: "fake" | "live" | "off";
  read_refusal: string | null;
  /** The missing setting, by NAME, when writes are off. Never a value. */
  write_refusal: string | null;
};

/**
 * The mode now (spec §6):
 *   fixture mode                        reads and writes go to the fake
 *   fixture + CRAZYDRAMAS_LIVE_READ=1   reads the live site with the token; writes nowhere
 *   supabase                            reads live with the token; writes only with CRAZYDRAMAS_LIVE_WRITES=enabled
 */
export function crazydramasStudioMode(): StudioMode {
  if (dataSource() === "fixture" && process.env.CRAZYDRAMAS_LIVE_READ !== "1") return { read: "fake", write: "fake", read_refusal: null, write_refusal: null };
  const readRefusal = studioReadRefusal();
  const writeRefusal = studioWriteRefusal();
  return { read: readRefusal ? "off" : "live", write: writeRefusal ? "off" : "live", read_refusal: readRefusal, write_refusal: writeRefusal };
}

/** The Studio API transport for the mode: the fake in fixture mode, the live one otherwise (it refuses what the mode does not allow). */
export function crazydramasStudioTransport(): CrazydramasStudioTransport {
  if (typeof window !== "undefined") throw new Error("the crazydramas Studio API is server-only.");
  return crazydramasStudioMode().read === "fake" ? fakeCrazydramasTransport : liveCrazydramasStudioTransport;
}

/** The live-write gate as the screens say it: enabled, or the missing setting by name. */
export function cdWriteGate(): { enabled: boolean; reason: string | null; mode: StudioMode["write"] } {
  const mode = crazydramasStudioMode();
  return { enabled: mode.write !== "off", reason: mode.write_refusal, mode: mode.write };
}

// ---- the contract's shapes (whitelists) ---------------------------------------------------------------------

const num = z.union([z.number(), z.string()]).nullish().transform((v) => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
});

/** An episode row as the Studio API answers it, minus `playback_id`. */
export const StudioEpisodeSchema = z.object({
  id: z.string(),
  drama_id: z.string(),
  episode_number: z.number().int(),
  title: z.string().nullable().optional(),
  status: z.string(),
  is_published: z.boolean(),
  mux_upload_id: z.string().nullable().optional(),
  mux_asset_id: z.string().nullable().optional(),
  duration_seconds: num,
  updated_at: z.string().optional(),
});
export type StudioEpisode = z.infer<typeof StudioEpisodeSchema>;

export const GetSeriesAnswerSchema = z.object({ series: CdSeriesSchema, episodes: z.array(StudioEpisodeSchema).default([]) });
export type GetSeriesAnswer = z.infer<typeof GetSeriesAnswerSchema>;

export const PutSeriesAnswerSchema = z.object({ created: z.boolean(), changed: z.array(z.string()).default([]), series: CdSeriesSchema });
export type PutSeriesAnswer = z.infer<typeof PutSeriesAnswerSchema>;

/** The upload answer: the one place an `upload_url` exists (a capability — kept in the uploader's memory only). */
export const UploadAnswerSchema = z.object({
  reused: z.boolean(),
  created: z.boolean().optional(),
  episode_id: z.string(),
  drama_id: z.string(),
  episode_number: z.number().int(),
  upload_id: z.string(),
  upload_url: z.string().nullable(),
  upload_status: z.string().nullable().optional(),
  status: z.string(),
  is_published: z.boolean(),
  episode_created: z.boolean().optional(),
  replaced: z.boolean().optional(),
  previous_asset_id: z.string().nullable().optional(),
  asset_id: z.string().nullable().optional(),
  duration_seconds: num,
  sha256: z.string(),
  bytes: z.number(),
  frames: z.number().nullable().optional(),
  changed: z.array(z.string()).default([]),
});
export type UploadAnswer = z.infer<typeof UploadAnswerSchema>;

const MetaSchema = z.object({ external_id: z.string().optional(), title: z.string().optional(), creator_id: z.string().optional() }).nullable().optional();

/** GET /api/studio/uploads/:id, minus the asset's playback ids. */
export const UploadStatusAnswerSchema = z.object({
  upload: z.object({
    id: z.string(),
    status: z.string(),
    asset_id: z.string().nullable().optional(),
    error: z.unknown().optional(),
    timeout: z.number().nullable().optional(),
    passthrough: z.string().nullable().optional(),
    meta: MetaSchema,
    from_studio: z.boolean().optional(),
  }),
  asset: z
    .object({
      id: z.string(),
      status: z.string(),
      duration: num,
      meta: MetaSchema,
      passthrough: z.string().nullable().optional(),
      errors: z.unknown().optional(),
      created_at: z.string().nullable().optional(),
    })
    .nullable(),
  episode: StudioEpisodeSchema.nullable(),
  episode_is_current: z.boolean(),
  ready: z.boolean(),
  webhook_pending: z.boolean(),
});
export type UploadStatusAnswer = z.infer<typeof UploadStatusAnswerSchema>;

export const SyncAnswerSchema = z.object({ changed: z.array(z.string()).default([]), upload_status: z.string().nullable().optional(), episode: StudioEpisodeSchema.nullable().optional() });
export type SyncAnswer = z.infer<typeof SyncAnswerSchema>;

export const CancelAnswerSchema = z.object({ cancelled: z.boolean(), changed: z.array(z.string()).default([]) });
export type CancelAnswer = z.infer<typeof CancelAnswerSchema>;

const SeriesStatusSchema = z.object({ id: z.string(), slug: z.string(), status_before: z.string(), status: z.string() });

export const PublishAnswerSchema = z.object({ series: SeriesStatusSchema, published: z.array(z.number().int()), already_published: z.array(z.number().int()).default([]), changed: z.array(z.string()).default([]) });
export type PublishAnswer = z.infer<typeof PublishAnswerSchema>;

export const UnpublishAnswerSchema = z.object({ series: SeriesStatusSchema, unpublished: z.array(z.number().int()), already_unpublished: z.array(z.number().int()).default([]), changed: z.array(z.string()).default([]) });
export type UnpublishAnswer = z.infer<typeof UnpublishAnswerSchema>;

/** PUT series body (the contract's; Studio sends a subset). */
export type PutSeriesBody = {
  title?: string;
  original_title?: string | null;
  tagline?: string | null;
  description?: string | null;
  genre?: string[];
  language?: string;
  free_episode_count?: number;
  series_price_cents?: number | null;
  iap_product_id?: string | null;
  cta_mode?: "app" | "web_checkout" | "waitlist";
  poster_url?: string | null;
  update_live?: boolean;
};

export type UploadBody = { sha256: string; bytes: number; frames?: number; replace?: boolean };

// ---- results ------------------------------------------------------------------------------------------------

export type StudioOk<T> = { ok: true; status: number; data: T };
/**
 * A refusal, crazydramas' own words: `code` and `error` verbatim, `body` the
 * whole error body (its details: `existing`, `current`, `not_ready`,
 * `published`, …). `local` when Studio refused before any call
 * (writes_disabled, series_not_studio), could not reach crazydramas
 * (unreachable) or could not read its answer (bad_response).
 */
export type StudioFail = { ok: false; status: number; code: string; error: string; body: Record<string, unknown>; local: boolean };
export type StudioResult<T> = StudioOk<T> | StudioFail;

/** What the caller knows of the series it writes to: a CMS series is refused before any call (spec §5). */
export type SeriesGuard = { managed_by?: PlatformManagedBy | null };

/** The contract's transient answers: a later repeat is safe and may succeed (STUDIO_API.md "Conventions", "Error codes"). */
export const TRANSIENT_CODES: readonly string[] = ["unreachable", "db_error", "internal", "mux_error", "episode_busy", "episode_changed", "conflict_retry", "not_configured", "backend_not_configured"];

export function isTransient(fail: StudioFail): boolean {
  return TRANSIENT_CODES.includes(fail.code) || fail.status >= 500 || fail.status === 0;
}

const refuse = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): StudioFail => ({ ok: false, status, code, error, body: { error, code, ...extra }, local: true });

const seg = (v: string | number) => encodeURIComponent(String(v));

export type StudioClientOptions = {
  transport?: CrazydramasStudioTransport;
  /** The write gate; `cdWriteGate` by default. A test may pin it. */
  writeGate?: () => { enabled: boolean; reason: string | null };
};

export class StudioClient {
  readonly transport: CrazydramasStudioTransport;
  private readonly gate: () => { enabled: boolean; reason: string | null };

  constructor(opts: StudioClientOptions = {}) {
    this.transport = opts.transport ?? crazydramasStudioTransport();
    this.gate = opts.writeGate ?? cdWriteGate;
  }

  get mode(): "fake" | "live" {
    return this.transport.mode;
  }

  private async call<T>(method: "GET" | "PUT" | "POST", path: string, body: unknown, schema: z.ZodType<T, z.ZodTypeDef, unknown>, guard?: SeriesGuard): Promise<StudioResult<T>> {
    if (method !== "GET") {
      const gate = this.gate();
      if (!gate.enabled) return refuse(409, "writes_disabled", gate.reason ?? "Writes to crazydramas are disabled.", { reason: gate.reason });
      if (guard?.managed_by === "cms") {
        return refuse(403, "series_not_studio", "This series was made in the crazydramas CMS; Studio can read it but not change it. Ask Jayden to hand it over (one SQL line) to manage it from Studio. Nothing was sent.");
      }
    }
    let answer: { status: number; body: unknown };
    try {
      answer = await this.transport.request(method, path, body);
    } catch (e) {
      const message = e instanceof CrazydramasApiError ? e.message : "crazydramas did not answer.";
      return refuse(0, "unreachable", message);
    }
    const raw = answer.body && typeof answer.body === "object" && !Array.isArray(answer.body) ? (answer.body as Record<string, unknown>) : {};
    if (answer.status < 200 || answer.status >= 300) {
      const code = typeof raw.code === "string" ? raw.code : `http_${answer.status}`;
      const error = typeof raw.error === "string" ? raw.error : `crazydramas answered HTTP ${answer.status}.`;
      return { ok: false, status: answer.status, code, error, body: { ...raw, error, code }, local: false };
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return refuse(answer.status, "bad_response", "crazydramas answered a shape Studio cannot read (the contract changed?).");
    return { ok: true, status: answer.status, data: parsed.data };
  }

  getSeries(key: string): Promise<StudioResult<GetSeriesAnswer>> {
    return this.call("GET", `/api/studio/series/${seg(key)}`, undefined, GetSeriesAnswerSchema);
  }

  putSeries(slug: string, body: PutSeriesBody, guard?: SeriesGuard): Promise<StudioResult<PutSeriesAnswer>> {
    return this.call("PUT", `/api/studio/series/${seg(slug)}`, body, PutSeriesAnswerSchema, guard);
  }

  createUpload(series: string, n: number, body: UploadBody, guard?: SeriesGuard): Promise<StudioResult<UploadAnswer>> {
    return this.call("POST", `/api/studio/series/${seg(series)}/episodes/${seg(n)}/upload`, body, UploadAnswerSchema, guard);
  }

  getUpload(uploadId: string): Promise<StudioResult<UploadStatusAnswer>> {
    return this.call("GET", `/api/studio/uploads/${seg(uploadId)}`, undefined, UploadStatusAnswerSchema);
  }

  syncUpload(uploadId: string, guard?: SeriesGuard): Promise<StudioResult<SyncAnswer>> {
    return this.call("POST", `/api/studio/uploads/${seg(uploadId)}/sync`, undefined, SyncAnswerSchema, guard);
  }

  cancelUpload(uploadId: string): Promise<StudioResult<CancelAnswer>> {
    return this.call("POST", `/api/studio/uploads/${seg(uploadId)}/cancel`, undefined, CancelAnswerSchema);
  }

  publish(series: string, body: { episodes?: number[]; publish_series?: boolean }, guard?: SeriesGuard): Promise<StudioResult<PublishAnswer>> {
    return this.call("POST", `/api/studio/series/${seg(series)}/publish`, body, PublishAnswerSchema, guard);
  }

  unpublish(series: string, body: { episodes?: number[]; unpublish_series?: boolean }, guard?: SeriesGuard): Promise<StudioResult<UnpublishAnswer>> {
    return this.call("POST", `/api/studio/series/${seg(series)}/unpublish`, body, UnpublishAnswerSchema, guard);
  }

  /** One resumable chunk PUT (a write: the gate applies). "No answer" is status 0. */
  async putChunk(uploadUrl: string, chunk: Uint8Array, range: ChunkRange): Promise<ChunkAnswer> {
    const gate = this.gate();
    if (!gate.enabled) return { status: 0, acked: null };
    try {
      return await this.transport.putUploadChunk(uploadUrl, chunk, range);
    } catch {
      return { status: 0, acked: null };
    }
  }

  /** The empty status query (`Content-Range: bytes * /total`): how much the storage has persisted. "No answer" is status 0. */
  async queryUpload(uploadUrl: string, total: number): Promise<ChunkAnswer> {
    const gate = this.gate();
    if (!gate.enabled) return { status: 0, acked: null };
    try {
      return await this.transport.putUploadChunk(uploadUrl, null, { total });
    } catch {
      return { status: 0, acked: null };
    }
  }

  checkImage(url: string): Promise<ImageCheck> {
    return this.transport.checkImage(url);
  }

  /** Fixture mode only: tell the fake the file's frame rate, which the real Mux reads off the file itself. */
  hintFileFacts(sha256: string, facts: { fps: number | null }): void {
    const t = this.transport as CrazydramasStudioTransport & { hintFileFacts?: (sha: string, f: { fps: number | null }) => void };
    t.hintFileFacts?.(sha256, facts);
  }
}

/** A client on the mode's transport. */
export function studioClient(opts: StudioClientOptions = {}): StudioClient {
  return new StudioClient(opts);
}

export type { CdSeries };
