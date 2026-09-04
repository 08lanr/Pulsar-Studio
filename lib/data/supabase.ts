// DATA_SOURCE=supabase: the data layer over the shared project, per request,
// under RLS (createServerSupabase carries the caller's cookie). Authorization
// is the database's: RLS decides what a producer can see, the SECURITY
// DEFINER functions (submit_version, decide_scene, approve_version,
// fork_version, choose_alternative, select_variant, set_scene_status) decide
// what anyone can change, and guard_frozen refuses edits to a submitted
// version. This file only shapes queries, maps Postgres errors to DataError
// codes, and computes the derived views (lib/data/views.ts) that the fixture
// layer computes from the same row shapes.
//
// Multi-statement writes (ingest, first pass, clips) are not transactional
// here — supabase-js has no client transaction — so they are ordered parent
// first and idempotent where a retry could land (upsert on the natural key).
// The status changes that must be atomic are the SQL functions.
//
// `core` and `studio` must be exposed schemas in the project's API settings
// (docs/data-model.md § 1): a missing entry returns empty results, not an
// error.

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import type { Session } from "@/lib/auth";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase/server";
import { buildVersionSnapshot } from "@/data/fixture/snapshot";
import type {
  AdaptedLine,
  Adaptation,
  AuditEvent,
  Character,
  Clip,
  Episode,
  Job,
  Line,
  LineAlternative,
  Producer,
  ProducerTitleSummary,
  PromoApproval,
  PromoCampaign,
  PromoCampaignDetail,
  PromoCampaignSummary,
  PromoCreative,
  PromoHandoff,
  Scene,
  SceneDecision,
  Title,
  TitleDetail,
  Variant,
  Version,
  VersionSnapshot,
} from "@/lib/types";
import { applyGlobalOffset, assertValidCue } from "@/lib/subtitle-timing";
import { isLlmAvailable } from "@/lib/llm";
import { examplesFromApprovedVersions } from "@/lib/translation-memory";
import { DataError, conflict, invalid, notFound } from "./errors";
import type { DataLayer, ExportSnapshot } from "./index";
import { mediaUrl } from "./storage";
import {
  buildEpisodeSummary,
  buildProducerEpisodeSummary,
  buildProducerReview,
  buildTitleSummary,
  pickCurrentVersion,
  pickProducerVersion,
} from "./views";

// ---- plumbing ------------------------------------------------------------------------------------

type Db = SupabaseClient;

const db = (): Db => createServerSupabase();
const core = (c: Db) => c.schema("core");
const studio = (c: Db) => c.schema("studio");
const promote = (c: Db) => c.schema("promote");

type Result<T> = { data: T | null; error: PostgrestError | null };

/**
 * Postgres -> DataError. The functions raise 42501 for a role failure; the
 * guards raise plain exceptions (P0001) whose text says what happened, so the
 * message decides between frozen / not_found / conflict / invalid.
 */
function mapError(e: PostgrestError): DataError {
  const m = e.message ?? "";
  if (e.code === "42501" || /permission denied|staff only|only$/.test(m)) return new DataError("forbidden", m);
  if (e.code === "PGRST116" || /not found/.test(m)) return new DataError("not_found", m);
  if (e.code === "23505" || /already exists/.test(m)) return new DataError("conflict", m);
  if (/frozen|expected draft|expected in_review|need in_review|may only move|write-once/.test(m)) {
    return new DataError("frozen", m);
  }
  return new DataError("invalid", m);
}

async function many<T>(q: PromiseLike<Result<T[]>>): Promise<T[]> {
  const { data, error } = await q;
  if (error) throw mapError(error);
  return data ?? [];
}

async function one<T>(q: PromiseLike<Result<T>>, what: string, id?: string): Promise<T> {
  const { data, error } = await q;
  if (error) throw mapError(error);
  if (data === null || data === undefined) throw notFound(what, id);
  return data;
}

async function rpc<T>(c: Db, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await studio(c).rpc(fn, args);
  if (error) throw mapError(error);
  return data as T;
}

const now = () => new Date().toISOString();

function blank(s: string | null | undefined): boolean {
  return s === null || s === undefined || s.trim() === "";
}

// ---- row loaders -----------------------------------------------------------------------------------

const version = (c: Db, id: string) =>
  one<Version>(studio(c).from("versions").select("*").eq("id", id).maybeSingle(), "version", id);

const episodeByNumber = (c: Db, titleId: string, n: number) =>
  one<Episode>(
    core(c).from("episodes").select("*").eq("title_id", titleId).eq("number", n).maybeSingle(),
    "episode",
    `${n}`
  );

const adaptationOf = (c: Db, titleId: string) =>
  one<Adaptation>(studio(c).from("adaptations").select("*").eq("title_id", titleId).maybeSingle(), "adaptation for title", titleId);

/** Everything a title's summary needs; small in the pilot (three titles), so one bundle per title is fine. */
async function loadTitleRows(c: Db, title: Title) {
  const [producer, episodes, scenes, lines, versions, adapted, decisions, jobs] = await Promise.all([
    one<Producer>(core(c).from("producers").select("*").eq("id", title.producer_id).maybeSingle(), "producer", title.producer_id),
    many<Episode>(core(c).from("episodes").select("*").eq("title_id", title.id).order("number")),
    many<Scene>(studio(c).from("scenes").select("*").eq("title_id", title.id).order("number")),
    many<Line>(studio(c).from("lines").select("*").eq("title_id", title.id).order("seq")),
    many<Version>(studio(c).from("versions").select("*").eq("title_id", title.id).order("number")),
    many<Pick<AdaptedLine, "version_id" | "scene_id" | "line_id" | "text_en" | "change_type" | "rationale_zh" | "back_translation_zh">>(
      studio(c)
        .from("adapted_lines")
        .select("version_id, scene_id, line_id, text_en, change_type, rationale_zh, back_translation_zh")
        .eq("title_id", title.id)
    ),
    many<Pick<SceneDecision, "version_id" | "scene_id" | "decision">>(
      studio(c).from("scene_decisions").select("version_id, scene_id, decision").eq("title_id", title.id)
    ),
    many<Pick<Job, "cost_cents">>(studio(c).from("jobs").select("cost_cents").eq("title_id", title.id)),
  ]);
  const summaries = episodes.map((episode) => {
    const epScenes = scenes.filter((s) => s.episode_id === episode.id);
    const sceneIds = new Set(epScenes.map((s) => s.id));
    return buildEpisodeSummary({
      episode,
      scenes: epScenes,
      lines: lines.filter((l) => sceneIds.has(l.scene_id)),
      versions: versions.filter((v) => v.episode_id === episode.id),
      adapted_lines: adapted,
      decisions,
    });
  });
  const cost_cents = jobs.reduce((n, j) => n + (j.cost_cents ?? 0), 0);
  return { producer, episodes, summaries, versions, cost_cents };
}

async function snapshotOf(c: Db, v: Version): Promise<VersionSnapshot> {
  const [title, adaptation, episode, characters, scenes, lines, adapted_lines] = await Promise.all([
    one<Title>(core(c).from("titles").select("*").eq("id", v.title_id).maybeSingle(), "title", v.title_id),
    adaptationOf(c, v.title_id),
    one<Episode>(core(c).from("episodes").select("*").eq("id", v.episode_id).maybeSingle(), "episode", v.episode_id),
    many<Character>(studio(c).from("characters").select("*").eq("title_id", v.title_id)),
    many<Scene>(studio(c).from("scenes").select("*").eq("episode_id", v.episode_id).order("number")),
    many<Line>(studio(c).from("lines").select("*").eq("title_id", v.title_id).order("seq")),
    many<AdaptedLine>(studio(c).from("adapted_lines").select("*").eq("version_id", v.id).order("seq")),
  ]);
  return buildVersionSnapshot({ title, adaptation, episode, version: v, characters, scenes, lines, adapted_lines });
}

async function loadPromoDetail(c: Db, campaign: PromoCampaign): Promise<PromoCampaignDetail> {
  const [title, episodes, creatives, approvals, handoffs] = await Promise.all([
    one<Title>(core(c).from("titles").select("*").eq("id", campaign.title_id).maybeSingle(), "title", campaign.title_id),
    many<Episode>(core(c).from("episodes").select("*").eq("title_id", campaign.title_id).order("number")),
    many<PromoCreative>(promote(c).from("creatives").select("*").eq("campaign_id", campaign.id).order("created_at")),
    many<PromoApproval>(promote(c).from("approvals").select("*").eq("campaign_id", campaign.id).order("created_at", { ascending: false }).limit(1)),
    many<PromoHandoff>(promote(c).from("handoffs").select("*").eq("campaign_id", campaign.id).order("attempted_at", { ascending: false })),
  ]);
  return { campaign, title, episodes, creatives, approval: approvals[0] ?? null, handoffs };
}

// ---- the implementation ------------------------------------------------------------------------------

export const supabaseData: DataLayer = {
  // ---- titles and producers ----

  async listTitles(_session: Session) {
    const c = db();
    const titles = await many<Title>(core(c).from("titles").select("*").order("updated_at", { ascending: false }));
    const out = [];
    for (const title of titles) {
      const r = await loadTitleRows(c, title);
      out.push(buildTitleSummary({ title, producer: r.producer, episodes: r.summaries, cost_cents: r.cost_cents }));
    }
    return out;
  },

  async getTitle(_session, titleId): Promise<TitleDetail> {
    const c = db();
    const title = await one<Title>(core(c).from("titles").select("*").eq("id", titleId).maybeSingle(), "title", titleId);
    const [r, adaptation, characters, variants] = await Promise.all([
      loadTitleRows(c, title),
      adaptationOf(c, titleId),
      many<Character>(studio(c).from("characters").select("*").eq("title_id", titleId).order("name_zh")),
      many<Variant>(studio(c).from("variants").select("*").eq("title_id", titleId).eq("selected", true)),
    ]);
    return {
      title,
      producer: r.producer,
      adaptation,
      characters,
      episodes: r.summaries,
      versions: r.versions.map(({ snapshot: _s, ...rest }) => rest),
      cost_cents: r.cost_cents,
      selected_title: variants.find((v) => v.kind === "title") ?? null,
      selected_hook: variants.find((v) => v.kind === "hook") ?? null,
    };
  },

  async createTitle(session, input) {
    const c = db();
    if (blank(input.name_zh)) throw invalid("name_zh is required");
    const producer = await one<Producer>(
      core(c).from("producers").select("*").eq("id", input.producer_id).maybeSingle(),
      "producer",
      input.producer_id
    );
    const title = await one<Title>(
      core(c)
        .from("titles")
        .insert({
          producer_id: producer.id,
          name_zh: input.name_zh.trim(),
          name_en: input.name_en?.trim() || null,
          genre: input.genre?.trim() || null,
          synopsis_zh: input.synopsis_zh?.trim() || null,
          synopsis_en: input.synopsis_en?.trim() || null,
          character_notes: input.character_notes?.trim() || null,
          deliverables: producer.deliverables,
        })
        .select("*")
        .single(),
      "title"
    );
    // One adaptation per title in V1, created with the title.
    await one<Adaptation>(
      studio(c)
        .from("adaptations")
        .insert({ title_id: title.id, display_title_en: title.name_en, created_by: session.userId })
        .select("*")
        .single(),
      "adaptation"
    );
    return title;
  },

  async updateTitle(_session, titleId, patch) {
    const c = db();
    return one<Title>(core(c).from("titles").update(patch).eq("id", titleId).select("*").maybeSingle(), "title", titleId);
  },

  async listProducers(_session) {
    return many<Producer>(core(db()).from("producers").select("*").order("name_zh"));
  },

  async createProducer(_session, input) {
    const c = db();
    if (blank(input.name_zh)) throw invalid("name_zh is required");
    const base = (input.name_en ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    const slug = base || `producer-${randomUUID().slice(0, 8)}`;
    return one<Producer>(
      core(c)
        .from("producers")
        .insert({
          slug,
          name_zh: input.name_zh.trim(),
          name_en: input.name_en?.trim() || null,
          contact_email: input.contact_email?.trim() || null,
          contact_wechat: input.contact_wechat?.trim() || null,
        })
        .select("*")
        .single(),
      "producer"
    );
  },

  // ---- ingest and the workbench ----

  async addEpisodeFromIngest(_session, titleId, episodeNumber, ingest, files) {
    const c = db();
    if (!Number.isInteger(episodeNumber) || episodeNumber < 1) throw invalid("episode_number must be a positive integer");
    if (!ingest.lines.length) throw invalid("the file parsed to no lines");
    const title = await one<Title>(core(c).from("titles").select("*").eq("id", titleId).maybeSingle(), "title", titleId);
    const adaptation = await adaptationOf(c, titleId);
    const { data: dup } = await core(c).from("episodes").select("id").eq("title_id", titleId).eq("number", episodeNumber).maybeSingle();
    if (dup) throw conflict(`episode ${episodeNumber} already exists for this title`);

    const lastEnd = ingest.lines.reduce<number | null>((m, l) => (l.end_ms !== null && (m === null || l.end_ms > m) ? l.end_ms : m), null);
    const episode = await one<Episode>(
      core(c)
        .from("episodes")
        .insert({
          title_id: titleId,
          number: episodeNumber,
          duration_ms: ingest.hasTimecodes ? lastEnd : null,
          source_script_path: files.subtitlePath,
          script_format: ingest.format,
          has_timecodes: ingest.hasTimecodes,
          video_path: files.videoPath,
        })
        .select("*")
        .single(),
      "episode"
    );

    // Speakers become characters (unique on title_id, name_zh; a re-run is a no-op).
    const speakers = Array.from(new Set(ingest.lines.map((l) => l.speaker?.trim()).filter((s): s is string => !!s)));
    if (speakers.length) {
      await many<Character>(
        studio(c)
          .from("characters")
          .upsert(
            speakers.map((name_zh) => ({ title_id: titleId, name_zh })),
            { onConflict: "title_id,name_zh", ignoreDuplicates: true }
          )
          .select("*")
      );
    }
    const characters = await many<Character>(studio(c).from("characters").select("*").eq("title_id", titleId));
    const byName = new Map(characters.map((ch) => [ch.name_zh, ch.id]));

    const scenes = await many<Scene>(
      studio(c)
        .from("scenes")
        .insert(
          ingest.scenes.map((sc) => ({
            title_id: titleId,
            episode_id: episode.id,
            number: sc.number,
            start_ms: ingest.hasTimecodes ? sc.start_ms : null,
            end_ms: ingest.hasTimecodes ? sc.end_ms : null,
          }))
        )
        .select("*")
    );
    const sceneByNumber = new Map(scenes.map((s) => [s.number, s.id]));
    const sceneFor = (seq: number): string => {
      const sc = ingest.scenes.find((x) => seq >= x.from_seq && seq <= x.to_seq) ?? ingest.scenes[ingest.scenes.length - 1];
      const id = sceneByNumber.get(sc.number);
      if (!id) throw invalid(`scene ${sc.number} was not created`);
      return id;
    };
    await many<Line>(
      studio(c)
        .from("lines")
        .insert(
          ingest.lines.map((l) => {
            const speaker = l.speaker?.trim() || null;
            return {
              title_id: titleId,
              scene_id: sceneFor(l.seq),
              seq: l.seq,
              speaker,
              character_id: speaker ? byName.get(speaker) ?? null : null,
              start_ms: ingest.hasTimecodes ? l.start_ms : null,
              end_ms: ingest.hasTimecodes ? l.end_ms : null,
              text_zh: l.text_zh,
            };
          })
        )
        .select("id")
    );

    const at = now();
    await many<Job>(
      studio(c)
        .from("jobs")
        .insert({
          title_id: titleId,
          episode_id: episode.id,
          kind: "parse_subtitles",
          target_type: "episode",
          target_id: episode.id,
          idempotency_key: `parse_subtitles:${episode.id}:1`,
          status: "done",
          input: { format: ingest.format, filename: files.subtitlePath },
          output: { lines: ingest.lines.length, scenes: scenes.length, has_timecodes: ingest.hasTimecodes, warnings: ingest.warnings },
          cost_cents: 0,
          heartbeat_at: at,
          started_at: at,
          finished_at: at,
        })
        .select("id")
    );

    await one<Version>(
      studio(c)
        .from("versions")
        .insert({ title_id: titleId, adaptation_id: adaptation.id, episode_id: episode.id, number: 1 })
        .select("*")
        .single(),
      "version"
    );

    if (title.status === "candidate" || title.status === "selected") {
      await core(c).from("titles").update({ status: "ingesting" }).eq("id", titleId);
    }
    return episode;
  },

  async addVideoOnlyEpisode(_session, titleId, episodeNumber, videoPath) {
    const c = db();
    if (!Number.isInteger(episodeNumber) || episodeNumber < 1) throw invalid("episode_number must be a positive integer");
    const { data: dup } = await core(c).from("episodes").select("id").eq("title_id", titleId).eq("number", episodeNumber).maybeSingle();
    if (dup) throw conflict(`episode ${episodeNumber} already exists for this title`);
    const episode = await one<Episode>(core(c).from("episodes").insert({ title_id: titleId, number: episodeNumber, video_path: videoPath, source_script_path: null, script_format: null, has_timecodes: false }).select("*").single(), "episode");
    await core(c).from("titles").update({ status: "ingesting", updated_at: now() }).eq("id", titleId);
    return episode;
  },

  async getWorkbench(_session, titleId, episodeNumber) {
    const c = db();
    const [title, adaptation, episode] = await Promise.all([
      one<Title>(core(c).from("titles").select("*").eq("id", titleId).maybeSingle(), "title", titleId),
      adaptationOf(c, titleId),
      episodeByNumber(c, titleId, episodeNumber),
    ]);
    const [characters, scenes, versions] = await Promise.all([
      many<Character>(studio(c).from("characters").select("*").eq("title_id", titleId).order("name_zh")),
      many<Scene>(studio(c).from("scenes").select("*").eq("episode_id", episode.id).order("number")),
      many<Version>(studio(c).from("versions").select("*").eq("episode_id", episode.id).order("number")),
    ]);
    const sceneIds = scenes.map((s) => s.id);
    const version = pickCurrentVersion(versions);
    const decisionVersionId = version?.status === "draft" ? version.parent_version_id : version?.id;
    const [lines, adapted_lines, alternatives, decisions] = await Promise.all([
      sceneIds.length ? many<Line>(studio(c).from("lines").select("*").in("scene_id", sceneIds).order("seq")) : [],
      version ? many<AdaptedLine>(studio(c).from("adapted_lines").select("*").eq("version_id", version.id).order("seq")) : [],
      version ? many<LineAlternative>(studio(c).from("line_alternatives").select("*").eq("version_id", version.id).order("seq")) : [],
      decisionVersionId
        ? many<SceneDecision>(studio(c).from("scene_decisions").select("*").eq("version_id", decisionVersionId))
        : [],
    ]);
    return {
      title,
      adaptation,
      episode,
      characters,
      scenes,
      lines,
      version,
      adapted_lines,
      alternatives,
      decisions,
      video_url: mediaUrl(episode.video_path),
      ai_available: isLlmAvailable(),
    };
  },

  async listApprovedTranslationMemory(_session, titleId) {
    // Authorize the caller against the target title under RLS first. The
    // corpus query then uses the service role so a producer can benefit from
    // Studio-wide approved work without receiving another producer's rows in
    // any route response.
    const userClient = db();
    await one<Pick<Title, "id">>(
      core(userClient).from("titles").select("id").eq("id", titleId).maybeSingle(),
      "title",
      titleId
    );
    const serviceClient = createServiceSupabase();
    const approved = await many<Pick<Version, "id" | "status" | "approved_at" | "snapshot">>(
      studio(serviceClient)
        .from("versions")
        .select("id, status, approved_at, snapshot")
        .eq("status", "approved")
        .not("snapshot", "is", null)
        .order("approved_at", { ascending: false })
        .limit(50)
    );
    return examplesFromApprovedVersions(approved);
  },

  async upsertCharacters(_session, titleId, characters) {
    const c = db();
    const rows = characters
      .filter((ch) => !blank(ch.name_zh))
      .map((ch) => ({ title_id: titleId, name_zh: ch.name_zh.trim(), name_en: ch.name_en ?? null, notes: ch.notes ?? null }));
    if (rows.length) {
      await many<Character>(studio(c).from("characters").upsert(rows, { onConflict: "title_id,name_zh" }).select("*"));
    }
    const all = await many<Character>(studio(c).from("characters").select("*").eq("title_id", titleId).order("name_zh"));
    // Resolve lines that carry this speaker but no character yet.
    for (const ch of all) {
      await studio(c).from("lines").update({ character_id: ch.id }).eq("title_id", titleId).eq("speaker", ch.name_zh).is("character_id", null);
    }
    return all;
  },

  async setSceneContext(_session, sceneId, context) {
    return one<Scene>(studio(db()).from("scenes").update(context).eq("id", sceneId).select("*").maybeSingle(), "scene", sceneId);
  },

  async writeFirstPass(_session, versionId, sceneId, lines) {
    const c = db();
    const v = await version(c, versionId);
    if (v.status !== "draft") throw new DataError("frozen", `version is ${v.status}; fork it to edit`);
    const scene = await one<Scene>(studio(c).from("scenes").select("*").eq("id", sceneId).maybeSingle(), "scene", sceneId);
    if (scene.episode_id !== v.episode_id) throw invalid("scene is not in this version's episode");
    const [source, existing] = await Promise.all([
      many<Line>(studio(c).from("lines").select("*").eq("scene_id", scene.id)),
      many<AdaptedLine>(studio(c).from("adapted_lines").select("*").eq("version_id", v.id).eq("scene_id", scene.id)),
    ]);
    const srcById = new Map(source.map((l) => [l.id, l]));
    const editorLines = new Set(existing.filter((a) => a.authored_by === "editor").map((a) => a.line_id));
    const rows = [];
    for (const fp of lines) {
      const src = srcById.get(fp.line_id);
      if (!src) throw notFound("line in scene", fp.line_id);
      await studio(c).from("lines").update({ literal_en: fp.literal_en }).eq("id", src.id);
      if (editorLines.has(src.id)) continue; // a hand edit is never overwritten by a re-run
      rows.push({
        title_id: v.title_id,
        version_id: v.id,
        scene_id: scene.id,
        line_id: src.id,
        seq: src.seq,
        start_ms: src.start_ms,
        end_ms: src.end_ms,
        text_en: fp.text_en,
        key_phrase_en: fp.key_phrase_en ?? null,
        back_translation_zh: fp.back_translation_zh,
        change_type: fp.change_type,
        is_major: fp.is_major,
        rationale_en: fp.rationale_en,
        rationale_zh: fp.rationale_zh,
        tone_note_en: fp.tone_note_en ?? null,
        tone_note_zh: fp.tone_note_zh ?? null,
        tags: fp.tags ?? [],
        syllables_est: fp.syllables_est ?? null,
        authored_by: "ai",
        model: fp.model,
        prompt_version: fp.prompt_version,
        ai_text_en: fp.text_en,
        ai_rationale_zh: fp.rationale_zh,
        edited_by: null,
      });
    }
    if (rows.length) {
      await many<AdaptedLine>(studio(c).from("adapted_lines").upsert(rows, { onConflict: "version_id,scene_id,seq" }).select("id"));
    }
    return many<AdaptedLine>(studio(c).from("adapted_lines").select("*").eq("version_id", v.id).eq("scene_id", scene.id).order("seq"));
  },

  async updateAdaptedLine(session, adaptedLineId, patch, opts) {
    const c = db();
    const update: Record<string, unknown> = {
      ...patch,
      authored_by: opts?.authored_by ?? "editor",
      edited_by: session.userId,
    };
    if (patch.change_type === "cut") update.text_en = null;
    if (patch.text_en !== undefined && patch.key_phrase_en === undefined) update.key_phrase_en = null;
    if (opts?.model !== undefined) update.model = opts.model;
    if (opts?.prompt_version !== undefined) update.prompt_version = opts.prompt_version;
    return one<AdaptedLine>(
      studio(c).from("adapted_lines").update(update).eq("id", adaptedLineId).select("*").maybeSingle(),
      "adapted line",
      adaptedLineId
    );
  },

  async addAlternatives(_session, adaptedLineId, alternatives) {
    const c = db();
    const line = await one<AdaptedLine>(
      studio(c).from("adapted_lines").select("*").eq("id", adaptedLineId).maybeSingle(),
      "adapted line",
      adaptedLineId
    );
    const existing = await many<Pick<LineAlternative, "seq">>(
      studio(c).from("line_alternatives").select("seq").eq("adapted_line_id", line.id)
    );
    let seq = existing.reduce((m, a) => Math.max(m, a.seq), 0);
    return many<LineAlternative>(
      studio(c)
        .from("line_alternatives")
        .insert(
          alternatives.map((alt) => ({
            title_id: line.title_id,
            version_id: line.version_id,
            adapted_line_id: line.id,
            seq: ++seq,
            text_en: alt.text_en,
            back_translation_zh: alt.back_translation_zh ?? null,
            rationale_zh: alt.rationale_zh,
            rationale_en: alt.rationale_en ?? null,
            tags: alt.tags ?? [],
            syllables_est: alt.syllables_est ?? null,
            model: alt.model,
            prompt_version: alt.prompt_version,
            job_id: alt.job_id ?? null,
          }))
        )
        .select("*")
    );
  },

  async chooseAlternative(_session, adaptedLineId, alternativeId) {
    const c = db();
    const alt = await one<LineAlternative>(
      studio(c).from("line_alternatives").select("*").eq("id", alternativeId).maybeSingle(),
      "alternative",
      alternativeId
    );
    if (alt.adapted_line_id !== adaptedLineId) throw invalid("alternative belongs to another line");
    await rpc<string>(c, "choose_alternative", { p_alternative_id: alternativeId });
    return one<AdaptedLine>(
      studio(c).from("adapted_lines").select("*").eq("id", adaptedLineId).maybeSingle(),
      "adapted line",
      adaptedLineId
    );
  },

  async applyEpisodeTimingOffset(session, titleId, episodeNumber, offsetMs) {
    if (!Number.isInteger(offsetMs) || offsetMs === 0) throw new DataError("invalid", "offset_ms must be a non-zero integer");
    if (Math.abs(offsetMs) > 60_000) throw new DataError("invalid", "offset_ms must stay within one minute");
    const wb = await supabaseData.getWorkbench(session, titleId, episodeNumber);
    if (!wb.episode.has_timecodes) throw new DataError("invalid", "this episode has no timecodes to shift");
    const c = db();
    const lines = wb.lines
      .filter((l) => !l.merged_into_id)
      .sort((a, b) => (a.start_ms ?? 0) - (b.start_ms ?? 0) || a.seq - b.seq);
    const r = applyGlobalOffset(lines, offsetMs);
    for (let i = 0; i < lines.length; i++) {
      const next = r.cues[i];
      if (next.start_ms === lines[i].start_ms && next.end_ms === lines[i].end_ms) continue;
      await one(
        studio(c)
          .from("lines")
          .update({ start_ms: next.start_ms, end_ms: next.end_ms, duration_ms: next.start_ms !== null && next.end_ms !== null ? next.end_ms - next.start_ms : null })
          .eq("id", lines[i].id)
          .select("id")
          .maybeSingle(),
        "line",
        lines[i].id
      );
      await studio(c).from("adapted_lines").update({ start_ms: next.start_ms, end_ms: next.end_ms }).eq("line_id", lines[i].id);
    }
    await syncSupabaseTimingMirrors(c, wb.episode.id, r.cues);
    return { shifted: r.shifted, clamped: r.clamped };
  },

  async updateLineTimings(session, titleId, episodeNumber, updates) {
    if (!updates.length) throw new DataError("invalid", "no timing updates given");
    const wb = await supabaseData.getWorkbench(session, titleId, episodeNumber);
    const byId = new Map(wb.lines.map((l) => [l.id, l]));
    for (const u of updates) {
      const line = byId.get(u.line_id);
      if (!line) throw new DataError("not_found", `line ${u.line_id} is not in this episode`);
      try {
        assertValidCue(u);
      } catch (e) {
        throw new DataError("invalid", `line seq ${line.seq}: ${(e as Error).message}`);
      }
    }
    const c = db();
    for (const u of updates) {
      await one(
        studio(c)
          .from("lines")
          .update({ start_ms: u.start_ms, end_ms: u.end_ms, duration_ms: u.end_ms - u.start_ms })
          .eq("id", u.line_id)
          .select("id")
          .maybeSingle(),
        "line",
        u.line_id
      );
      await studio(c).from("adapted_lines").update({ start_ms: u.start_ms, end_ms: u.end_ms }).eq("line_id", u.line_id);
      const line = byId.get(u.line_id)!;
      line.start_ms = u.start_ms;
      line.end_ms = u.end_ms;
    }
    await studio(c).from("episodes").update({ has_timecodes: true }).eq("id", wb.episode.id);
    await syncSupabaseTimingMirrors(c, wb.episode.id, wb.lines.filter((l) => !l.merged_into_id));
    return { updated: updates.length };
  },

  async retimeEpisodeFromStamps() {
    // Mirrors the burn: repair tooling is fixture-only in V1 (logged debt).
    throw new DataError("invalid", "the stamp-retime repair runs in fixture mode only in V1");
  },

  async setEpisodeVideo(_session, titleId, episodeNumber, storedPath) {
    const c = db();
    return one<Episode>(
      core(c)
        .from("episodes")
        .update({ video_path: storedPath })
        .eq("title_id", titleId)
        .eq("number", episodeNumber)
        .select("*")
        .maybeSingle(),
      "episode",
      `${episodeNumber}`
    );
  },

  async setSceneStatus(_session, sceneId, status) {
    const c = db();
    await rpc<string>(c, "set_scene_status", { p_scene_id: sceneId, p_status: status });
    return one<Scene>(studio(c).from("scenes").select("*").eq("id", sceneId).maybeSingle(), "scene", sceneId);
  },

  // ---- the gate ----

  async submitVersion(_session, versionId) {
    const c = db();
    await rpc<string>(c, "submit_version", { p_version_id: versionId });
    return version(c, versionId);
  },

  async approveVersion(_session, versionId, opts) {
    const c = db();
    if (opts.mode === "on_behalf" && blank(opts.evidenceNote)) throw invalid("on_behalf requires an evidence note");
    await rpc<string>(c, "approve_version", {
      p_version_id: versionId,
      p_mode: opts.mode === "producer" ? "in_app" : "on_behalf",
      p_evidence: opts.mode === "on_behalf" ? opts.evidenceNote : null,
      p_note: opts.note ?? null,
      p_channel: opts.channel ?? null,
    });
    return version(c, versionId);
  },

  async forkVersion(_session, versionId) {
    const c = db();
    const newId = await rpc<string>(c, "fork_version", { p_version_id: versionId });
    return version(c, newId);
  },

  async finalizeVersion(_session, versionId) {
    // studio.finalize_version — supabase/migrations/0002_producer_selfserve.sql.
    const c = db();
    await rpc<string>(c, "finalize_version", { p_version_id: versionId });
    return version(c, versionId);
  },

  async decideScene(_session, versionId, sceneId, decision, note, lineId) {
    const c = db();
    const cleanNote = blank(note) ? null : (note as string).trim();
    if (decision === "needs_alternative" && !cleanNote) throw invalid("needs_alternative requires a one-line reason");
    return rpc<SceneDecision>(c, "decide_scene", {
      p_version_id: versionId,
      p_scene_id: sceneId,
      p_decision: decision,
      p_note: cleanNote,
      p_line_id: lineId ?? null,
      p_channel: "in_app",
    });
  },

  async respondToFeedback(_session, versionId, sceneId, disposition, note) {
    if (blank(note)) throw invalid("a response explaining Pulsar's decision is required");
    return rpc<SceneDecision>(db(), "respond_to_scene_feedback", {
      p_version_id: versionId,
      p_scene_id: sceneId,
      p_disposition: disposition,
      p_note: note.trim(),
    });
  },

  // ---- creative pack ----

  async listVariants(_session, titleId) {
    return many<Variant>(studio(db()).from("variants").select("*").eq("title_id", titleId).order("created_at"));
  },

  async upsertVariants(session, titleId, variants) {
    const c = db();
    const adaptation = await adaptationOf(c, titleId);
    if (variants.length) {
      await many<Variant>(
        studio(c)
          .from("variants")
          .insert(
            variants.map((v) => ({
              title_id: titleId,
              adaptation_id: adaptation.id,
              kind: v.kind,
              text_en: v.text_en,
              text_zh: v.text_zh ?? null,
              rationale_en: v.rationale_en ?? null,
              rationale_zh: v.rationale_zh ?? null,
              tags: v.tags ?? [],
              model: v.model ?? null,
              prompt_version: v.prompt_version ?? null,
              job_id: v.job_id ?? null,
              created_by: v.model ? null : session.userId,
            }))
          )
          .select("id")
      );
    }
    return many<Variant>(studio(c).from("variants").select("*").eq("title_id", titleId).order("created_at"));
  },

  async selectVariant(_session, variantId) {
    const c = db();
    await rpc<string>(c, "select_variant", { p_variant_id: variantId });
    return one<Variant>(studio(c).from("variants").select("*").eq("id", variantId).maybeSingle(), "variant", variantId);
  },

  async dismissVariant(_session, variantId, dismissed = true) {
    const c = db();
    // `selected` is UPDATE-revoked from authenticated; the check constraint forbids a selected dismissed row,
    // so a selected pick must be re-picked elsewhere before it can be dismissed (the route surfaces the error).
    return one<Variant>(
      studio(c)
        .from("variants")
        .update({ status: dismissed ? "dismissed" : "candidate" })
        .eq("id", variantId)
        .select("*")
        .maybeSingle(),
      "variant",
      variantId
    );
  },

  async listClips(_session, titleId, episodeNumber) {
    const c = db();
    let q = studio(c).from("clips").select("*").eq("title_id", titleId);
    if (episodeNumber !== undefined) {
      const episode = await episodeByNumber(c, titleId, episodeNumber);
      q = q.eq("episode_id", episode.id);
    }
    const [clips, episodes] = await Promise.all([
      many<Clip>(q.order("rank")),
      many<Pick<Episode, "id" | "number">>(core(c).from("episodes").select("id, number").eq("title_id", titleId)),
    ]);
    const number = new Map(episodes.map((e) => [e.id, e.number]));
    return clips.sort((a, b) => (number.get(a.episode_id) ?? 0) - (number.get(b.episode_id) ?? 0) || a.rank - b.rank);
  },

  async upsertClips(_session, episodeId, clips) {
    const c = db();
    const episode = await one<Episode>(core(c).from("episodes").select("*").eq("id", episodeId).maybeSingle(), "episode", episodeId);
    if (!episode.has_timecodes) throw invalid("clips need a timed episode");
    const adaptation = await adaptationOf(c, episode.title_id);
    // A re-run replaces 'suggested' rows only; shortlisted / dismissed keep their rank.
    const { error } = await studio(c).from("clips").delete().eq("episode_id", episodeId).eq("status", "suggested");
    if (error) throw mapError(error);
    const kept = await many<Pick<Clip, "rank">>(studio(c).from("clips").select("rank").eq("episode_id", episodeId));
    const taken = new Set(kept.map((k) => k.rank));
    let cursor = 1;
    const nextFree = (preferred?: number): number => {
      if (preferred !== undefined && preferred > 0 && !taken.has(preferred)) return preferred;
      while (taken.has(cursor)) cursor++;
      return cursor;
    };
    if (clips.length) {
      await many<Clip>(
        studio(c)
          .from("clips")
          .insert(
            clips.map((cl) => {
              const rank = nextFree(cl.rank);
              taken.add(rank);
              return {
                title_id: episode.title_id,
                episode_id: episodeId,
                adaptation_id: adaptation.id,
                rank,
                start_ms: cl.start_ms,
                end_ms: cl.end_ms,
                scene_ids: cl.scene_ids,
                hook_en: cl.hook_en,
                why_en: cl.why_en,
                why_zh: cl.why_zh,
                opening_text_en: cl.opening_text_en ?? null,
                cut_length_s: cl.cut_length_s ?? null,
                angle: cl.angle ?? null,
                model: cl.model ?? null,
                prompt_version: cl.prompt_version ?? null,
                job_id: cl.job_id ?? null,
              };
            })
          )
          .select("id")
      );
    }
    return many<Clip>(studio(c).from("clips").select("*").eq("episode_id", episodeId).order("rank"));
  },

  async setClipStatus(_session, clipId, status) {
    return one<Clip>(studio(db()).from("clips").update({ status }).eq("id", clipId).select("*").maybeSingle(), "clip", clipId);
  },

  // ---- jobs and cost ----

  async recordJob(_session, job) {
    const c = db();
    const at = now();
    const { data: existing, error } = await studio(c).from("jobs").select("*").eq("idempotency_key", job.idempotency_key).maybeSingle();
    if (error) throw mapError(error);
    const prior = existing as Job | null;
    if (prior?.status === "done") return prior;
    if (prior) {
      return one<Job>(
        studio(c)
          .from("jobs")
          .update({ status: "running", error: null, started_at: at, heartbeat_at: at, finished_at: null })
          .eq("id", prior.id)
          .select("*")
          .maybeSingle(),
        "job",
        prior.id
      );
    }
    return one<Job>(
      studio(c)
        .from("jobs")
        .insert({
          title_id: job.title_id,
          episode_id: job.episode_id ?? null,
          version_id: job.version_id ?? null,
          kind: job.kind,
          target_type: job.target_type,
          target_id: job.target_id,
          idempotency_key: job.idempotency_key,
          status: "running",
          provider: job.provider ?? null,
          model: job.model ?? null,
          input: job.input ?? null,
          heartbeat_at: at,
          started_at: at,
        })
        .select("*")
        .single(),
      "job"
    );
  },

  async finishJob(jobId, result) {
    const at = now();
    const update: Record<string, unknown> = { status: result.status, heartbeat_at: at, finished_at: at };
    if (result.usage !== undefined) update.usage = result.usage;
    if (result.cost_cents !== undefined) update.cost_cents = result.cost_cents;
    if (result.output !== undefined) update.output = result.output;
    if (result.error !== undefined) update.error = result.error;
    return one<Job>(studio(db()).from("jobs").update(update).eq("id", jobId).select("*").maybeSingle(), "job", jobId);
  },

  async sumCostCents(titleId) {
    const rows = await many<Pick<Job, "cost_cents">>(studio(db()).from("jobs").select("cost_cents").eq("title_id", titleId));
    return rows.reduce((n, j) => n + (j.cost_cents ?? 0), 0);
  },

  // ---- partner portal ----

  async getProducerTitles(_session) {
    const c = db();
    // RLS already limits a producer to their own titles and to in_review / approved versions.
    const titles = await many<Title>(core(c).from("titles").select("*").order("updated_at", { ascending: false }));
    const out: ProducerTitleSummary[] = [];
    for (const title of titles) {
      const [episodes, scenes, versions, decisions] = await Promise.all([
        many<Episode>(core(c).from("episodes").select("*").eq("title_id", title.id).order("number")),
        many<Pick<Scene, "id" | "episode_id">>(studio(c).from("scenes").select("id, episode_id").eq("title_id", title.id)),
        many<Version>(studio(c).from("versions").select("*").eq("title_id", title.id).order("number")),
        many<SceneDecision>(studio(c).from("scene_decisions").select("*").eq("title_id", title.id)),
      ]);
      out.push({
        id: title.id,
        external_id: title.external_id,
        name_zh: title.name_zh,
        name_en: title.name_en,
        genre: title.genre,
        episode_count: Math.max(title.episode_count ?? 0, episodes.length),
        episodes: episodes.flatMap((episode) => {
          const v = pickProducerVersion(versions.filter((x) => x.episode_id === episode.id));
          if (!v) return [];
          return [
            buildProducerEpisodeSummary({
              episode,
              version: v,
              scenes_total: scenes.filter((s) => s.episode_id === episode.id).length,
              decisions,
            }),
          ];
        }),
        updated_at: title.updated_at,
      });
    }
    return out;
  },

  async getProducerReview(session, titleId, episodeNumber) {
    const c = db();
    const [title, episode] = await Promise.all([
      one<Title>(core(c).from("titles").select("*").eq("id", titleId).maybeSingle(), "title", titleId),
      episodeByNumber(c, titleId, episodeNumber),
    ]);
    const versions = await many<Version>(studio(c).from("versions").select("*").eq("episode_id", episode.id).order("number"));
    const v = pickProducerVersion(versions);
    if (!v || !v.snapshot) throw notFound("submitted version for episode", `${episodeNumber}`);
    const previousVersion = v.parent_version_id ? versions.find((item) => item.id === v.parent_version_id) ?? null : null;
    const [decisions, previousDecisions] = await Promise.all([
      many<SceneDecision>(studio(c).from("scene_decisions").select("*").eq("version_id", v.id)),
      previousVersion
        ? many<SceneDecision>(studio(c).from("scene_decisions").select("*").eq("version_id", previousVersion.id))
        : Promise.resolve([]),
    ]);
    const own = session.kind === "producer" && session.producerId === title.producer_id;
    const admin = session.kind === "staff" && session.staffRole === "admin";
    return buildProducerReview({
      version: v,
      snapshot: v.snapshot,
      decisions,
      previous: previousVersion?.snapshot
        ? { version: previousVersion, snapshot: previousVersion.snapshot, decisions: previousDecisions }
        : null,
      can_decide: (own && (session.producerRole === "approver" || session.producerRole === "reviewer")) || admin,
      can_approve: (own && session.producerRole === "approver") || admin,
      video_url: mediaUrl(episode.video_path),
    });
  },

  // ---- Promote ----

  async listPromoCampaigns(_session) {
    const c = db();
    const campaigns = await many<PromoCampaign>(promote(c).from("campaigns").select("*").order("updated_at", { ascending: false }));
    const out: PromoCampaignSummary[] = [];
    for (const campaign of campaigns) {
      const [title, producer, creatives] = await Promise.all([
        one<Title>(core(c).from("titles").select("*").eq("id", campaign.title_id).maybeSingle(), "title", campaign.title_id),
        one<Producer>(core(c).from("producers").select("*").eq("id", campaign.producer_id).maybeSingle(), "producer", campaign.producer_id),
        many<Pick<PromoCreative, "status">>(promote(c).from("creatives").select("status").eq("campaign_id", campaign.id).neq("status", "superseded")),
      ]);
      out.push({
        ...campaign, title_name_zh: title.name_zh, title_name_en: title.name_en, producer_name_zh: producer.name_zh, producer_name_en: producer.name_en,
        creative_count: creatives.length, approved_count: creatives.filter((x) => x.status === "approved").length,
        pending_count: creatives.filter((x) => x.status === "ready").length, change_count: creatives.filter((x) => x.status === "rejected").length,
      });
    }
    return out;
  },

  async getPromoCampaign(_session, campaignId) {
    const c = db();
    const campaign = await one<PromoCampaign>(promote(c).from("campaigns").select("*").eq("id", campaignId).maybeSingle(), "promotion campaign", campaignId);
    return loadPromoDetail(c, campaign);
  },

  async createPromoCampaign(session, input) {
    const c = db();
    if (blank(input.name) || blank(input.target_market)) throw invalid("campaign name and target market are required");
    if (input.destination_url) {
      try { new URL(input.destination_url); } catch { throw invalid("destination URL is invalid"); }
    }
    const title = await one<Title>(core(c).from("titles").select("*").eq("id", input.title_id).maybeSingle(), "title", input.title_id);
    return one<PromoCampaign>(
      promote(c).from("campaigns").insert({ title_id: title.id, producer_id: title.producer_id, name: input.name.trim(), target_market: input.target_market.trim(), destination_url: input.destination_url?.trim() || null, objective: input.objective, spoiler_level: input.spoiler_level, creative_direction: input.creative_direction?.trim() || null, exclusions: input.exclusions?.trim() || null, created_by: session.userId }).select("*").single(),
      "promotion campaign"
    );
  },

  async generatePromoDrafts(_session, campaignId) {
    const c = db();
    const campaign = await one<PromoCampaign>(promote(c).from("campaigns").select("*").eq("id", campaignId).maybeSingle(), "promotion campaign", campaignId);
    const existing = await many<PromoCreative>(promote(c).from("creatives").select("*").eq("campaign_id", campaign.id).neq("status", "superseded"));
    if (existing.length) return existing;
    const [title, episodes] = await Promise.all([
      one<Title>(core(c).from("titles").select("*").eq("id", campaign.title_id).maybeSingle(), "title", campaign.title_id),
      many<Episode>(core(c).from("episodes").select("*").eq("title_id", campaign.title_id).not("video_path", "is", null).order("number")),
    ]);
    if (!episodes.length) throw invalid("upload at least one drama episode video before generating creatives");
    const kinds: PromoCreative["kind"][] = ["direct_clip", "ugc_story", "direct_clip", "ugc_reaction", "direct_clip"];
    const hypotheses = ["Open on the reversal before revealing how the characters got there.", "Frame the central conflict like a viewer telling a friend what they just watched.", "Lead with the highest-stakes confrontation and stop before the answer.", "Use a disbelief reaction to make the plot twist feel socially shareable.", "Build escalating cuts around the relationship power shift."];
    const payload = kinds.map((kind, index) => {
      const episode = episodes[index % episodes.length];
      const available = Math.max(15_000, episode.duration_ms ?? 45_000);
      const start = Math.min(index * 4_000, Math.max(0, available - 15_000));
      const end = Math.min(available, start + (kind === "direct_clip" ? 18_000 : 24_000));
      return { campaign_id: campaign.id, title_id: campaign.title_id, kind, status: "ready", hypothesis: hypotheses[index], source_episode_id: episode.id, source_start_ms: start, source_end_ms: end, hook: kind === "direct_clip" ? "Wait for the moment everything changes." : "I thought this was a love story—then this happened.", caption: `${title.name_en || title.name_zh}: one choice changes everything.`, ad_description: `Watch ${title.name_en || title.name_zh} and see what happens next.`, duration_ms: end - start, width: 1080, height: 1920, render_settings: { schema: 1, format: "9:16", source: "concept_preview", captions: true } };
    });
    const rows = await many<PromoCreative>(promote(c).from("creatives").insert(payload).select("*"));
    await one<PromoCampaign>(promote(c).from("campaigns").update({ status: "review", updated_at: now() }).eq("id", campaign.id).select("*").maybeSingle(), "promotion campaign", campaign.id);
    return rows;
  },

  async reviewPromoCreative(_session, creativeId, input) {
    if (input.status === "rejected" && blank(input.rejection_note)) throw invalid("tell us what to change when rejecting a creative");
    return one<PromoCreative>(promote(db()).from("creatives").update({ status: input.status, rejection_note: input.status === "rejected" ? input.rejection_note?.trim() || null : null, updated_at: now() }).eq("id", creativeId).select("*").maybeSingle(), "promotion creative", creativeId);
  },

  async approveAllPromoCreatives(_session, campaignId) {
    const c = db();
    const campaign = await one<PromoCampaign>(promote(c).from("campaigns").select("*").eq("id", campaignId).maybeSingle(), "promotion campaign", campaignId);
    if (campaign.status !== "review") throw conflict("creative review is closed");
    await many<PromoCreative>(promote(c).from("creatives").update({ status: "approved", updated_at: now() }).eq("campaign_id", campaign.id).eq("status", "ready").select("*"));
    return loadPromoDetail(c, campaign);
  },

  async approvePromoCampaign(_session, campaignId) {
    const c = db();
    const { error } = await promote(c).rpc("approve_campaign", { p_campaign_id: campaignId });
    if (error) throw mapError(error);
    const campaign = await one<PromoCampaign>(promote(c).from("campaigns").select("*").eq("id", campaignId).maybeSingle(), "promotion campaign", campaignId);
    return loadPromoDetail(c, campaign);
  },

  async submitPromoCampaignMock(_session, campaignId) {
    const c = db();
    const detail = await loadPromoDetail(c, await one<PromoCampaign>(promote(c).from("campaigns").select("*").eq("id", campaignId).maybeSingle(), "promotion campaign", campaignId));
    if (detail.campaign.status === "submitted") return detail;
    if (detail.campaign.status !== "approved" || !detail.approval) throw conflict("approve the campaign before launch submission");
    const idempotency_key = `studio:${detail.campaign.external_id}:${detail.approval.manifest_sha256}`;
    const growId = `cmp_mock_${detail.campaign.external_id.slice(3)}`;
    await one<PromoHandoff>(promote(c).from("handoffs").insert({ campaign_id: campaignId, idempotency_key, request_sha256: detail.approval.manifest_sha256, status: "accepted", grow_campaign_id: growId, response: { mock: true, grow_campaign_id: growId } }).select("*").single(), "promotion handoff");
    const campaign = await one<PromoCampaign>(promote(c).from("campaigns").update({ status: "submitted", grow_campaign_id: growId, updated_at: now() }).eq("id", campaignId).select("*").maybeSingle(), "promotion campaign", campaignId);
    return loadPromoDetail(c, campaign);
  },

  // ---- Pulsar's Promote desk (staff) ----

  async revisePromoCreative(session, creativeId, input) {
    if (session.kind !== "staff") throw new DataError("forbidden", "Pulsar staff only");
    const c = db();
    const parent = await one<PromoCreative>(promote(c).from("creatives").select("*").eq("id", creativeId).maybeSingle(), "promotion creative", creativeId);
    const campaign = await one<PromoCampaign>(promote(c).from("campaigns").select("*").eq("id", parent.campaign_id).maybeSingle(), "promotion campaign", parent.campaign_id);
    if (campaign.status !== "review") throw conflict("approved promotion is frozen; revisions need a new round");
    if (parent.status !== "rejected" && parent.status !== "ready") throw conflict("only a creative awaiting review or change can be revised");
    if (blank(input.hook) || blank(input.caption) || blank(input.ad_description)) throw invalid("hook, caption and description are required");
    const start = input.source_start_ms ?? parent.source_start_ms;
    const end = input.source_end_ms ?? parent.source_end_ms;
    if (start !== null && end !== null && end <= start) throw invalid("source end must come after source start");
    const revision = await one<PromoCreative>(
      promote(c).from("creatives").insert({
        campaign_id: parent.campaign_id, title_id: parent.title_id, parent_creative_id: parent.id, version: parent.version + 1, kind: parent.kind, status: "ready",
        hypothesis: blank(input.hypothesis) ? parent.hypothesis : input.hypothesis!.trim(), source_episode_id: parent.source_episode_id, source_start_ms: start, source_end_ms: end,
        hook: input.hook.trim(), caption: input.caption.trim(), ad_description: input.ad_description.trim(),
        duration_ms: start !== null && end !== null ? end - start : parent.duration_ms, width: parent.width, height: parent.height, render_settings: parent.render_settings,
        revision_note: input.revision_note?.trim() || null,
      }).select("*").single(),
      "promotion creative"
    );
    await one<PromoCreative>(promote(c).from("creatives").update({ status: "superseded", updated_at: now() }).eq("id", parent.id).select("*").maybeSingle(), "promotion creative", parent.id);
    return revision;
  },

  async advancePromoCampaign(session, campaignId, input) {
    if (session.kind !== "staff") throw new DataError("forbidden", "Pulsar staff only");
    const c = db();
    const campaign = await one<PromoCampaign>(promote(c).from("campaigns").select("*").eq("id", campaignId).maybeSingle(), "promotion campaign", campaignId);
    const allowed: Record<string, PromoCampaign["status"][]> = { submitted: ["launching", "live", "failed"], launching: ["live", "failed"], failed: ["launching"] };
    if (!allowed[campaign.status]?.includes(input.status)) throw conflict(`a ${campaign.status} campaign cannot move to ${input.status}`);
    const patch: Partial<PromoCampaign> = { status: input.status, updated_at: now() };
    if (input.grow_campaign_id !== undefined) patch.grow_campaign_id = input.grow_campaign_id?.trim() || null;
    const updated = await one<PromoCampaign>(promote(c).from("campaigns").update(patch).eq("id", campaign.id).select("*").maybeSingle(), "promotion campaign", campaign.id);
    return loadPromoDetail(c, updated);
  },

  // ---- exports and audit ----

  async getExportSnapshot(_session, titleId, episodeNumber): Promise<ExportSnapshot> {
    const c = db();
    const episode = await episodeByNumber(c, titleId, episodeNumber);
    const versions = await many<Version>(studio(c).from("versions").select("*").eq("episode_id", episode.id).order("number"));
    const approved = versions.find((v) => v.status === "approved");
    const inReview = versions.find((v) => v.status === "in_review");
    const draft = versions.find((v) => v.status === "draft");
    if (approved?.snapshot) return { version: approved, snapshot: approved.snapshot, source: "approved", sha256: approved.snapshot_sha256 };
    if (inReview?.snapshot) return { version: inReview, snapshot: inReview.snapshot, source: "in_review", sha256: inReview.snapshot_sha256 };
    if (draft) return { version: draft, snapshot: await snapshotOf(c, draft), source: "draft", sha256: null };
    throw notFound("version for episode", `${episodeNumber}`);
  },

  async listAuditEvents(_session, titleId) {
    return many<AuditEvent>(core(db()).from("audit_events").select("*").eq("title_id", titleId).order("id", { ascending: false }));
  },
};

/** Timing edits ripple upward: episode duration follows the last cue.
 * (Scene bounds are recomputed lazily by reads in the Supabase layer.) */
async function syncSupabaseTimingMirrors(
  c: ReturnType<typeof db>,
  episodeId: string,
  cues: { start_ms: number | null; end_ms: number | null }[]
): Promise<void> {
  const last = Math.max(0, ...cues.map((l) => l.end_ms ?? 0));
  if (last > 0) await studio(c).from("episodes").update({ duration_ms: last }).eq("id", episodeId);
}
