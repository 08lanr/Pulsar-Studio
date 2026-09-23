// The briefs a narrated run's writing sessions get (decision 2026-09-23
// "Narrated mode in Studio"; narrated spec N0.3): the per-episode prep brief
// and the script-read brief, filled from the run and episode rows into
// `<work>/briefs/…`.
//
// The prep brief's TEXT is read from the film's synced
// `scripts/PREP-BRIEF.md` (drama-remix `scripts/skip-through/PREP-BRIEF.md`,
// committed 2026-09-23) every time, never copied into Studio: its header
// paragraph is the `> ` quote under "The header paragraph", its body the
// ```text block under "## The brief", and Studio fills the placeholders the
// file's own table names ({PROJ}, {SRCFILE}, {SCRIPTS}, {N}, {P}, and the
// header's {window} / {story}). Three mechanical changes and nothing else:
//
//   - paths made absolute: the brief was written for a project directly under
//     `projects/` (`../lbl-e03`, `../../drama-remix`); a Studio film sits one
//     bucket deeper (`projects/high-quality/<slug>`), so each `../../drama-remix/`
//     becomes the checkout's path and each other `../<project>/` the sibling
//     project's path under WORKSPACE_ROOT;
//   - the story-specific parts the file itself says a new source replaces
//     (the NAMES section, READ FIRST item 5), when the run's settings give them;
//   - a short Studio preface: the run and episode, and that Studio — not the
//     agent — starts the picture lane after the person approves PREP.md, so
//     step 10's `touch READY_GPU` is not done (narrated spec N1, E1).
//
// The script-read brief: drama-remix has no committed prompt for it yet
// (spec N9.1). When `scripts/SCRIPT-BRIEF.md` appears in the synced copy its
// ```text block is used the same way; until then the brief is Studio's
// output contract only — it invokes the drama-remix skill and points at the
// route's own "Order of work" step 1 for the method, and names the files to
// write — so the method still has one source of truth.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { FilmRunEpisode } from "@/lib/types";
import { sha256Of, type NarratedContext } from "./stages";

export const PREP_BRIEF_FILE = "PREP-BRIEF.md";
export const SCRIPT_BRIEF_FILE = "SCRIPT-BRIEF.md";
/** Where the script session writes its proposed episode windows (the run's work folder; not a project file, N4). */
export const EPISODE_PLAN_FILE = "episodes-proposed.json";

export class BriefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BriefError";
  }
}

export type BriefTemplate = {
  file: string;
  /** SHA-256 of the file the text was read from. */
  sha: string;
  /** The header paragraph with its placeholders ({N}, {window}, {story}; the series name and source label as the generator held them). */
  header: string;
  /** The ```text block. */
  body: string;
};

/** Read and split `<scripts>/PREP-BRIEF.md`; a BriefError names what is missing (the file, the header quote, the text block). */
export function readPrepBrief(scriptsDir: string): BriefTemplate {
  const file = path.join(scriptsDir, PREP_BRIEF_FILE);
  if (!existsSync(file)) throw new BriefError(`${file} is not there: the synced skip-through scripts have no prep brief (drama-remix commit de00968 added it)`);
  const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const body = textBlockAfter(text, /^## The brief\s*$/m);
  if (!body) throw new BriefError(`${file}: no \`\`\`text block under "## The brief"`);
  const hp = text.search(/The header paragraph/);
  let header = "";
  if (hp >= 0) {
    const lines = text.slice(hp).split("\n");
    const start = lines.findIndex((l) => l.startsWith("> "));
    if (start >= 0) {
      const quote: string[] = [];
      for (let i = start; i < lines.length && lines[i].startsWith(">"); i++) quote.push(lines[i].replace(/^>\s?/, ""));
      header = quote.join(" ").replace(/\s+/g, " ").trim();
    }
  }
  if (!header || !header.includes("{N}")) throw new BriefError(`${file}: the header paragraph (a > quote with {N}, {window}, {story}) is not where the file says it is`);
  return { file, sha: sha256Of(readFileSync(file)), header, body };
}

/** The ```text block after the first line matching `heading`, or null. */
export function textBlockAfter(markdown: string, heading: RegExp): string | null {
  const m = heading.exec(markdown);
  if (!m) return null;
  const rest = markdown.slice(m.index + m[0].length);
  const open = rest.indexOf("```text\n");
  if (open < 0) return null;
  const from = open + "```text\n".length;
  const close = rest.indexOf("\n```", from);
  if (close < 0) return null;
  return rest.slice(from, close);
}

// ---- the window sentence (PREP-BRIEF.md's three forms) ---------------------------------------------------------------

const mmss = (s: number): string => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const secs = (s: number): string => (Number.isInteger(s) ? `${s}` : s.toFixed(1));

/**
 * `{window}` in the form the file describes for a first, a middle and a last
 * episode of a source (an only one reads as first and last), with the
 * shot-cut rule.
 */
export function windowText(ep: Pick<FilmRunEpisode, "src_in" | "src_out">, position: { first: boolean; last: boolean; sourceLabel: string }): string {
  const a = ep.src_in;
  const b = ep.src_out;
  const src = position.sourceLabel ? ` of source ${position.sourceLabel.replace(/^S0?(\d+)E0?(\d+)$/i, "episode $2")}` : "";
  if (position.first && position.last) return `the ONLY episode${src}. Start at or after ${secs(a)} s (${mmss(a)}) and end at or before ${secs(b)} s (${mmss(b)}), on shot cuts`;
  if (position.first) return `the FIRST episode${src}. Start at or after ${secs(a)} s (${mmss(a)}). End at or before ~${secs(b)} s (${mmss(b)}), on a shot cut`;
  if (position.last) return `the LAST episode${src}. Start at or after ~${secs(a)} s (${mmss(a)}) and end at or before ${secs(b)} s (${mmss(b)}), on a shot cut`;
  return `start at or after ~${secs(a)} s (${mmss(a)}) and end at or before ~${secs(b)} s (${mmss(b)}), on shot cuts`;
}

// ---- filling ---------------------------------------------------------------------------------------------------------

export type PrepFill = {
  /** The film folder, absolute (PROJECT:). */
  film: string;
  /** `{PROJ}`: the project folder under projects/ (`high-quality/lbl-s01e05`). */
  proj: string;
  /** WORKSPACE_ROOT (projects/) and the drama-remix checkout, for the absolute paths. */
  projectsRoot: string;
  dramaRemixRoot: string;
  srcFile: string;
  scripts: string;
  n: number;
  p: number;
  window: string;
  story: string;
  series: string | null;
  sourceLabel: string | null;
  /** Replaces the NAMES section's bullets; null keeps the committed text. */
  names?: string | null;
  /** Replaces READ FIRST item 5; null keeps the committed text. */
  workedExample?: string | null;
  runId: string;
};

const fwd = (p: string) => p.replace(/\\/g, "/");

/** `../../drama-remix/x` → the checkout; `../<project>/x` → that sibling project under projects/. */
export function absolutizeBriefPaths(text: string, roots: { projectsRoot: string; dramaRemixRoot: string }): string {
  const dr = fwd(roots.dramaRemixRoot).replace(/\/$/, "");
  const pj = fwd(roots.projectsRoot).replace(/\/$/, "");
  return text.replace(/(^|[\s(`'"])\.\.\/\.\.\/drama-remix\//g, `$1${dr}/`).replace(/(^|[\s(`'"])\.\.\/(?!\.\.\/)([A-Za-z0-9_][\w.-]*)\//g, `$1${pj}/$2/`);
}

/** Replace the lines after `NAMES:` up to the next blank line followed by an all-caps heading (`SHARED-FILE DISCIPLINE (parallel agents):`, `STEPS`). */
function replaceNames(body: string, names: string): string {
  const lines = body.split("\n");
  const at = lines.findIndex((l) => /^NAMES:/.test(l));
  if (at < 0) return body;
  let end = at + 1;
  while (end < lines.length && !(lines[end].trim() === "" && /^[A-Z][A-Z-]{2,}(\s|:|$)/.test(lines[end + 1] ?? ""))) end++;
  return [...lines.slice(0, at), `NAMES: ${names.trim()}`, ...lines.slice(end)].join("\n");
}

function replaceWorkedExample(body: string, example: string): string {
  return body.replace(/^5\. The worked example[^\n]*$/m, `5. ${example.trim()}`);
}

/** The Studio preface: the two rules Studio adds on top of the committed brief. */
export function studioPreface(fill: Pick<PrepFill, "runId" | "n">): string {
  return [
    `[Pulsar Studio run ${fill.runId.slice(0, 8)}, ep${fill.n}] This session was started by Pulsar Studio with the committed prep brief below. On top of it:`,
    `- Do not create ep${fill.n}/READY_GPU (skip that part of step 10). Studio starts the GPU lane itself once Ruobin has approved your PREP.md; the rule that piece boundaries and cue timings are final by then still holds.`,
    `- Everything else is as the brief says, including what never to run. Paths in the brief are absolute because this project sits under projects/high-quality/.`,
    "",
  ].join("\n");
}

/** The whole prep prompt: preface, header paragraph, body. Pure over the template. */
export function fillPrepBrief(tpl: Pick<BriefTemplate, "header" | "body">, fill: PrepFill): string {
  let header = tpl.header.replace(/\{N\}/g, String(fill.n)).replace(/\{window\}/g, fill.window).replace(/\{story\}/g, fill.story.trim());
  if (fill.series) header = header.replace(/narrated "[^"]+" remix/, `narrated "${fill.series}" remix`);
  if (fill.sourceLabel) header = header.replace(/\(source [^)]+\)/, `(source ${fill.sourceLabel})`);
  let body = tpl.body;
  if (fill.names) body = replaceNames(body, fill.names);
  if (fill.workedExample) body = replaceWorkedExample(body, fill.workedExample);
  body = body
    .replace(/PROJECT: \S*\{PROJ\}/g, `PROJECT: ${fwd(fill.film)}`)
    .replace(/\{PROJ\}/g, fill.proj)
    .replace(/\{SRCFILE\}/g, fill.srcFile)
    .replace(/\{SCRIPTS\}/g, fill.scripts)
    .replace(/\{N\}/g, String(fill.n))
    .replace(/\{P\}/g, String(fill.p));
  body = absolutizeBriefPaths(body, fill);
  return `${studioPreface(fill)}\n${header}\n\n${body}\n`;
}

/** Placeholders a filled brief must not carry any more. */
export function unfilledPlaceholders(text: string): string[] {
  return [...new Set(text.match(/\{(PROJ|SRCFILE|SCRIPTS|N|P|window|story)\}/g) ?? [])];
}

// ---- from the rows -----------------------------------------------------------------------------------------------------

/** The newest `SCRIPT-*.md` in a folder, or null. */
export function newestScriptDoc(dir: string): string | null {
  try {
    const hits = readdirSync(dir)
      .filter((f) => /^SCRIPT-.+\.md$/.test(f))
      .map((f) => ({ f, t: statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    return hits.length ? path.join(dir, hits[0].f) : null;
  } catch {
    return null;
  }
}

/** The source's label: settings, else the file name under source/, else the slug. */
export function sourceLabel(ctx: Pick<NarratedContext, "settings" | "run">): string | null {
  if (ctx.settings.source_label) return ctx.settings.source_label;
  const m = /s(\d{1,2})e(\d{1,3})/i.exec(ctx.run.source_path.split("/").pop() ?? "");
  return m ? `S${m[1].padStart(2, "0")}E${m[2].padStart(2, "0")}` : null;
}

/** `SCRIPT-<label>.md` for this source. */
export function scriptDocName(ctx: Pick<NarratedContext, "settings" | "run">): string {
  return `SCRIPT-${sourceLabel(ctx) ?? ctx.run.slug}.md`;
}

export type FilledBrief = { text: string; sha: string; path: string; template_sha: string | null };

/** The prep brief for one episode, filled from the run and its rows (the story paragraph is the plan's, kept on the episode row). */
export function prepBriefFor(ctx: NarratedContext, ep: FilmRunEpisode, all: FilmRunEpisode[]): FilledBrief {
  const tpl = readPrepBrief(ctx.paths.scripts);
  const open = all.filter((e) => e.stage !== "dropped").sort((a, b) => a.n - b.n);
  const idx = open.findIndex((e) => e.id === ep.id);
  const label = sourceLabel(ctx) ?? "";
  const story = typeof (ep.stage_detail as { story?: unknown }).story === "string" ? ((ep.stage_detail as { story: string }).story as string) : ep.subtitle ?? "";
  const proj = fwd(path.relative(ctx.paths.projects, ctx.paths.film));
  const scripts = ctx.settings.brief.scripts ?? scriptDocName(ctx);
  const text = fillPrepBrief(tpl, {
    film: ctx.paths.film,
    proj,
    projectsRoot: ctx.paths.projects,
    dramaRemixRoot: path.dirname(path.dirname(ctx.canonicalScripts)),
    srcFile: "original.mp4",
    scripts,
    n: ep.n,
    p: ep.n - 1,
    window: windowText(ep, { first: idx === 0, last: idx === open.length - 1, sourceLabel: label }),
    story: story || "(the plan gave no story paragraph for this window: read the SCRIPT for it)",
    series: ctx.settings.season.series_title,
    sourceLabel: label || null,
    names: ctx.settings.brief.names,
    workedExample: ctx.settings.brief.worked_example,
    runId: ctx.run.id,
  });
  const missing = unfilledPlaceholders(text);
  if (missing.length) throw new BriefError(`the prep brief for ep${ep.n} still has ${missing.join(", ")} after filling: PREP-BRIEF.md changed shape`);
  return { text, sha: sha256Of(text), path: path.join(ctx.paths.briefs, `prep-ep${ep.n}.md`), template_sha: tpl.sha };
}

/** The script-read brief (and the episode plan it proposes): the committed SCRIPT-BRIEF.md when the synced scripts carry one, else Studio's output contract. */
export function scriptBriefFor(ctx: NarratedContext, opts: { note?: string | null } = {}): FilledBrief {
  const planFile = fwd(path.join(ctx.paths.handoff, EPISODE_PLAN_FILE));
  const doc = scriptDocName(ctx);
  const label = sourceLabel(ctx) ?? ctx.run.slug;
  const first = ctx.settings.season.first_episode_n ?? 1;
  const [lo, hi] = ctx.settings.episode_target;
  const prior = ctx.settings.season.prior_projects.map((p) => path.join(ctx.paths.projects, ...p.split("/")));
  const priorScript = prior.map((d) => newestScriptDoc(d)).filter((x): x is string => !!x).pop() ?? null;
  const committed = path.join(ctx.paths.scripts, SCRIPT_BRIEF_FILE);
  let body: string;
  let templateSha: string | null = null;
  if (existsSync(committed)) {
    const md = readFileSync(committed, "utf8").replace(/\r\n/g, "\n");
    const block = textBlockAfter(md, /^## The brief\s*$/m) ?? md;
    templateSha = sha256Of(readFileSync(committed));
    body = absolutizeBriefPaths(
      block
        .replace(/\{PROJ\}/g, fwd(path.relative(ctx.paths.projects, ctx.paths.film)))
        .replace(/\{SCRIPT\}/g, doc)
        .replace(/\{SOURCE\}/g, label)
        .replace(/\{FIRST_N\}/g, String(first))
        .replace(/\{PLAN_FILE\}/g, planFile),
      { projectsRoot: ctx.paths.projects, dramaRemixRoot: path.dirname(path.dirname(ctx.canonicalScripts)) }
    );
  } else {
    body = [
      `Use the drama-remix skill (the narrated skip-through route). PROJECT: ${fwd(ctx.paths.film)} - run everything from there, in bash. The source is source/original.mp4 (${label}).`,
      "",
      `Do step 1 of "Order of work" in ${fwd(path.join(path.dirname(path.dirname(ctx.canonicalScripts)), "references", "skip-through-pipeline.md"))} for this source: read index/script_raw.md END TO END (every line with its OCR and vision notes; the W ids are index/whisper.json segments) and author:`,
      `1. ${doc}, the full story read, in the shape of ${priorScript ? fwd(priorScript) : "the previous source's SCRIPT-*.md"}. Its WHO-IS-WHO table corrects the vision log, which often gets names wrong: check who is who on the frames (index/sheets/min-*.png) before you name anyone.`,
      `2. glossary.json: {"canon": [...], "banned": {"wrong": "right"}} - extend the previous project's; gate.py fails any banned variant.`,
      `3. frame_premise.txt: the story premise the vision readers get. Name the narrator${ctx.settings.narrator ? ` (${ctx.settings.narrator})` : ""} and every person by look and costume.`,
      `4. The episode plan, into ${planFile} (outside the project, Studio reads it): {"episodes": [{"n", "src_in", "src_out", "title", "subtitle", "hook", "story"}]}, numbered from ${first}, windows in source seconds, in order, ending on shot cuts (index/scdet.txt), each cut to a body of ${lo}-${hi} s (${mmss(lo)}-${mmss(hi)}); "title" is "EPISODE <n>", "subtitle" a short plain name, "hook" the line the episode ends on, "story" one paragraph: the beats inside the window, where the previous episode ended, what the viewer knows that the heroine does not, and what must land.`,
      "",
      "Write nothing else: no epN folders, no edl/, no cutting, no TTS, no GPU scripts, no build_ep.sh, no git. When you are done, a short summary of the script, the names you settled and the plan.",
    ].join("\n");
  }
  const note = opts.note?.trim() ? `\n\nRuobin sent this back with a note: ${opts.note.trim()}\nChange what the note asks for; keep what it does not mention.` : "";
  const text = `[Pulsar Studio run ${ctx.run.id.slice(0, 8)}, script read] This session was started by Pulsar Studio.\n\n${body}${note}\n`;
  return { text, sha: sha256Of(text), path: path.join(ctx.paths.briefs, "script.md"), template_sha: templateSha };
}
