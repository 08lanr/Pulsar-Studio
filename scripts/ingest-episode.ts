// CLI ingest for one episode file, the operator's path (PRODUCT.md: staff
// ingest; producers review). Dry run by default so a founder can check what
// a producer's delivery parses into — format, lines, scenes, warnings —
// before anything is written. --write inserts through the service-role
// client exactly as docs/data-model.md names the columns; that client
// bypasses RLS, which is why this lives in scripts/ and not in a route.
//
//   node --import tsx scripts/ingest-episode.ts <file> [--title <uuid>] [--episode <n>] [--write]

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import { ingestEpisodeFile, type IngestResult } from "@/lib/ingest";
import { formatMs } from "@/lib/ingest/text";
import { dataSource } from "@/lib/data-source";

type Args = { file: string; title?: string; episode?: string; write: boolean };

function usage(msg?: string): never {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(
    "usage: node --import tsx scripts/ingest-episode.ts <file> [--title <uuid>] [--episode <n>] [--write]\n" +
      "  dry run by default; --write needs DATA_SOURCE=supabase, --title and --episode"
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const out: Args = { file: "", write: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") out.write = true;
    else if (a === "--title") out.title = argv[++i];
    else if (a === "--episode") out.episode = argv[++i];
    else if (a.startsWith("--")) usage(`unknown flag ${a}`);
    else if (!out.file) out.file = a;
    else usage(`unexpected argument ${a}`);
  }
  if (!out.file) usage("missing <file>");
  return out;
}

/** Next loads .env.local for the app; a bare tsx script has to do it itself. */
function loadEnvLocal() {
  const p = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

function printSummary(result: IngestResult, filename: string) {
  console.log(`file:      ${filename}`);
  console.log(`format:    ${result.format}${result.hasTimecodes ? "" : " (no timecodes: script-only view)"}`);
  console.log(`lines:     ${result.lines.length}`);
  console.log(`scenes:    ${result.scenes.length}`);
  console.log(`warnings:  ${result.warnings.length}`);
  for (const w of result.warnings) console.log(`  - ${w}`);
  console.log("first lines:");
  for (const l of result.lines.slice(0, 5)) {
    const when = l.start_ms === null ? "--" : `${formatMs(l.start_ms)} → ${formatMs(l.end_ms ?? l.start_ms)}`;
    const who = l.speaker ? `[${l.speaker}] ` : "";
    console.log(`  ${String(l.seq).padStart(3)}  ${when}  ${who}${l.text_zh.replace(/\n/g, " / ")}`);
  }
}

const WriteArgs = z.object({
  title: z.string().uuid({ message: "--title must be the title's uuid" }),
  episode: z.coerce.number().int().positive({ message: "--episode must be a positive integer" }),
});

async function writeToSupabase(result: IngestResult, filename: string, titleId: string, episodeNumber: number) {
  // Imported lazily: lib/supabase/server.ts pulls in next/headers, which a
  // dry run has no reason to load.
  const { createServiceSupabase } = await import("@/lib/supabase/server");
  const sb = createServiceSupabase();
  const core = sb.schema("core");
  const studio = sb.schema("studio");

  const fail = (step: string, error: { message: string } | null): never => {
    throw new Error(`${step}: ${error?.message ?? "no row returned"}`);
  };

  const { data: episode, error: epErr } = await core
    .from("episodes")
    .insert({
      title_id: titleId,
      number: episodeNumber,
      source_script_path: filename,
      script_format: result.format,
      has_timecodes: result.hasTimecodes,
    })
    .select("id")
    .single();
  if (epErr || !episode) fail("insert core.episodes", epErr);
  const episodeId = episode!.id as string;

  // studio.scenes / studio.lines require start_ms and end_ms; a script
  // document has none, so the degraded path writes 0 and has_timecodes=false
  // tells the UI not to trust them.
  const { data: sceneRows, error: scErr } = await studio
    .from("scenes")
    .insert(
      result.scenes.map((s) => ({
        title_id: titleId,
        episode_id: episodeId,
        number: s.number,
        start_ms: s.start_ms ?? 0,
        end_ms: s.end_ms ?? 0,
      }))
    )
    .select("id, number");
  if (scErr || !sceneRows) fail("insert studio.scenes", scErr);
  const sceneIdByNumber = new Map<number, string>(
    (sceneRows as Array<{ id: string; number: number }>).map((r) => [r.number, r.id])
  );

  // Speakers become studio.characters (unique per title on name_zh); the
  // adapted name is per adaptation and comes later.
  const names = [...new Set(result.lines.map((l) => l.speaker).filter((s): s is string => !!s))];
  const characterIdByName = new Map<string, string>();
  if (names.length) {
    const { data: chars, error: chErr } = await studio
      .from("characters")
      .upsert(
        names.map((name_zh) => ({ title_id: titleId, name_zh })),
        { onConflict: "title_id,name_zh" }
      )
      .select("id, name_zh");
    if (chErr || !chars) fail("upsert studio.characters", chErr);
    for (const c of chars as Array<{ id: string; name_zh: string }>) characterIdByName.set(c.name_zh, c.id);
  }

  const sceneForSeq = (seq: number) => result.scenes.find((s) => seq >= s.from_seq && seq <= s.to_seq)!;
  const lineRows = result.lines.map((l) => ({
    title_id: titleId,
    scene_id: sceneIdByNumber.get(sceneForSeq(l.seq).number)!,
    seq: l.seq,
    character_id: l.speaker ? characterIdByName.get(l.speaker) ?? null : null,
    start_ms: l.start_ms ?? 0,
    end_ms: l.end_ms ?? 0,
    text_zh: l.text_zh,
  }));
  const CHUNK = 500;
  for (let i = 0; i < lineRows.length; i += CHUNK) {
    const { error: lnErr } = await studio.from("lines").insert(lineRows.slice(i, i + CHUNK));
    if (lnErr) fail(`insert studio.lines (${i + 1}..${Math.min(i + CHUNK, lineRows.length)})`, lnErr);
  }

  console.log(`\nwrote episode ${episodeNumber} (${episodeId}): ${result.scenes.length} scenes, ${result.lines.length} lines, ${names.length} characters`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadEnvLocal();

  const file = path.resolve(args.file);
  if (!fs.existsSync(file)) usage(`file not found: ${file}`);
  const filename = path.basename(file);
  const result = ingestEpisodeFile(new Uint8Array(fs.readFileSync(file)), filename);
  printSummary(result, filename);

  if (!args.write) {
    console.log("\ndry run — pass --write with DATA_SOURCE=supabase to insert");
    return;
  }
  if (dataSource() !== "supabase") {
    console.error("\n--write needs DATA_SOURCE=supabase (currently fixture); set it in .env.local or the environment");
    process.exit(1);
  }
  const parsed = WriteArgs.safeParse({ title: args.title, episode: args.episode });
  if (!parsed.success) usage(parsed.error.issues.map((i) => i.message).join("; "));
  if (!result.lines.length) {
    console.error("\nnothing to write: the file produced no lines");
    process.exit(1);
  }

  try {
    await writeToSupabase(result, filename, parsed.data.title, parsed.data.episode);
  } catch (e) {
    // A missing key or an RLS/schema error is an operator problem; the
    // message says what to fix. Only a real bug deserves a stack trace.
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`\nwrite failed: ${msg}`);
    if (/^Missing /.test(msg)) {
      console.error("set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local (see .env.example)");
    }
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
