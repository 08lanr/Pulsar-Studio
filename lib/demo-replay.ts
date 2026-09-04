// Demo replay: the fixture-mode implementation of "press the button, get the
// adaptation" that spends nothing and never varies.
//
// The founders' rule for the demo (docs/decisions.md): do not translate new
// material — replay the translations we already have. So in fixture mode the
// first-pass and alternatives routes come here instead of lib/jobs.ts: lines
// are matched against data/fixture/canned.ts by their Chinese text and the
// pre-authored adaptation is written through the SAME data-layer path the
// model output would take (job row included, model "demo-replay", cost 0).
// Everything downstream — readiness, finalize, exports, the producer's diff —
// cannot tell the difference, which is the point.
//
// Lines that are not in the bank are left unadapted and counted in
// `unmatched`; the UI says so. Set DEMO_REPLAY=0 to force real model calls
// in fixture mode (with a key), e.g. to test lib/jobs.ts locally.

import type { Session } from "@/lib/auth";
import { DataError, getData } from "@/lib/data";
import { dataSource } from "@/lib/data-source";
import {
  DEMO_MODEL,
  DEMO_PROMPT_VERSION,
  cannedAlternatives,
  cannedContext,
  cannedLine,
} from "@/data/fixture/canned";
import { EXTRA_ALTS } from "@/data/fixture/canned-extra";
import { cannedKey } from "@/data/fixture/canned";
import type { AdaptedLine, Job, LineAlternative, Scene, Version, WorkbenchPayload } from "@/lib/types";
import type { FirstPassLine } from "@/lib/data";

export function demoReplayActive(): boolean {
  return dataSource() === "fixture" && process.env.DEMO_REPLAY !== "0";
}

function requireDraft(wb: WorkbenchPayload): Version {
  if (!wb.version) throw new DataError("not_found", "no version for this episode yet; ingest it first");
  if (wb.version.status !== "draft") {
    throw new DataError("frozen", `version ${wb.version.external_id} is ${wb.version.status}; fork it to edit`);
  }
  return wb.version;
}

export type ReplayFirstPassResult = {
  version: Version;
  job: Job;
  scenes: { scene_id: string; scene_number: number; lines: AdaptedLine[] }[];
  cost_cents: 0;
  /** Source lines with no canned adaptation (0 for the bundled demo scripts). */
  unmatched: number;
};

/** The canned first pass over one episode (or one scene). */
export async function replayFirstPass(
  session: Session,
  titleId: string,
  episodeNumber: number,
  opts: { sceneId?: string } = {}
): Promise<ReplayFirstPassResult> {
  const data = getData();
  const wb = await data.getWorkbench(session, titleId, episodeNumber);
  const version = requireDraft(wb);
  const scenes: Scene[] = wb.scenes
    .slice()
    .sort((a, b) => a.number - b.number)
    .filter((s) => !opts.sceneId || s.id === opts.sceneId);
  if (!scenes.length) throw new DataError("not_found", `scene ${opts.sceneId} not found in episode ${episodeNumber}`);

  const adaptedBefore = new Set(wb.adapted_lines.filter((a) => a.version_id === version.id).map((a) => a.line_id));

  const job = await data.recordJob(session, {
    kind: "first_pass",
    title_id: wb.title.id,
    episode_id: wb.episode.id,
    version_id: version.id,
    target_type: "episode",
    target_id: wb.episode.id,
    idempotency_key: `first_pass:${version.id}:demo:${DEMO_PROMPT_VERSION}`,
    provider: "demo",
    model: DEMO_MODEL,
    input: { prompt_version: DEMO_PROMPT_VERSION, replay: true },
  });

  let unmatched = 0;
  const out: ReplayFirstPassResult["scenes"] = [];
  for (const scene of scenes) {
    const lines = wb.lines
      .filter((l) => l.scene_id === scene.id && !l.merged_into_id)
      .sort((a, b) => a.seq - b.seq);
    if (!lines.length) continue;

    if (!scene.context_zh) {
      const ctx = cannedContext(lines[0].text_zh);
      if (ctx) await data.setSceneContext(session, scene.id, { context_zh: ctx.context_zh, context_en: ctx.context_en });
    }

    const rows: FirstPassLine[] = [];
    for (const src of lines) {
      if (adaptedBefore.has(src.id)) continue; // editor rows are never overwritten anyway; skip repeats
      const canned = cannedLine(src.text_zh);
      if (!canned) {
        unmatched++;
        continue;
      }
      rows.push({
        line_id: src.id,
        literal_en: canned.literal_en,
        text_en: canned.change_type === "cut" ? null : canned.text_en,
        key_phrase_en: canned.key_phrase_en ?? null,
        back_translation_zh: canned.back_translation_zh,
        change_type: canned.change_type,
        is_major: canned.is_major,
        rationale_en: canned.rationale_en,
        rationale_zh: canned.rationale_zh,
        tone_note_en: canned.tone_note_en ?? null,
        tone_note_zh: canned.tone_note_zh ?? null,
        tags: canned.tags ?? [],
        syllables_est: canned.syllables_est ?? null,
        model: DEMO_MODEL,
        prompt_version: DEMO_PROMPT_VERSION,
      });
    }
    const written = rows.length ? await data.writeFirstPass(session, version.id, scene.id, rows) : [];
    out.push({ scene_id: scene.id, scene_number: scene.number, lines: written });
  }

  const done = await data.finishJob(job.id, {
    status: "done",
    cost_cents: 0,
    usage: null,
    output: { replay: true, scenes: out.length, unmatched },
  });
  if (!out.length) throw new DataError("invalid", `episode ${episodeNumber} has no lines to adapt`);
  return { version, job: done, scenes: out, cost_cents: 0, unmatched };
}

export type ReplayAlternativesResult = {
  alternatives: LineAlternative[];
  all: LineAlternative[];
  /** false when the bank has nothing for this line — the UI explains demo mode. */
  available: boolean;
};

/** Canned alternatives for one line, added once (re-clicks return the existing rows). */
export async function replayAlternatives(
  session: Session,
  adaptedLineId: string,
  ctx: { titleId: string; episodeNumber: number }
): Promise<ReplayAlternativesResult> {
  const data = getData();
  const wb = await data.getWorkbench(session, ctx.titleId, ctx.episodeNumber);
  requireDraft(wb);
  const adapted = wb.adapted_lines.find((a) => a.id === adaptedLineId);
  if (!adapted) throw new DataError("not_found", `adapted line ${adaptedLineId} not found in this episode`);
  const source = adapted.line_id ? wb.lines.find((l) => l.id === adapted.line_id) : undefined;
  const existing = wb.alternatives
    .filter((a) => a.adapted_line_id === adapted.id)
    .sort((a, b) => a.seq - b.seq);

  // The bank's alternatives, the authored supplement, and — when that still
  // leaves fewer than three — the literal translation as the closest-to-source
  // option, so 查看备选说法 always has something real to show.
  const bank = source
    ? [...cannedAlternatives(source.text_zh), ...(EXTRA_ALTS[cannedKey(source.text_zh)] ?? [])]
    : [];
  if (source && bank.length < 3) {
    const literal = source.literal_en?.trim();
    if (
      literal &&
      literal !== (adapted.text_en ?? "").trim() &&
      !bank.some((alt) => alt.text_en === literal)
    ) {
      bank.push({
        text_en: literal,
        back_translation_zh: source.text_zh,
        rationale_zh: "最贴近原文的直译版本，语气改动最小。",
        rationale_en: "The literal, closest-to-source read — the smallest possible change.",
        tags: ["clarity"],
        syllables_est: null,
      });
    }
  }
  if (!bank.length) return { alternatives: [], all: existing, available: existing.length > 0 };
  // The bank is one batch: once its texts are on the line, re-clicks add nothing.
  const have = new Set(existing.map((a) => a.text_en));
  const fresh = bank.filter((alt) => !have.has(alt.text_en));
  if (!fresh.length) return { alternatives: [], all: existing, available: true };

  const added = await data.addAlternatives(
    session,
    adapted.id,
    fresh.map((alt) => ({
      text_en: alt.text_en,
      back_translation_zh: alt.back_translation_zh,
      rationale_zh: alt.rationale_zh,
      rationale_en: alt.rationale_en,
      tags: alt.tags ?? [],
      syllables_est: alt.syllables_est ?? null,
      model: DEMO_MODEL,
      prompt_version: DEMO_PROMPT_VERSION,
    }))
  );
  return { alternatives: added, all: [...existing, ...added], available: true };
}
