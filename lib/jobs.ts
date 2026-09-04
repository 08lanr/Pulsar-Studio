// Every LLM pass as a studio.jobs row, run inline. runJob() is the one
// place a provider call is recorded: it asks the data layer for the job row
// (idempotent on the key — a 'done' row short-circuits and its output is
// reused), runs the call, writes usage and cost_cents on the row BEFORE the
// caller touches content (docs/data-model.md § 5: a failed content write
// still records spend), and marks a failure with its error. The run*()
// functions below are what the API routes call: read through getData(),
// build the prompt (lib/prompts), callStructured (lib/llm), write back
// through getData().
//
// V1 runs jobs inline in the request (no worker, no queue): a first pass on
// an episode is a few Opus calls in sequence and the editor waits. The later
// path is the sibling's lib/launch-job.ts pattern — a job whose output is
// recorded is never re-run, a scheduler adopts orphaned 'running' rows by
// heartbeat, the UI polls the row — and the idempotency keys and the
// resume-by-job_id checks here are already shaped for it.
//
// No key for the selected provider means no job row: every run*() throws
// LlmUnavailableError first, which routes map to 503 'llm_unavailable'.
// State guards (no draft, frozen version, untimed episode) throw DataError
// so routes map them like any other data failure.

import type { Session } from "@/lib/auth";
import { DataError, getData, type FirstPassLine as FirstPassRow, type NewClip, type NewVariant } from "@/lib/data";
import {
  LlmUnavailableError,
  LLM_PROVIDER,
  callStructured,
  isLlmAvailable,
  titleBible,
  toJobUsage,
  type LlmSystemBlock,
  type LlmUsage,
} from "@/lib/llm";
import { gatherKnowledge } from "@/lib/memory";
import { demoReplayActive } from "@/lib/data-source";
import {
  PROMPT_VERSION,
  buildAlternatives,
  buildCreativePack,
  buildFindClips,
  buildFirstPass,
  buildRewrite,
  buildUnderstandScene,
  buildUnderstandTitle,
  type CreativePackEpisodeDigest,
  type PromptLine,
  type RewriteInstruction,
} from "@/lib/prompts";
import type {
  AdaptTag,
  AdaptedLine,
  Character,
  Clip,
  Job,
  JobKind,
  Json,
  Line,
  LineAlternative,
  Scene,
  Title,
  Variant,
  VariantKind,
  Version,
  WorkbenchPayload,
} from "@/lib/types";

// ---- runJob ------------------------------------------------------------------------------------

export type RunJobSpec<T> = {
  kind: JobKind;
  title_id: string;
  episode_id?: string | null;
  version_id?: string | null;
  target_type: string;
  target_id: string;
  idempotency_key: string;
  model?: string | null;
  /** Small: ids and the prompt version, never the prompt text. */
  input?: Json | null;
  run: () => Promise<{ output: T; usage: LlmUsage; cost_cents: number; model: string }>;
};

export type RunJobResult<T> = {
  job: Job;
  output: T;
  /** true when a 'done' row for the key already existed and `output` is its stored output. */
  skipped: boolean;
};

/**
 * The one gate in front of every real model call. Demo replay must never
 * reach a model: fixture mode with a key in .env.local is the normal dev
 * setup, and a rewrite or pack click would otherwise spend real money.
 * Routes with a canned answer never get here (lib/demo-replay.ts writes
 * through the data layer directly). Checked before the key so the producer
 * reads "demo mode", never an environment-variable name.
 */
export function assertModelCallsAllowed(): void {
  if (demoReplayActive()) {
    throw new LlmUnavailableError("AI passes are off in demo mode: the demo replays the bundled sample script.");
  }
  if (!isLlmAvailable()) throw new LlmUnavailableError();
}

export async function runJob<T>(session: Session, spec: RunJobSpec<T>): Promise<RunJobResult<T>> {
  assertModelCallsAllowed();
  const data = getData();
  const job = await data.recordJob(session, {
    kind: spec.kind,
    title_id: spec.title_id,
    episode_id: spec.episode_id ?? null,
    version_id: spec.version_id ?? null,
    target_type: spec.target_type,
    target_id: spec.target_id,
    idempotency_key: spec.idempotency_key,
    provider: LLM_PROVIDER,
    model: spec.model ?? null,
    input: spec.input ?? null,
  });
  // A 'done' row with its output is reused. A done row WITHOUT output (the
  // fixture's cost rows, or a job finished before outputs were stored) is
  // re-run and finished again in place, so the key keeps one row.
  if (job.status === "done" && job.output !== null && job.output !== undefined) {
    return { job, output: job.output as unknown as T, skipped: true };
  }

  let result: Awaited<ReturnType<typeof spec.run>>;
  try {
    result = await spec.run();
  } catch (e) {
    const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    // Best effort: the original failure is what the caller must see.
    await data.finishJob(job.id, { status: "failed", error: message }).catch(() => undefined);
    throw e;
  }
  const done = await data.finishJob(job.id, {
    status: "done",
    usage: toJobUsage(result.usage),
    cost_cents: result.cost_cents,
    output: result.output as unknown as Json,
  });
  return { job: done, output: result.output, skipped: false };
}

// ---- helpers -----------------------------------------------------------------------------------

function toPromptLine(l: Line, en?: Map<string, AdaptedLine>): PromptLine {
  const base: PromptLine = {
    seq: l.seq,
    speaker: l.speaker,
    text_zh: l.text_zh,
    start_ms: l.start_ms,
    end_ms: l.end_ms,
  };
  if (en) {
    const a = en.get(l.id);
    if (a) base.text_en = a.text_en;
  }
  return base;
}

/** adapted line by source line id, for the current version only. */
function adaptedByLineId(wb: WorkbenchPayload): Map<string, AdaptedLine> {
  const m = new Map<string, AdaptedLine>();
  if (!wb.version) return m;
  for (const a of wb.adapted_lines) if (a.version_id === wb.version.id && a.line_id) m.set(a.line_id, a);
  return m;
}

function sceneLines(wb: WorkbenchPayload, sceneId: string): Line[] {
  return wb.lines.filter((l) => l.scene_id === sceneId && !l.merged_into_id).sort((a, b) => a.seq - b.seq);
}

function scenesInOrder(wb: WorkbenchPayload): Scene[] {
  return wb.scenes.slice().sort((a, b) => a.number - b.number);
}

/** The draft the AI may write into; anything else is a state error the route maps to 409 / 404. */
function requireDraft(wb: WorkbenchPayload): Version {
  if (!wb.version) throw new DataError("not_found", "no version for this episode yet; ingest it first");
  if (wb.version.status !== "draft") {
    throw new DataError("frozen", `version ${wb.version.external_id} is ${wb.version.status}; fork it to edit`);
  }
  return wb.version;
}

function findAdapted(wb: WorkbenchPayload, adaptedLineId: string): {
  adapted: AdaptedLine;
  line: Line;
  scene: Scene;
} {
  const adapted = wb.adapted_lines.find((a) => a.id === adaptedLineId);
  if (!adapted) throw new DataError("not_found", `adapted line ${adaptedLineId} not found in this episode`);
  const line = adapted.line_id ? wb.lines.find((l) => l.id === adapted.line_id) : undefined;
  if (!line) throw new DataError("not_found", `source line for ${adaptedLineId} not found`);
  const scene = wb.scenes.find((s) => s.id === adapted.scene_id);
  if (!scene) throw new DataError("not_found", `scene for ${adaptedLineId} not found`);
  return { adapted, line, scene };
}

/** Up to `n` lines either side of `seq` in the scene, with their current English. */
function linesAround(wb: WorkbenchPayload, sceneId: string, seq: number, n = 3): PromptLine[] {
  const en = adaptedByLineId(wb);
  return sceneLines(wb, sceneId)
    .filter((l) => Math.abs(l.seq - seq) <= n && l.seq !== seq)
    .map((l) => toPromptLine(l, en));
}

/** The producer's needs_alternative note on this scene of the current version, when there is one. */
function producerNote(wb: WorkbenchPayload, sceneId: string): string | null {
  const d = wb.decisions.find((x) => x.scene_id === sceneId && x.decision === "needs_alternative");
  return d?.note ?? null;
}

function bibleFor(title: Title, characters: Character[]): LlmSystemBlock {
  return titleBible(title, characters);
}

/** Distinct job ids on the rows so far: the next batch number for a keyed batch job. */
function nextBatch(rows: { job_id: string | null }[]): number {
  return new Set(rows.map((r) => r.job_id).filter((j): j is string => !!j)).size + 1;
}

// ---- understand_title --------------------------------------------------------------------------

const TITLE_SAMPLE_FIRST = 120;
const TITLE_SAMPLE_REST = 40;
const TITLE_SAMPLE_EPISODES = 4;

export type UnderstandTitleResult = {
  title: Title;
  characters: Character[];
  register_notes: { zh: string; en: string };
  job: Job;
  skipped: boolean;
};

/**
 * Builds the bible from the script: fills synopsis / logline /
 * localization-effort / character notes where staff left them empty and
 * adds English names and notes to characters that lack them. Never
 * overwrites text a person typed.
 */
export async function runUnderstandTitle(session: Session, titleId: string): Promise<UnderstandTitleResult> {
  assertModelCallsAllowed();
  const data = getData();
  const detail = await data.getTitle(session, titleId);

  const withLines = detail.episodes
    .filter((e) => e.lines_total > 0)
    .sort((a, b) => a.number - b.number)
    .slice(0, TITLE_SAMPLE_EPISODES);
  const sample: { episode_number: number; lines: PromptLine[] }[] = [];
  for (const [i, ep] of withLines.entries()) {
    const wb = await data.getWorkbench(session, titleId, ep.number);
    const lines = wb.lines
      .filter((l) => !l.merged_into_id)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, i === 0 ? TITLE_SAMPLE_FIRST : TITLE_SAMPLE_REST)
      .map((l) => toPromptLine(l));
    sample.push({ episode_number: ep.number, lines });
  }

  const prompt = buildUnderstandTitle({ title: detail.title, characters: detail.characters, sample });
  const r = await runJob(session, {
    kind: "understand_title",
    title_id: titleId,
    target_type: "title",
    target_id: titleId,
    idempotency_key: `understand_title:${titleId}:${PROMPT_VERSION}`,
    model: prompt.model,
    input: { prompt_version: PROMPT_VERSION, episodes_sampled: sample.map((s) => s.episode_number) },
    run: async () => {
      const c = await callStructured(prompt);
      return { output: c.data, usage: c.usage, cost_cents: c.cost_cents, model: c.model };
    },
  });
  const out = r.output;

  const t = detail.title;
  const patch = {
    ...(t.synopsis_zh ? {} : { synopsis_zh: out.synopsis_zh }),
    ...(t.synopsis_en ? {} : { synopsis_en: out.synopsis_en }),
    ...(t.logline_zh ? {} : { logline_zh: out.logline_zh }),
    ...(t.logline_en ? {} : { logline_en: out.logline_en }),
    ...(t.localization_effort ? {} : { localization_effort: out.localization_effort_en }),
    ...(t.character_notes ? {} : { character_notes: out.register_notes_zh }),
  };
  const title = Object.keys(patch).length ? await data.updateTitle(session, titleId, patch) : t;

  const byName = new Map(detail.characters.map((c) => [c.name_zh, c]));
  const upserts = out.characters
    .map((c) => {
      const have = byName.get(c.name_zh.trim());
      return {
        name_zh: c.name_zh.trim(),
        name_en: have?.name_en ?? c.name_en,
        notes: have?.notes ?? c.notes,
      };
    })
    .filter((c) => c.name_zh);
  const characters = upserts.length ? await data.upsertCharacters(session, titleId, upserts) : detail.characters;

  return {
    title,
    characters,
    register_notes: { zh: out.register_notes_zh, en: out.register_notes_en },
    job: r.job,
    skipped: r.skipped,
  };
}

// ---- understand_scene --------------------------------------------------------------------------

/**
 * The scene's context paragraph (zh + en). Called by runFirstPass for any
 * scene still without one; exported so a route can run it alone.
 */
export async function runUnderstandScene(
  session: Session,
  wb: WorkbenchPayload,
  scene: Scene,
  previousContextZh: string | null
): Promise<{ scene: Scene; job: Job; skipped: boolean }> {
  const data = getData();
  const lines = sceneLines(wb, scene.id).map((l) => toPromptLine(l));
  if (!lines.length) throw new DataError("invalid", `scene ${scene.number} has no lines`);
  const prompt = buildUnderstandScene({
    bible: bibleFor(wb.title, wb.characters),
    episode_number: wb.episode.number,
    scene,
    lines,
    previous_context_zh: previousContextZh,
  });
  const r = await runJob(session, {
    kind: "understand_scene",
    title_id: wb.title.id,
    episode_id: wb.episode.id,
    target_type: "scene",
    target_id: scene.id,
    idempotency_key: `understand_scene:${scene.id}:${PROMPT_VERSION}`,
    model: prompt.model,
    input: { prompt_version: PROMPT_VERSION, scene_number: scene.number },
    run: async () => {
      const c = await callStructured(prompt);
      return { output: c.data, usage: c.usage, cost_cents: c.cost_cents, model: c.model };
    },
  });
  // A skipped job whose context never landed (a failed write) is applied now.
  const updated =
    !r.skipped || !scene.context_zh
      ? await data.setSceneContext(session, scene.id, { context_zh: r.output.context_zh, context_en: r.output.context_en })
      : scene;
  return { scene: updated, job: r.job, skipped: r.skipped };
}

// ---- first_pass --------------------------------------------------------------------------------

export type FirstPassSceneResult = {
  scene_id: string;
  scene_number: number;
  job: Job;
  skipped: boolean;
  lines: AdaptedLine[];
};

export type FirstPassResult = {
  version: Version;
  /** The last first_pass job, for the route contract's `job`. */
  job: Job;
  scenes: FirstPassSceneResult[];
  /** Cents spent by this call (skipped jobs count 0). */
  cost_cents: number;
};

/**
 * The AI adaptation of an episode, one job per scene keyed on
 * (version, scene, prompt version). Scenes without a context get one first.
 * Lines an editor already rewrote are adapted for continuity but never
 * written back (the data layer keeps authored_by = 'editor' rows). Pass
 * `sceneId` to run a single scene.
 */
/**
 * Knowledge for a single-line pass (alternatives, rewrite): the approved
 * corpus, house exemplars, register guide and glosses for that line, no
 * Tatoeba (one line rarely earns a near-exact hit and the prompt stays short).
 */
async function lineKnowledge(session: Session, wb: WorkbenchPayload, line: Line) {
  const approvedMemory = await getData().listApprovedTranslationMemory(session, wb.title.id);
  return gatherKnowledge([{ text_zh: line.text_zh, speaker: line.speaker }], {
    approvedMemory,
    titleId: wb.title.id,
    reference: false,
    limits: { approved: 6, house: 3, idioms: 6, glosses: 6 },
  });
}

export async function runFirstPass(
  session: Session,
  titleId: string,
  episodeNumber: number,
  opts: { sceneId?: string } = {}
): Promise<FirstPassResult> {
  assertModelCallsAllowed();
  const data = getData();
  const wb = await data.getWorkbench(session, titleId, episodeNumber);
  const version = requireDraft(wb);
  const bible = bibleFor(wb.title, wb.characters);
  const ordered = scenesInOrder(wb).filter((s) => !opts.sceneId || s.id === opts.sceneId);
  if (!ordered.length) throw new DataError("not_found", `scene ${opts.sceneId} not found in episode ${episodeNumber}`);

  const results: FirstPassSceneResult[] = [];
  let cost = 0;
  let previousContextZh: string | null = null;
  let previousTail: { speaker: string | null; text_zh: string; text_en: string | null }[] = [];
  const adaptedBefore = adaptedByLineId(wb);
  const approvedMemory = await data.listApprovedTranslationMemory(session, titleId);

  for (const raw of ordered) {
    let scene = raw;
    const lines = sceneLines(wb, scene.id);
    if (!lines.length) continue;

    if (!scene.context_zh) {
      const ctx = await runUnderstandScene(session, wb, scene, previousContextZh);
      scene = ctx.scene;
      if (!ctx.skipped) cost += ctx.job.cost_cents ?? 0;
    }

    const knowledge = await gatherKnowledge(
      lines.map((line) => ({ text_zh: line.text_zh, speaker: line.speaker })),
      { approvedMemory, titleId: wb.title.id }
    );
    const prompt = buildFirstPass({
      bible,
      episode_number: wb.episode.number,
      scene,
      lines: lines.map((l) => toPromptLine(l)),
      previous_tail: previousTail,
      has_timecodes: wb.episode.has_timecodes,
      knowledge: knowledge.blocks,
    });
    const r = await runJob(session, {
      kind: "first_pass",
      title_id: wb.title.id,
      episode_id: wb.episode.id,
      version_id: version.id,
      target_type: "scene",
      target_id: scene.id,
      // Stable per version+scene+prompt: a memory that grew since the last
      // click is recorded below but must not silently regenerate the scene.
      idempotency_key: `first_pass:${version.id}:${scene.id}:${PROMPT_VERSION}`,
      model: prompt.model,
      input: {
        prompt_version: PROMPT_VERSION,
        scene_number: scene.number,
        line_count: lines.length,
        knowledge: knowledge.counts,
        knowledge_fingerprint: knowledge.fingerprint,
      },
      run: async () => {
        const c = await callStructured(prompt);
        return { output: c.data, usage: c.usage, cost_cents: c.cost_cents, model: c.model };
      },
    });
    if (!r.skipped) cost += r.job.cost_cents ?? 0;

    // Apply unless the job was skipped AND every line already has its row
    // (a skipped job with rows missing is the resume case).
    const missing = lines.some((l) => !adaptedBefore.has(l.id));
    let written: AdaptedLine[];
    if (!r.skipped || missing) {
      const bySeq = new Map(lines.map((l) => [l.seq, l]));
      const rows: FirstPassRow[] = [];
      for (const o of r.output.lines) {
        const src = bySeq.get(o.seq);
        if (!src) continue; // the check in the prompt module makes this unreachable; belt and braces
        rows.push({
          line_id: src.id,
          literal_en: o.literal_en,
          text_en: o.change_type === "cut" ? null : o.text_en,
          key_phrase_en: o.key_phrase_en ?? null,
          back_translation_zh: o.back_translation_zh,
          change_type: o.change_type,
          is_major: o.is_major,
          rationale_en: o.rationale_en,
          rationale_zh: o.rationale_zh,
          tone_note_en: o.tone_note_en,
          tone_note_zh: o.tone_note_zh,
          tags: o.tags,
          syllables_est: o.syllables_est,
          model: r.job.model ?? prompt.model,
          prompt_version: PROMPT_VERSION,
        });
      }
      written = await data.writeFirstPass(session, version.id, scene.id, rows);
    } else {
      written = lines.map((l) => adaptedBefore.get(l.id)!).filter(Boolean);
    }

    const byLine = new Map(written.map((a) => [a.line_id, a]));
    previousTail = lines.slice(-3).map((l) => ({
      speaker: l.speaker,
      text_zh: l.text_zh,
      text_en: byLine.get(l.id)?.text_en ?? null,
    }));
    previousContextZh = scene.context_zh;
    results.push({ scene_id: scene.id, scene_number: scene.number, job: r.job, skipped: r.skipped, lines: written });
  }

  if (!results.length) throw new DataError("invalid", `episode ${episodeNumber} has no lines to adapt`);
  return { version, job: results[results.length - 1].job, scenes: results, cost_cents: cost };
}

// ---- alternatives ------------------------------------------------------------------------------

/** The workbench coordinates of a line; both route paths carry them. */
export type LineContext = { titleId: string; episodeNumber: number };

export type AlternativesResult = {
  /** The rows this call added (empty when the batch already existed). */
  alternatives: LineAlternative[];
  /** Every alternative on the line afterwards, seq order. */
  all: LineAlternative[];
  job: Job;
  skipped: boolean;
};

export type AlternativesOptions = {
  /** "Take it another direction": one more take that leans into this tag. */
  direction?: AdaptTag | null;
};

/**
 * Alternatives for one line, as a new batch keyed on the line and the batch
 * number: two takes in different directions by default, or ONE take along the
 * tag the producer tapped.
 */
export async function runAlternatives(
  session: Session,
  adaptedLineId: string,
  ctx: LineContext,
  opts: AlternativesOptions = {}
): Promise<AlternativesResult> {
  assertModelCallsAllowed();
  const data = getData();
  const wb = await data.getWorkbench(session, ctx.titleId, ctx.episodeNumber);
  const version = requireDraft(wb);
  const { adapted, line, scene } = findAdapted(wb, adaptedLineId);
  if (adapted.version_id !== version.id) throw new DataError("frozen", "that line belongs to a frozen version");
  const existing = wb.alternatives.filter((a) => a.adapted_line_id === adapted.id).sort((a, b) => a.seq - b.seq);

  const prompt = buildAlternatives({
    bible: bibleFor(wb.title, wb.characters),
    episode_number: wb.episode.number,
    scene,
    line: {
      ...toPromptLine(line),
      text_en: adapted.text_en,
      literal_en: line.literal_en,
      current_rationale_en: adapted.rationale_en,
    },
    around: linesAround(wb, scene.id, line.seq),
    existing_en: existing.map((a) => a.text_en),
    producer_note: producerNote(wb, scene.id),
    direction: opts.direction ?? null,
    knowledge: (await lineKnowledge(session, wb, line)).blocks,
  });
  const batch = nextBatch(existing);
  const directionKey = opts.direction ? `:${opts.direction}` : "";
  const r = await runJob(session, {
    kind: "alternatives",
    title_id: wb.title.id,
    episode_id: wb.episode.id,
    version_id: version.id,
    target_type: "adapted_line",
    target_id: adapted.id,
    idempotency_key: `alternatives:${adapted.id}:${PROMPT_VERSION}:${batch}${directionKey}`,
    model: prompt.model,
    input: { prompt_version: PROMPT_VERSION, batch, seq: line.seq, direction: opts.direction ?? null },
    run: async () => {
      const c = await callStructured(prompt);
      return { output: c.data, usage: c.usage, cost_cents: c.cost_cents, model: c.model };
    },
  });

  const alreadyApplied = r.skipped && existing.some((a) => a.job_id === r.job.id);
  const added = alreadyApplied
    ? []
    : await data.addAlternatives(
        session,
        adapted.id,
        r.output.alternatives.map((o) => ({
          text_en: o.text_en,
          back_translation_zh: o.back_translation_zh,
          rationale_zh: o.rationale_zh,
          rationale_en: o.rationale_en,
          tags: o.tags,
          syllables_est: o.syllables_est,
          model: r.job.model ?? prompt.model,
          prompt_version: PROMPT_VERSION,
          job_id: r.job.id,
        }))
      );
  return { alternatives: added, all: [...existing, ...added], job: r.job, skipped: r.skipped };
}

// ---- rewrite -----------------------------------------------------------------------------------

export type RewriteResult = { line: AdaptedLine; job: Job };

/**
 * Regenerate / shorten / free instruction on one line. Deliberately never
 * deduplicated: each request is a new job (the key carries a timestamp),
 * because "do it again" is the whole point.
 */
export async function runRewrite(
  session: Session,
  adaptedLineId: string,
  instruction: RewriteInstruction,
  ctx: LineContext
): Promise<RewriteResult> {
  assertModelCallsAllowed();
  const data = getData();
  const wb = await data.getWorkbench(session, ctx.titleId, ctx.episodeNumber);
  const version = requireDraft(wb);
  const { adapted, line, scene } = findAdapted(wb, adaptedLineId);
  if (adapted.version_id !== version.id) throw new DataError("frozen", "that line belongs to a frozen version");
  const trimmed = instruction.trim();
  if (!trimmed) throw new DataError("invalid", "instruction is empty");

  const prompt = buildRewrite({
    bible: bibleFor(wb.title, wb.characters),
    episode_number: wb.episode.number,
    scene,
    line: {
      ...toPromptLine(line),
      text_en: adapted.text_en,
      literal_en: line.literal_en,
      current_rationale_en: adapted.rationale_en,
    },
    around: linesAround(wb, scene.id, line.seq),
    instruction: trimmed,
    producer_note: producerNote(wb, scene.id),
    knowledge: (await lineKnowledge(session, wb, line)).blocks,
  });
  const r = await runJob(session, {
    kind: "rewrite",
    title_id: wb.title.id,
    episode_id: wb.episode.id,
    version_id: version.id,
    target_type: "adapted_line",
    target_id: adapted.id,
    idempotency_key: `rewrite:${adapted.id}:${PROMPT_VERSION}:${Date.now().toString(36)}`,
    model: prompt.model,
    input: { prompt_version: PROMPT_VERSION, seq: line.seq, instruction: trimmed.slice(0, 200) },
    run: async () => {
      const c = await callStructured(prompt);
      return { output: c.data, usage: c.usage, cost_cents: c.cost_cents, model: c.model };
    },
  });
  const o = r.output;
  const updated = await data.updateAdaptedLine(
    session,
    adapted.id,
    {
      text_en: o.change_type === "cut" ? null : o.text_en,
      key_phrase_en: o.key_phrase_en ?? null,
      back_translation_zh: o.back_translation_zh,
      rationale_en: o.rationale_en,
      rationale_zh: o.rationale_zh,
      tone_note_en: o.tone_note_en,
      tone_note_zh: o.tone_note_zh,
      tags: o.tags,
      change_type: o.change_type,
      is_major: o.is_major,
      syllables_est: o.syllables_est,
    },
    { authored_by: "ai", model: r.job.model ?? prompt.model, prompt_version: PROMPT_VERSION }
  );
  return { line: updated, job: r.job };
}

// ---- propose_variants (the creative pack) -----------------------------------------------------

const PACK_LINE_BUDGET = 600;

export type CreativePackResult = {
  /** Every variant of the title afterwards. */
  variants: Variant[];
  /** How many rows this batch added. */
  added: number;
  job: Job;
  skipped: boolean;
};

const PACK_KINDS: { key: "titles" | "hooks" | "descriptions" | "thumbnail_concepts" | "ad_angles"; kind: VariantKind }[] = [
  { key: "titles", kind: "title" },
  { key: "hooks", kind: "hook" },
  { key: "descriptions", kind: "description" },
  { key: "thumbnail_concepts", kind: "thumbnail_concept" },
  { key: "ad_angles", kind: "ad_angle" },
];

/**
 * A new batch of the creative pack from the current script of every
 * ingested episode (approved / in-review / draft, whichever the workbench
 * shows; source lines when nothing is adapted) and the bible. Each call is
 * a new batch: the key carries the batch number.
 */
export async function runCreativePack(session: Session, titleId: string): Promise<CreativePackResult> {
  assertModelCallsAllowed();
  const data = getData();
  const detail = await data.getTitle(session, titleId);
  const existing = await data.listVariants(session, titleId);

  const episodes: CreativePackEpisodeDigest[] = [];
  let budget = PACK_LINE_BUDGET;
  const ingested = detail.episodes.filter((e) => e.lines_total > 0).sort((a, b) => a.number - b.number);
  const perEpisode = ingested.length ? Math.max(40, Math.floor(PACK_LINE_BUDGET / ingested.length)) : 0;
  for (const ep of ingested) {
    if (budget <= 0) break;
    const wb = await data.getWorkbench(session, titleId, ep.number);
    const en = adaptedByLineId(wb);
    const source: CreativePackEpisodeDigest["source"] =
      wb.version && en.size ? (wb.version.status === "superseded" ? "draft" : wb.version.status) : "source_only";
    const take = Math.min(perEpisode, budget);
    const lines = wb.lines
      .filter((l) => !l.merged_into_id)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, take)
      .map((l) => `${l.speaker ?? "?"}: ${en.get(l.id)?.text_en ?? l.text_zh}`);
    budget -= lines.length;
    episodes.push({
      episode_number: ep.number,
      name_zh: ep.name_zh,
      source,
      scene_contexts_en: scenesInOrder(wb)
        .map((s) => s.context_en)
        .filter((c): c is string => !!c),
      lines,
    });
  }

  const prompt = buildCreativePack({
    bible: bibleFor(detail.title, detail.characters),
    episodes,
    selected: existing.filter((v) => v.selected).map((v) => ({ kind: v.kind, text_en: v.text_en })),
    existing_en: existing.filter((v) => !v.selected).map((v) => ({ kind: v.kind, text_en: v.text_en })),
  });
  const batch = nextBatch(existing);
  const r = await runJob(session, {
    kind: "propose_variants",
    title_id: titleId,
    target_type: "title",
    target_id: titleId,
    idempotency_key: `propose_variants:${titleId}:${detail.adaptation.id}:${PROMPT_VERSION}:${batch}`,
    model: prompt.model,
    input: { prompt_version: PROMPT_VERSION, batch, episodes: episodes.map((e) => e.episode_number) },
    run: async () => {
      const c = await callStructured(prompt);
      return { output: c.data, usage: c.usage, cost_cents: c.cost_cents, model: c.model };
    },
  });

  if (r.skipped && existing.some((v) => v.job_id === r.job.id)) {
    return { variants: existing, added: 0, job: r.job, skipped: true };
  }
  const rows: NewVariant[] = [];
  for (const { key, kind } of PACK_KINDS) {
    for (const item of r.output[key]) {
      rows.push({
        kind,
        text_en: item.text_en,
        text_zh: item.text_zh,
        rationale_en: item.rationale_en,
        rationale_zh: item.rationale_zh,
        tags: item.tags,
        model: r.job.model ?? prompt.model,
        prompt_version: PROMPT_VERSION,
        job_id: r.job.id,
      });
    }
  }
  const variants = await data.upsertVariants(session, titleId, rows);
  return { variants, added: rows.length, job: r.job, skipped: r.skipped };
}

// ---- find_clips --------------------------------------------------------------------------------

export type FindClipsResult = {
  /** The episode's clips afterwards (suggested replaced, shortlisted / dismissed kept). */
  clips: Clip[];
  job: Job;
  skipped: boolean;
};

/**
 * Rank the 8-12 best ad moments of a timed episode. Keyed on the episode,
 * its current version and the prompt version; `force` starts a fresh run
 * (a new key) when the editor wants another look at the same version.
 */
export async function runFindClips(
  session: Session,
  titleId: string,
  episodeNumber: number,
  opts: { force?: boolean } = {}
): Promise<FindClipsResult> {
  assertModelCallsAllowed();
  const data = getData();
  const wb = await data.getWorkbench(session, titleId, episodeNumber);
  if (!wb.episode.has_timecodes) throw new DataError("invalid", "clips need a timed episode (subtitle file with timecodes)");
  const en = adaptedByLineId(wb);
  const lines = wb.lines
    .filter((l) => !l.merged_into_id && l.start_ms !== null && l.end_ms !== null)
    .sort((a, b) => a.seq - b.seq);
  if (!lines.length) throw new DataError("invalid", `episode ${episodeNumber} has no timed lines`);

  const prompt = buildFindClips({
    bible: bibleFor(wb.title, wb.characters),
    episode_number: wb.episode.number,
    episode_name_zh: wb.episode.name_zh,
    scenes: scenesInOrder(wb),
    lines: lines.map((l) => toPromptLine(l, en)),
  });
  const versionKey = wb.version?.id ?? "source";
  const suffix = opts.force ? `:r${Date.now().toString(36)}` : "";
  const r = await runJob(session, {
    kind: "find_clips",
    title_id: wb.title.id,
    episode_id: wb.episode.id,
    version_id: wb.version?.id ?? null,
    target_type: "episode",
    target_id: wb.episode.id,
    idempotency_key: `find_clips:${wb.episode.id}:${versionKey}:${PROMPT_VERSION}${suffix}`,
    model: prompt.model,
    input: { prompt_version: PROMPT_VERSION, line_count: lines.length },
    run: async () => {
      const c = await callStructured(prompt);
      return { output: c.data, usage: c.usage, cost_cents: c.cost_cents, model: c.model };
    },
  });

  const current = await data.listClips(session, titleId, episodeNumber);
  if (r.skipped && current.some((c) => c.job_id === r.job.id)) {
    return { clips: current, job: r.job, skipped: true };
  }
  const bySeq = new Map(lines.map((l) => [l.seq, l]));
  const rows: NewClip[] = r.output.clips.map((c, i) => {
    const from = bySeq.get(c.from_seq)!;
    const to = bySeq.get(c.to_seq)!;
    const sceneIds = Array.from(
      new Set(lines.filter((l) => l.seq >= c.from_seq && l.seq <= c.to_seq).map((l) => l.scene_id))
    );
    return {
      rank: i + 1,
      start_ms: from.start_ms!,
      end_ms: to.end_ms!,
      scene_ids: sceneIds,
      hook_en: c.hook_en,
      why_en: c.why_en,
      why_zh: c.why_zh,
      opening_text_en: c.opening_text_en,
      cut_length_s: c.cut_length_s,
      angle: c.angle,
      model: r.job.model ?? prompt.model,
      prompt_version: PROMPT_VERSION,
      job_id: r.job.id,
    };
  });
  const clips = await data.upsertClips(session, wb.episode.id, rows);
  return { clips, job: r.job, skipped: r.skipped };
}
