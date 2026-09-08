// Reset the running dev server's demo dataset (fixture mode only).
//
//   npm run demo:reset                 # reseed the demo catalog on http://localhost:3200
//   npm run demo:reset -- --seed empty # the bare seed (what the test runner uses)
//   npm run demo:reset -- --url http://localhost:3201
//
// Talks to POST /api/demo/reset with the fixture persona cookie; the route
// 404s in supabase mode, so this can never touch a real database.
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const url = flag("--url", process.env.STUDIO_URL ?? "http://localhost:3200");
const seed = flag("--seed", "demo");
if (!["demo", "empty"].includes(seed)) {
  console.error("--seed must be demo or empty");
  process.exit(2);
}
const origin = new URL(url).origin;
try {
  const res = await fetch(`${origin}/api/demo/reset`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, cookie: "studio_dev_session=staff" },
    body: JSON.stringify({ seed }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`reset refused (${res.status}):`, body.error ?? body);
    process.exit(1);
  }
  console.log(`demo dataset reset (${body.seed}) at ${body.reset_at} on ${origin}`);
} catch (err) {
  console.error(`could not reach ${origin}. Is the dev server running (npm run dev)?`, err.message);
  process.exit(1);
}
