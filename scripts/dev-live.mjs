import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import nextEnv from "@next/env";

const require = createRequire(import.meta.url);
nextEnv.loadEnvConfig(process.cwd());

const required = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
const missing = required.filter(key => !process.env[key]?.trim());
if (missing.length) {
  console.error(`Live Studio cannot start. Set ${missing.join(", ")} in the server environment.`);
  process.exit(1);
}

const env = {
  ...process.env,
  DATA_SOURCE: "supabase",
  TIKTOK_MODE: "production",
  NEXT_DIST_DIR: ".next-redesign-live",
};
console.log("Starting live Studio at http://localhost:3203 with Supabase and TikTok production mode.");
const child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "dev", "-p", "3203"], { env, stdio: "inherit", windowsHide: true });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", error => { console.error(`Could not start Next.js: ${error.message}`); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
