// The voice (narrated spec N1, E4; paid): the episode's narration rendered
// with ElevenLabs by the pipeline's own tts_narration.py, then placed.
//
//   1. Refused before the prep approval (amendment 3).
//   2. What will bill, predicted with the script's own formula: a line is
//      rendered unless `<mp3>.sig` holds sha1(voice|model|text)[:10]
//      (ST/tts_narration.py:61-62, read from the synced file by a test so a
//      change of formula fails loudly). Over the run's `tts_char_budget` the
//      lane waits for a raised budget (an intake decision); over the
//      episode's soft cap it waits for `{kind: "voice", action: "go"}`.
//   3. `ELEVEN_MODEL=<model> python scripts/tts_narration.py render
//      epN/narration.json <voice_id>` from the film root: the ledger and the
//      manifest are relative to the cwd, and MODEL is read at import, before
//      .env loads, so the model is always passed (without it every sig misses
//      and every line re-bills). ELEVENLABS_API_KEY reaches this step only.
//   4. Every new tts_ledger.json row becomes a `tts_line` job (key
//      tts:<run>:<ep>:<id>:<sig>, cost chars × ELEVENLABS_CENTS_PER_1K_CHARS /
//      1000; no price set → cost null, said on the row), and one summary row
//      is appended to `<film>/credits-ledger.json` ("nothing paid without a
//      ledger entry", drama-remix SKILL.md).
//   5. `place_narration.py --ep epN --min-gap 2.0`: exit 1 ("short of room")
//      sends the words lane back to the prep review with the verbatim text.
//
// One voice step runs at a time per film (the scheduler's `voice` class):
// tts_narration.py rewrites tts_ledger.json with a plain read-append-dump,
// and the budget check has to see the render before it. The rows counted
// and billed are the new ones whose file is this episode's.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { FilmRunEpisode, Json } from "@/lib/types";
import { readJson, tailLines } from "../stages";
import { dataOf, epDir, NARRATED_DECISION, narratedRefusal, pendingEpisodeDecision, requirePrepApproved, runFilmStep, writeProjectFile, type EpisodeStepOutcome, type NarratedContext } from "./stages";

// ---- the prediction --------------------------------------------------------------------------------------------------

/** tts_narration.py's sig: sha1(voice_id + "|" + MODEL + "|" + text)[:10], hex. Pure. */
export function ttsSig(voiceId: string, model: string, text: string): string {
  return createHash("sha1").update(`${voiceId}|${model}|${text}`, "utf8").digest("hex").slice(0, 10);
}

/** Python's len(text): code points, not UTF-16 units (an em dash is 1 either way; an emoji is 1 in Python, 2 in JS). */
export function pyLen(text: string): number {
  return [...text].length;
}

export type NarrationLine = { id: string; text: string };

/** The lines tts_narration.py renders from a narration.json: `lines` whose id starts with N. */
export function narrationLines(file: string): NarrationLine[] {
  const j = readJson<{ lines?: { id?: unknown; text?: unknown }[] }>(file);
  if (!j || !Array.isArray(j.lines)) return [];
  return j.lines.filter((l) => typeof l.id === "string" && l.id.startsWith("N") && typeof l.text === "string").map((l) => ({ id: String(l.id), text: String(l.text) }));
}

export type RenderPrediction = { lines: number; render: { id: string; chars: number }[]; chars: number; kept: number };

/** Which lines the render will bill: those whose `<narration dir>/<id>.mp3` or `.sig` is missing or holds another sig. */
export function predictRender(narrationFile: string, voiceId: string, model: string): RenderPrediction {
  const lines = narrationLines(narrationFile);
  const dir = path.join(path.dirname(narrationFile), path.basename(narrationFile, ".json"));
  const render: { id: string; chars: number }[] = [];
  for (const l of lines) {
    const mp3 = path.join(dir, `${l.id}.mp3`);
    let sig: string | null = null;
    try {
      sig = existsSync(mp3) ? readFileSync(`${mp3}.sig`, "utf8") : null;
    } catch {
      sig = null;
    }
    if (sig !== ttsSig(voiceId, model, l.text)) render.push({ id: l.id, chars: pyLen(l.text) });
  }
  return { lines: lines.length, render, chars: render.reduce((s, r) => s + r.chars, 0), kept: lines.length - render.length };
}

// ---- the ledger ------------------------------------------------------------------------------------------------------

export type LedgerRow = { tag?: string; voice?: string; chars?: number; file?: string; request_id?: string; time?: string };

export function readLedger(film: string): LedgerRow[] {
  const rows = readJson<LedgerRow[]>(path.join(film, "tts_ledger.json"));
  return Array.isArray(rows) ? rows : [];
}

/** The episode a ledger row's `file` names (`…/ep12/narration/N3.mp3` → 12), or null. Pure. */
export function ledgerEp(row: LedgerRow): number | null {
  const m = /(?:^|[\\/])ep(\d+)[\\/]/.exec(row.file ?? "");
  return m ? Number(m[1]) : null;
}

/** ELEVENLABS_CENTS_PER_1K_CHARS, or null when the price is not set (the job row then says so rather than guessing). */
export function centsPer1k(env: Record<string, string | undefined>): number | null {
  const v = Number(env.ELEVENLABS_CENTS_PER_1K_CHARS);
  return Number.isFinite(v) && v >= 0 && (env.ELEVENLABS_CENTS_PER_1K_CHARS ?? "").trim() !== "" ? v : null;
}

/** Characters Studio's renders of this run billed so far (the episodes' recorded voice results). Pure. */
export function runCharsBilled(episodes: Pick<FilmRunEpisode, "stage_detail">[]): number {
  return episodes.reduce((s, e) => {
    const v = (e.stage_detail as { voice?: { chars_billed_total?: unknown } }).voice;
    return s + (v && typeof v.chars_billed_total === "number" ? v.chars_billed_total : 0);
  }, 0);
}

/** Append one row to `<film>/credits-ledger.json`'s `elevenlabs_chars` (the file's own shape), through the project writer. */
export function appendCreditsLedger(ctx: NarratedContext, row: { date: string; what: string; chars: number }): void {
  const rel = "credits-ledger.json";
  const file = path.join(ctx.paths.film, rel);
  const have = readJson<Record<string, unknown>>(file) ?? { elevenlabs_chars: [], runway_credits: [], akool_credits: [], notes: "narrated skip-through + 9:16 reframe; ElevenLabs only" };
  const list = Array.isArray(have.elevenlabs_chars) ? (have.elevenlabs_chars as unknown[]) : [];
  const next = { ...have, elevenlabs_chars: [...list, row] };
  writeProjectFile(ctx, rel, `${JSON.stringify(next, null, 1)}\n`, { by: "studio", why: `ElevenLabs characters billed: ${row.what}` });
}

// ---- E4 ----------------------------------------------------------------------------------------------------------------

export async function runVoiceStep(ctx: NarratedContext, ep: FilmRunEpisode, all: FilmRunEpisode[]): Promise<EpisodeStepOutcome> {
  const gate = requirePrepApproved(ep, "voice");
  if (gate) return { kind: "refused", error: gate, patch: { words_stage: "prep_review" } };
  const d = ep.stage_detail as Record<string, Json | undefined>;
  const voice = ctx.settings.voice_id ?? (typeof (ctx.run.stage_detail as { voice?: { id?: unknown } }).voice?.id === "string" ? String((ctx.run.stage_detail as { voice: { id: string } }).voice.id) : null);
  if (!voice) return { kind: "refused", error: "no voice id: the intake records one (settings.voice_id, or a prior project's narration manifest)" };
  const model = ctx.settings.tts_model;
  const ep_ = epDir(ep.n);
  const nf = path.join(ctx.paths.film, ep_, "narration.json");
  if (!existsSync(nf)) return { kind: "refused", error: `${ep_}/narration.json is not there: the prep writes it`, patch: { words_stage: "prep" } };
  const consumed = { decisions_seen: ctx.run.decisions.length };

  // What will bill, against the run's budget and the episode's soft cap.
  const prediction = predictRender(nf, voice, model);
  const spent = runCharsBilled(all);
  const budget = ctx.settings.tts_char_budget;
  const detailBase = { ...d, voice_prediction: { ...prediction, model, voice, run_spent: spent, run_budget: budget, soft_cap: ctx.settings.tts_episode_soft_cap } as unknown as Json };
  if (prediction.chars > 0 && spent + prediction.chars > budget) {
    return { kind: "wait", for: "voice", detail: { over: "run_budget" }, patch: { stage_detail: { ...detailBase, ...consumed, note: `rendering ${prediction.chars} characters would take the run to ${spent + prediction.chars} of its ${budget}: raise tts_char_budget (an intake decision) to go on` } } };
  }
  const go = pendingEpisodeDecision(ctx.run, ep, NARRATED_DECISION.voice);
  const goAllowed = go && dataOf(go).action === "go";
  if (prediction.chars > ctx.settings.tts_episode_soft_cap && !goAllowed) {
    return { kind: "wait", for: "voice", detail: { over: "episode_soft_cap" }, patch: { stage_detail: { ...detailBase, ...consumed, note: `${prediction.chars} characters to render is over the episode's soft cap of ${ctx.settings.tts_episode_soft_cap}: say go to render` } } };
  }

  // The render: only this step sees ELEVENLABS_API_KEY.
  const before = readLedger(ctx.paths.film).length;
  if (prediction.render.length) {
    const r = await runFilmStep(ctx, { script: "tts_narration.py", args: ["render", `${ep_}/narration.json`, voice], what: `tts ep${ep.n}`, env: { ELEVEN_MODEL: model }, keys: ["ELEVENLABS_API_KEY"], timeoutMs: 60 * 60 * 1000 });
    // This episode's rows only: the scheduler renders one episode at a time per film, but the ledger is the film's, and a
    // render outside Studio (a session's own, against the brief) must not be billed to this episode or counted twice.
    const rows = readLedger(ctx.paths.film)
      .slice(before)
      .filter((x) => ledgerEp(x) === ep.n);
    await recordTtsRows(ctx, ep.n, rows, voice, model);
    const billed = rows.reduce((s, x) => s + (typeof x.chars === "number" ? x.chars : 0), 0);
    if (billed > 0) appendCreditsLedger(ctx, { date: new Date().toISOString().slice(0, 10), what: `${ep_} narration, ${model} ${voice}, ${rows.length} line(s) (Pulsar Studio run ${ctx.run.id.slice(0, 8)})`, chars: billed });
    const prior = (d.voice as { chars_billed_total?: number } | undefined)?.chars_billed_total ?? 0;
    const voiceDetail = { chars_billed_total: prior + billed, last_render: { lines: rows.length, chars: billed, at: new Date().toISOString() } } as unknown as Json;
    if (r.code !== 0) return { kind: "refused", error: narratedRefusal({ script: "tts_narration.py" }, r), patch: { stage_detail: { ...detailBase, ...consumed, voice: voiceDetail } } };
    d.voice = voiceDetail;
  } else {
    ctx.log(`ep${ep.n}: every line's take matches its sig (${model}, ${voice}): nothing to render, nothing billed`);
  }

  // Place the lines; short of room goes back to the prep review, verbatim.
  const place = await runFilmStep(ctx, { script: "place_narration.py", args: ["--ep", ep_, "--min-gap", "2.0"], what: `place_narration ep${ep.n}` });
  if (place.code === 1) {
    return { kind: "refused", error: narratedRefusal({ script: "place_narration.py" }, place), patch: { words_stage: "prep_review", stage_detail: { ...detailBase, ...consumed, voice: d.voice, place: tailLines(place.stdoutTail, 20) } } };
  }
  if (place.code !== 0) return { kind: "refused", error: narratedRefusal({ script: "place_narration.py" }, place), patch: { stage_detail: { ...detailBase, ...consumed, voice: d.voice } } };
  return { kind: "moved", patch: { words_stage: "frames", error_text: null, stage_detail: { ...detailBase, ...consumed, voice: d.voice ?? null, placed_at: new Date().toISOString() } } };
}

/** One `tts_line` job per new ledger row of this episode (the sig read from the take's .sig file). */
export async function recordTtsRows(ctx: NarratedContext, n: number, rows: LedgerRow[], voice: string, model: string): Promise<number> {
  const price = centsPer1k(ctx.env);
  let recorded = 0;
  for (const row of rows) {
    if (ledgerEp(row) !== n) continue;
    const file = row.file ? path.resolve(ctx.paths.film, row.file) : null;
    let sig = "nosig";
    try {
      if (file) sig = readFileSync(`${file}.sig`, "utf8").trim() || sig;
    } catch {
      // the take was written but not its sig: keyed without one
    }
    const chars = typeof row.chars === "number" ? row.chars : 0;
    const job = await ctx.data.recordJob(ctx.session, {
      kind: "tts_line",
      title_id: null,
      target_type: "film_run",
      target_id: ctx.run.id,
      idempotency_key: `tts:${ctx.run.id}:${n}:${row.tag ?? "?"}:${sig}`,
      provider: "elevenlabs",
      model,
      input: { ep: n, id: row.tag ?? null, file: row.file ?? null, voice, chars, request_id: row.request_id ?? null } as Json,
    });
    if (job.status === "done") continue;
    const cost = price === null ? null : Math.round((chars * price) / 1000);
    await ctx.data.finishJob(ctx.session, job.id, { status: "done", cost_cents: cost, output: { chars, time: row.time ?? null, price: price === null ? "unset: ELEVENLABS_CENTS_PER_1K_CHARS" : `${price} cents per 1k chars` } as Json });
    recorded++;
  }
  return recorded;
}
