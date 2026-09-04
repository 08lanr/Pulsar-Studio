// Which backend the app reads from. The UI must run with no Supabase project
// at all (fixture mode renders the bundled sample title) so the design can be
// iterated and demoed before the shared database exists, and so a partner
// demo never depends on the network.
//
//   DATA_SOURCE=fixture   bundled sample title, in-memory, read-mostly (default)
//   DATA_SOURCE=supabase  the shared Supabase project (see lib/supabase/)

export type DataSource = "fixture" | "supabase";

export function dataSource(): DataSource {
  return process.env.DATA_SOURCE === "supabase" ? "supabase" : "fixture";
}

/**
 * Fixture mode replays the canned bank instead of calling a model
 * (lib/demo-replay.ts). While it is on, NO real model call may happen —
 * lib/jobs.ts refuses at runJob — so a key in .env.local cannot spend money
 * from a demo. DEMO_REPLAY=0 is the explicit override.
 */
export function demoReplayActive(): boolean {
  return dataSource() === "fixture" && process.env.DEMO_REPLAY !== "0";
}
