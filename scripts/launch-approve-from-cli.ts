// Approve a saved TikTok launch draft from the command line and run it (2026-10-08; Ruobin, in chat, after the
// drafts were previewed: "launch them yourself."). The Launch page's own path: submitLaunchRun (the approval, with
// the on-behalf note the audit keeps) -> executeLaunch -> monitorLaunch, as the system actor like upload-ad.ts.
//
//   DATA_SOURCE=supabase TIKTOK_MODE=production node --import tsx scripts/launch-approve-from-cli.ts --run <run id> --note "who approved, where" [--execute]
//   ... --monitor <run id>     print the run's campaigns and every ad's TikTok record (runs as, ads only, post)
import fs from "node:fs";
import path from "node:path";

function loadEnvLocal() {
  const p = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
}
const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  loadEnvLocal();
  const { getData } = await import("@/lib/data");
  const { systemSession } = await import("@/lib/auth");
  const { executeLaunch, monitorLaunch } = await import("@/lib/launch/service");
  const { withUserSupabase, createServiceSupabase } = await import("@/lib/supabase/server");
  const data = getData(); const session = systemSession();
  const runId = arg("--run") ?? arg("--monitor"); const note = arg("--note");
  if (!runId) { console.error("usage: --run <id> --note \"...\" [--execute] | --monitor <id>"); process.exit(2); }

  const printRun = async () => {
    const run = await data.getLaunchRun(session, runId);
    console.log(`run ${run.id} (${run.external_id}) "${run.draft.name}" status=${run.status} approved_by=${run.approved_by ?? "-"} error=${run.error ? JSON.stringify(run.error).slice(0, 200) : "-"}`);
    for (const c of run.campaigns ?? []) {
      const st = c.state as Record<string, unknown>;
      // `state.groups` is stored JSON: an array on every run the engine wrote,
      // but read defensively as a map too. Typed as unknown first, because
      // asserting the array type made Array.isArray narrow the other branch to
      // never and every group read back as unknown.
      type Group = { id?: string; key?: string; ads?: Record<string, string> };
      const rawGroups: unknown = st.groups ?? [];
      const groups: Group[] = Array.isArray(rawGroups)
        ? rawGroups as Group[]
        : Object.values(rawGroups as Record<string, Group>);
      console.log(`  campaign ${c.name} status=${c.status} tiktok_campaign=${(st.campaign_id as string | undefined) ?? "-"} error=${c.error ? JSON.stringify(c.error).slice(0, 300) : "-"}`);
      for (const g of groups) console.log(`    group ${g.key ?? ""} id=${g.id ?? "-"} ads=${JSON.stringify(g.ads ?? {})}`);
      if (st.waiting) console.log(`    waiting: ${JSON.stringify(st.waiting).slice(0, 200)}`);
      const snap = c.snapshot as { ads?: { id: string; status: string; runs_as?: string; ads_only?: boolean; post_url?: string; item_id?: string; content_value?: string; note?: string }[] } | null;
      for (const a of snap?.ads ?? []) console.log(`    ad ${a.id} ${a.status} runs_as=${a.runs_as ?? "-"} ads_only=${a.ads_only ?? "-"} item=${a.item_id ?? "-"} post=${a.post_url ?? "-"} content=${(a.content_value ?? "").slice(0, 8)} ${a.note ?? ""}`);
    }
    return run;
  };

  await withUserSupabase(createServiceSupabase(), async () => {
    if (arg("--monitor")) { await monitorLaunch(runId); await printRun(); return; }
    let current = await data.getLaunchRun(session, runId);
    // --retry: a failed run goes back to pending with its checkpoints (retryLaunchRun, the Launch page's Retry),
    // so --execute adopts the objects Meta or TikTok already holds instead of creating them again (2026-10-09).
    if (process.argv.includes("--retry") && current.status === "failed") {
      current = await data.retryLaunchRun(session, runId);
      console.log(`retry: "${current.draft.name}" status=${current.status}; failed campaigns are pending again, checkpoints kept`);
    }
    if (current.status === "draft") {
      await data.previewLaunchRun(session, runId);
      const approved = await data.submitLaunchRun(session, runId, current.revision, note ?? "approved from the command line");
      console.log(`approved: "${approved.draft.name}" status=${approved.status} by ${approved.approved_by} note="${approved.approval_note}" $${(approved.draft.total_budget_cents / 100).toFixed(0)}`);
    } else console.log(`already ${current.status}`);
    if (!process.argv.includes("--execute")) { console.log("not executing here: the Studio server's sweep (tickLaunches) runs pending launches, or pass --execute"); return; }
    for (let i = 0; i < 40; i++) {
      await executeLaunch(runId);
      const run = await data.getLaunchRun(session, runId);
      const states = run.campaigns.map(c => c.status);
      console.log(`[${new Date().toISOString().slice(11, 19)}] run ${run.status}; campaigns ${states.join(",")}`);
      if (!states.some(s => ["pending", "running"].includes(s)) && run.status !== "running") break;
      // A waiting campaign names its own delay (a Meta ad-account rate limit asks for five minutes, 2026-10-10);
      // attempting sooner only spends more of the allowance that ran out.
      const waits = run.campaigns.map(c => (c.state as { waiting?: { since?: string; retry_after_ms?: number; reason?: string } }).waiting).filter(Boolean) as { since?: string; retry_after_ms?: number; reason?: string }[];
      const due = Math.max(0, ...waits.map(w => Date.parse(w.since ?? "") + (w.retry_after_ms ?? 60_000) - Date.now()));
      if (waits.length) console.log(`  waiting ${Math.ceil(Math.max(due, 30_000) / 1000)}s: ${waits[0].reason?.slice(0, 120)}`);
      await sleep(waits.length ? Math.max(due, 30_000) : 5_000);
    }
    await monitorLaunch(runId);
    await printRun();
  });
}
main().catch(e => { console.error("error:", e instanceof Error ? e.message : e); process.exit(1); });
