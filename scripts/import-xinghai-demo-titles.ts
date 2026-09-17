/** Import the bundled Xinghai catalog into live Supabase. Dry-run by default. */
import { loadEnvConfig } from "@next/env";
import { createClient } from "@supabase/supabase-js";
import { buildDemoSeed } from "../data/fixture/demo-catalog";
import { PRODUCER_ID } from "../data/fixture/ids";

loadEnvConfig(process.cwd());

const apply = process.argv.includes("--apply");
if (process.argv.some((arg) => arg.startsWith("--") && arg !== "--apply" && arg !== "--dry-run")) {
  throw new Error("Usage: tsx scripts/import-xinghai-demo-titles.ts [--dry-run | --apply]");
}
if (apply && process.argv.includes("--dry-run")) throw new Error("Choose one mode");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("Missing Supabase server configuration");
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

async function main() {
  const demo = buildDemoSeed();
  const titles = demo.titles.map(({ created_at: _created, updated_at: _updated, ...row }) => ({ ...row, status: "candidate" as const, china_metrics: {}, deliverables: {}, license_start: null, license_end: null, notes: "Imported from the sample Xinghai catalog. Verify rights and upload source materials before use." }));
  const adaptations = demo.adaptations.map(({ created_at: _created, created_by: _fixtureUser, ...row }) => ({ ...row, created_by: null }));
  if (titles.length !== 14 || adaptations.length !== 14 || titles.some((t) => t.producer_id !== PRODUCER_ID)) {
    throw new Error("Unexpected Xinghai fixture shape; import stopped");
  }

  const { data: producer, error: producerError } = await db.schema("core").from("producers")
    .select("id,name_zh,name_en").eq("id", PRODUCER_ID).maybeSingle();
  if (producerError) throw producerError;
  if (!producer) throw new Error(`Xinghai producer ${PRODUCER_ID} is missing`);
  console.log(`Producer: ${producer.name_en ?? producer.name_zh} (${producer.id})`);

  const { data: existingTitles, error: titleError } = await db.schema("core").from("titles")
    .select("id,external_id,producer_id,name_zh,name_en").or(`producer_id.eq.${PRODUCER_ID},id.in.(${titles.map((t) => t.id).join(",")}),external_id.in.(${titles.map((t) => t.external_id).join(",")})`);
  if (titleError) throw titleError;
  const { data: existingAdaptations, error: adaptationError } = await db.schema("studio").from("adaptations")
    .select("id,external_id,title_id,target_locale").or(`title_id.in.(${titles.map((t) => t.id).join(",")}),id.in.(${adaptations.map((a) => a.id).join(",")}),external_id.in.(${adaptations.map((a) => a.external_id).join(",")})`);
  if (adaptationError) throw adaptationError;

  const conflicts: string[] = [];
  const missingTitles = titles.filter((t) => {
    const sameId = existingTitles?.find((e) => e.id === t.id);
    if (sameId) {
      if (sameId.producer_id !== t.producer_id || sameId.external_id !== t.external_id || sameId.name_zh !== t.name_zh || sameId.name_en !== t.name_en) conflicts.push(`title ID ${t.id} belongs to different catalog content`);
      return false;
    }
    const clash = existingTitles?.find((e) => e.external_id === t.external_id || (e.producer_id === PRODUCER_ID && e.name_zh === t.name_zh));
    if (clash) conflicts.push(`title ${t.name_en}: existing row ${clash.id} has the same external ID or Chinese name`);
    return true;
  });
  const missingAdaptations = adaptations.filter((a) => {
    const sameId = existingAdaptations?.find((e) => e.id === a.id);
    if (sameId) {
      if (sameId.title_id !== a.title_id || sameId.external_id !== a.external_id || sameId.target_locale !== a.target_locale) conflicts.push(`adaptation ID ${a.id} belongs to different content`);
      return false;
    }
    const clash = existingAdaptations?.find((e) => e.external_id === a.external_id || (e.title_id === a.title_id && e.target_locale === a.target_locale));
    if (clash) conflicts.push(`adaptation for title ${a.title_id}: existing row ${clash.id} conflicts`);
    return true;
  });

  console.log(`Demo: ${titles.length} titles, ${adaptations.length} adaptations`);
  console.log(`Existing: ${titles.length - missingTitles.length} matching titles, ${adaptations.length - missingAdaptations.length} matching adaptations`);
  console.log(`To add: ${missingTitles.length} titles, ${missingAdaptations.length} adaptations`);
  for (const t of missingTitles) console.log(`  + ${t.name_en} (${t.id})`);
  if (conflicts.length) {
    for (const conflict of conflicts) console.error(`CONFLICT: ${conflict}`);
    throw new Error(`${conflicts.length} conflict(s); no writes performed`);
  }
  if (!apply) { console.log("Dry run complete. Use --apply to import."); return; }

  // Parent first. Stable IDs make a partial run safe to resume after inspection.
  for (const title of missingTitles) {
    const { error } = await db.schema("core").from("titles").insert(title);
    if (error) throw new Error(`Could not insert title ${title.name_en}: ${error.message}`);
  }
  for (const adaptation of missingAdaptations) {
    const { error } = await db.schema("studio").from("adaptations").insert(adaptation);
    if (error) throw new Error(`Could not insert adaptation for ${adaptation.title_id}: ${error.message}`);
  }
  console.log(`Imported ${missingTitles.length} titles and ${missingAdaptations.length} adaptations.`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });



