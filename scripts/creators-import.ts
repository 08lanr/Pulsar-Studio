// Create (or find) a creator account and import a folder of pictures and
// videos into its library (decision 2026-10-12, docs/creator-accounts.md).
// The same import the Library tab uses (lib/creators/media.ts): PNG and WebP
// become high-quality JPEGs, a picture outside the feed's 4:5..1.91:1 is
// refused, and a file already in the library (same SHA-256) is skipped, so
// running it twice adds nothing.
//
//   node --import tsx scripts/creators-import.ts                       # dry run: Chloe, her staged photos
//   node --import tsx scripts/creators-import.ts --write               # fixture store (.uploads/), never the database
//   node --import tsx scripts/creators-import.ts --folder <dir> --handle <handle> [--name "<Name>"] [--instagram-id <id>] [--page-id <id>] [--persona persona.json] [--write]
//   node --import tsx scripts/creators-import.ts --live --write        # the live database (DATA_SOURCE=supabase from .env.local)
//
// Without --live the script forces DATA_SOURCE=fixture whatever .env.local
// says, so a slip of the keyboard cannot write to the live database. A
// running fixture dev server reads the fixture store at start: restart it to
// see what the script wrote.
//
// Descriptions: `descriptions.json` in the folder ({ "<file name>": { "description": "...", "tags": ["..."] } })
// wins; then the built-in ones for Chloe's staged files; then the file name's words.
// An existing account keeps its character bible unless --persona is given.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { CreatorPersona } from "@/lib/creators/types";

type Args = { folder: string; handle: string; name: string; instagramId: string; pageId: string | null; persona: string | null; write: boolean; live: boolean };

/** Chloe Lin, @chloelin.diary (the first creator account; decision 2026-10-12). */
export const CHLOE_PERSONA: CreatorPersona = {
  summary: "Chloe Lin, 25, lives in San Francisco. Works an office job somewhere around finance (never named), loves good coffee, walks by the water, pilates and small weekend trips. Her account is a soft diary of everyday life after work: cafés, the city, outfits, dinners with friends, quiet mornings.",
  age: 25,
  city: "San Francisco",
  interests: ["coffee and cafés", "city walks", "coastal hikes", "pilates and strength training", "weekend travel", "cooking at home", "outfits", "personal finance in plain words"],
  voice: "lowercase, soft and warm, a little dry; short lines; emoji-light (🤍 is hers, at most one or two); sounds like texting a friend, never like a brand. Her first caption: \"new account, so a little intro 🤍 i'm chloe, 25, based in sf. a little finance, a lot of coffee, and whatever happens after work\". Bio: \"finance, coffee & life after work\".",
  do: [
    "talk about real, small moments: the coffee, the walk, the light, the plan for the weekend",
    "be specific about what is in the picture",
    "answer questions briefly and warmly",
    "mirror the commenter's language",
  ],
  dont: [
    "promote anything, ever (no CrazyDramas, no apps, no brands, no links)",
    "name a real employer, a job title at a real company, or a professional credential",
    "give financial, investment, medical or legal advice",
    "say or hint whether she is human, real, a bot or AI",
    "ask people to DM, meet, or share contact details",
    "use more than three hashtags",
  ],
  banned_topics: ["politics", "religion", "specific stocks or crypto picks", "her salary or money amounts", "dating or sexual topics", "anyone under 18", "her exact address or workplace"],
};

/** What is in each of Chloe's staged photos (2026-10-12, checked by eye). 06 is a byte-identical copy of 01. */
export const CHLOE_LIBRARY: Record<string, { description: string; tags: string[] }> = {
  "01-cafe-workday.png": { description: "Chloe at a café table by the window before work: charcoal blazer over a white top, latte with leaf art in her hands, a busy San Francisco street outside.", tags: ["cafe", "coffee", "workday", "outfit"] },
  "02-coastal-walk.png": { description: "Selfie on a coastal trail above the Pacific: grey zip hoodie over a white tee, cypress trees, cliffs and the ocean behind her, overcast sky.", tags: ["coast", "walk", "weekend", "nature"] },
  "03-home-reset.png": { description: "At home on the sofa with a mug of coffee: light blue button-down, plants and bookshelves, big window with a view over the city.", tags: ["home", "coffee", "slow morning"] },
  "04-city-errand.png": { description: "Walking down a tree-lined San Francisco sidewalk, looking back over her shoulder: camel trench coat, jeans, tote bag, row of houses and parked cars.", tags: ["city", "errands", "outfit", "street"] },
  "05-dinner-out.png": { description: "Dinner on a restaurant terrace at dusk: black sleeveless top, gold necklace, the Bay Bridge and the city lights behind her.", tags: ["dinner", "night", "bay", "friends"] },
  "07-evening-dinner.png": { description: "Evening dinner inside a warm, candle-lit restaurant: black sleeveless top, smiling, Coit Tower and the hill lights through the window.", tags: ["dinner", "night", "city lights"] },
};

function usage(msg?: string): never {
  if (msg) console.error(`error: ${msg}\n`);
  console.error("usage: node --import tsx scripts/creators-import.ts [--folder <dir>] [--handle <handle>] [--name <name>] [--instagram-id <id>] [--page-id <id>] [--persona <file.json>] [--write] [--live]");
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    folder: "C:/Users/ruobi/Documents/Codex/2026-10-12/task/chloe-library-staging", handle: "chloelin.diary", name: "Chloe Lin",
    instagramId: "17841416495486333", pageId: null, persona: null, write: false, live: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i] ?? usage(`${a} needs a value`);
    if (a === "--folder") out.folder = next();
    else if (a === "--handle") out.handle = next();
    else if (a === "--name") out.name = next();
    else if (a === "--instagram-id") out.instagramId = next();
    else if (a === "--page-id") out.pageId = next();
    else if (a === "--persona") out.persona = next();
    else if (a === "--write") out.write = true;
    else if (a === "--live") out.live = true;
    else usage(`unknown argument ${a}`);
  }
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

const MEDIA = /\.(jpe?g|png|webp|mp4|mov)$/i;

function describe(folder: string, file: string): { description: string; tags: string[] } {
  const sidecar = path.join(folder, "descriptions.json");
  if (fs.existsSync(sidecar)) {
    const all = JSON.parse(fs.readFileSync(sidecar, "utf8")) as Record<string, { description?: string; tags?: string[] }>;
    if (all[file]?.description) return { description: all[file].description!, tags: all[file].tags ?? [] };
  }
  if (CHLOE_LIBRARY[file]) return CHLOE_LIBRARY[file];
  return { description: path.parse(file).name.replace(/^\d+[-_ ]*/, "").replace(/[-_]+/g, " "), tags: [] };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadEnvLocal();
  if (!args.live) process.env.DATA_SOURCE = "fixture";
  else if (process.env.DATA_SOURCE !== "supabase") usage("--live needs DATA_SOURCE=supabase (in .env.local or the environment)");
  if (!fs.existsSync(args.folder)) usage(`no folder ${args.folder}`);
  const backend = process.env.DATA_SOURCE === "supabase" ? "the LIVE database" : "the fixture store (.uploads/)";

  const { systemSession } = await import("@/lib/auth");
  const { getData } = await import("@/lib/data");
  const { importCreatorMedia } = await import("@/lib/creators/media");
  const { normalizeHandle } = await import("@/lib/data/creators");
  const session = systemSession();
  const data = getData();
  const handle = normalizeHandle(args.handle);
  const persona: CreatorPersona | null = args.persona ? JSON.parse(fs.readFileSync(args.persona, "utf8")) as CreatorPersona : null;

  const existing = await data.getCreatorAccount(session, handle).catch(() => null);
  console.log(`${args.write ? "Writing to" : "Dry run against"} ${backend}.`);
  console.log(existing ? `Account @${handle} exists (${existing.external_id}).` : `Account @${handle} will be created (Instagram ${args.instagramId}${args.pageId ? `, Page ${args.pageId}` : ", no Page"}).`);

  const files = fs.readdirSync(args.folder).filter(f => MEDIA.test(f)).sort();
  const seen = new Map<string, string>();
  const known = new Set(existing ? (await data.listCreatorMedia(session, existing.id)).map(m => m.sha256) : []);
  const plan: { file: string; sha: string; note: string }[] = [];
  for (const file of files) {
    const sha = createHash("sha256").update(fs.readFileSync(path.join(args.folder, file))).digest("hex");
    const note = seen.has(sha) ? `same file as ${seen.get(sha)}: skipped` : known.has(sha) ? "already in the library: skipped" : "new";
    if (!seen.has(sha)) seen.set(sha, file);
    plan.push({ file, sha, note });
  }
  for (const p of plan) console.log(`  ${p.file}  ${p.sha.slice(0, 12)}  ${p.note}`);
  if (!args.write) { console.log("Dry run: nothing written. Add --write."); return; }

  let account = existing;
  if (!account || persona) {
    // A new account needs its character bible: Chloe's is built in, anyone else's comes from --persona.
    const bible = persona ?? (handle === "chloelin.diary" ? CHLOE_PERSONA : null);
    if (!bible) usage(`@${handle} is new: give its character bible with --persona <file.json>`);
    account = (await data.upsertCreatorAccount(session, {
      handle, display_name: args.name, instagram_id: args.instagramId, page_id: args.pageId, persona: bible,
    })).account;
    console.log(`Account @${account.handle}: ${account.external_id}${existing ? " (character bible replaced)" : " (created)"}`);
  }
  let added = 0, skipped = 0, refused = 0;
  for (const p of plan) {
    if (p.note !== "new") { skipped += 1; continue; }
    const { description, tags } = describe(args.folder, p.file);
    try {
      const r = await importCreatorMedia(session, account.id, { bytes: fs.readFileSync(path.join(args.folder, p.file)), filename: p.file, description, tags });
      if (r.created) added += 1; else skipped += 1;
      console.log(`  ${r.created ? "added" : "exists"} ${r.media.external_id}  ${p.file}${r.converted ? " → JPEG" : ""}  ${r.media.width}×${r.media.height}${r.warnings.length ? `  (${r.warnings.join("; ")})` : ""}`);
    } catch (e) {
      refused += 1;
      console.log(`  refused ${p.file}: ${(e as Error).message}`);
    }
  }
  console.log(`Done: ${added} added, ${skipped} skipped, ${refused} refused.`);
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
