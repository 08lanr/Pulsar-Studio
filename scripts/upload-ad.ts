// Upload a finished ad from the command line (decision 2026-09-25, "Ad types
// on clips"). The same path as the "Upload ads" card (app/api/titles/[id]/
// clips/upload): content-addressed file under the title's first episode, a
// rendered, shortlisted clip with the ad text as its hook, and its ad type.
// It exists so a finished ad made on this machine (drama-remix hook ads,
// trailers) reaches Studio without a browser session. Dry run by default.
//
//   node --import tsx scripts/upload-ad.ts --list
//   node --import tsx scripts/upload-ad.ts --title <uuid|slug|name> --file ad.mp4 --hook "Ad text" [--format hook_ad] [--write]
//   node --import tsx scripts/upload-ad.ts --title <uuid|slug|name> --clip <clip uuid> --format narration_trailer [--write]
//
// --write needs DATA_SOURCE=supabase (set it, or run it from `npm run dev:live`'s
// environment); it writes as the system actor, like the route does after its
// own authorization, which is why this lives in scripts/ and not in a route.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

import { AD_FORMATS, isAdFormat } from "@/lib/ad-formats";
import type { AdFormat } from "@/lib/ad-formats";

type Args = { list: boolean; title?: string; file?: string; hook?: string; format?: string; clip?: string; write: boolean };

const HOOK_MAX = 100;

function usage(msg?: string): never {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(
    "usage: node --import tsx scripts/upload-ad.ts --list\n" +
      "       node --import tsx scripts/upload-ad.ts --title <uuid|slug|name> --file <video> --hook <ad text> [--format <type>] [--write]\n" +
      "       node --import tsx scripts/upload-ad.ts --title <uuid|slug|name> --clip <clip uuid> --format <type|none> [--write]\n" +
      `  types: ${AD_FORMATS.join(", ")}; dry run by default`
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const out: Args = { list: false, write: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list") out.list = true;
    else if (a === "--write") out.write = true;
    else if (a === "--title") out.title = argv[++i];
    else if (a === "--file") out.file = argv[++i];
    else if (a === "--hook") out.hook = argv[++i];
    else if (a === "--format") out.format = argv[++i];
    else if (a === "--clip") out.clip = argv[++i];
    else usage(`unknown argument ${a}`);
  }
  if (!out.list && !out.title) usage("missing --title");
  if (!out.list && !out.file && !out.clip) usage("give --file to upload or --clip to relabel");
  if (out.format && out.format !== "none" && !isAdFormat(out.format)) usage(`unknown type ${out.format}`);
  if (out.clip && !out.format) usage("--clip needs --format");
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

/** Duration and size from the local file; null when ffprobe is missing (the route does the same). */
function probe(file: string): { duration_ms: number | null; width: number | null; height: number | null } {
  try {
    const bin = process.env.FFMPEG_PATH ? process.env.FFMPEG_PATH.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1") : "ffprobe";
    const out = execFileSync(bin, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", file], { encoding: "utf8" });
    const j = JSON.parse(out);
    const s = j.streams?.[0] ?? {};
    return { duration_ms: j.format?.duration ? Math.round(Number(j.format.duration) * 1000) : null, width: s.width ?? null, height: s.height ?? null };
  } catch {
    return { duration_ms: null, width: null, height: null };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadEnvLocal();
  const { getData } = await import("@/lib/data");
  const { systemSession } = await import("@/lib/auth");
  const { uploadMedia, uploadedClipFilename, mediaUrl } = await import("@/lib/data/storage");
  const data = getData();
  const session = systemSession();
  console.log(`data source: ${process.env.DATA_SOURCE ?? "fixture"}`);

  const titles = await data.listTitles(session);
  if (args.list) {
    for (const t of titles) console.log(`${t.id}  ${t.crazydramas_slug ?? "-"}  ${t.name_en ?? t.name_zh ?? ""}`);
    return;
  }
  const key = args.title!.toLowerCase();
  const title = titles.find((t) => t.id === args.title || (t.crazydramas_slug ?? "").toLowerCase() === key || (t.name_en ?? "").toLowerCase() === key);
  if (!title) usage(`no title matches "${args.title}" (run --list)`);
  console.log(`title: ${title.name_en} (${title.id})`);
  const format: AdFormat | null = !args.format || args.format === "none" ? null : (args.format as AdFormat);

  if (args.clip) {
    console.log(`relabel clip ${args.clip} -> ${format ?? "not set"}`);
    if (!args.write) return console.log("dry run: add --write to save");
    const clip = await data.setClipAdFormat(session, title.id, args.clip, format);
    console.log(`saved: ${clip.id} ad_format=${clip.ad_format ?? "null"}`);
    return;
  }

  const file = path.resolve(args.file!);
  if (!fs.existsSync(file)) usage(`no such file ${file}`);
  const bytes = new Uint8Array(fs.readFileSync(file));
  const hook = (args.hook ?? "").replace(/\s+/g, " ").trim().slice(0, HOOK_MAX) || path.basename(file).replace(/\.[^.]+$/, "").slice(0, HOOK_MAX);
  const render_sha256 = createHash("sha256").update(bytes).digest("hex");
  const probed = probe(file);
  const detail = await data.getTitle(session, title.id);
  const first = [...detail.episodes].sort((a, b) => a.number - b.number)[0];
  if (!first) usage("that title has no episode to file the ad under");
  console.log(`file: ${path.basename(file)} ${(bytes.length / 1e6).toFixed(1)} MB, ${probed.duration_ms ?? "?"} ms, ${probed.width}x${probed.height}`);
  console.log(`ad text: ${hook}`);
  console.log(`type: ${format ?? "not set"}; filed under episode ${first.number}`);
  if (!args.write) return console.log("dry run: add --write to upload");

  const stored = await uploadMedia(title.id, first.id, uploadedClipFilename(render_sha256, path.basename(file)), bytes, "video/mp4");
  const clip = await data.addUploadedClip(session, first.id, {
    render_path: stored,
    render_sha256,
    hook_en: hook,
    ...probed,
    ...(format ? { ad_format: format } : {}),
  });
  console.log(`uploaded: clip ${clip.id} (${clip.status}) ${mediaUrl(stored) ?? stored}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
