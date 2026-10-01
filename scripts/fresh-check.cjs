// Refuse to start a Studio that is behind GitHub (Ruobin, 2026-10-01: "if my
// cofounder tries to start an older version tell them to use a new one").
// Two computers run Studio against the same live database (decision
// 2026-09-24, "Two computers, one database"), and an old copy shows old
// screens and can write with old rules. next.config.js calls this when a dev
// server starts (`npm run dev`, `npm run dev:live`, `next dev`), so every way
// of starting Studio is covered.
//
//   behind origin/main  print what to do and stop
//   up to date / ahead  start
//   no git / offline    start, with a warning (never block on the network)
//   STUDIO_ALLOW_OLD=1  start anyway, on purpose (an old branch, a bisect)
//
// The answer is kept in STUDIO_FRESH_CHECKED, so the server's own child
// processes, which load the config again, do not fetch again.

const { execFileSync } = require("node:child_process");

const git = (args, timeout = 4000) =>
  execFileSync("git", args, { cwd: __dirname + "/..", encoding: "utf8", timeout, stdio: ["ignore", "pipe", "ignore"] }).trim();

/** Pure: what to do for a copy `behind` commits behind GitHub's main. */
function freshnessVerdict({ behind, allowOld }) {
  if (behind === null) return "unknown";
  if (behind > 0 && !allowOld) return "stop";
  return "start";
}

function staleMessage({ behind, mine, newest }) {
  const line = "=".repeat(72);
  return [
    "",
    line,
    `  This Studio is out of date: ${behind} update${behind === 1 ? "" : "s"} behind GitHub.`,
    `  Yours:  ${mine}`,
    `  Newest: ${newest}`,
    "",
    "  Use the new version. In this folder run:",
    "    git pull",
    "    npm install",
    "  then start Studio again the same way.",
    "",
    "  (An old Studio on the live database shows old screens and can undo",
    "  newer work. To start it anyway on purpose: set STUDIO_ALLOW_OLD=1.)",
    line,
    "",
  ].join("\n");
}

function assertFreshStudio() {
  if (process.env.STUDIO_FRESH_CHECKED) return;
  process.env.STUDIO_FRESH_CHECKED = "1";
  let behind = null;
  let mine = "";
  let newest = "";
  try {
    git(["rev-parse", "--git-dir"]);
    try {
      git(["fetch", "--quiet", "origin", "main"], 15000);
    } catch {
      console.warn("Studio could not reach GitHub to check for a newer version; starting anyway.");
    }
    behind = Number(git(["rev-list", "--count", "HEAD..origin/main"]));
    mine = git(["log", "-1", "--format=%h %cs %s", "HEAD"]);
    newest = git(["log", "-1", "--format=%h %cs %s", "origin/main"]);
  } catch {
    behind = null; // not a git checkout, or no origin/main: nothing to compare with
  }
  const verdict = freshnessVerdict({ behind, allowOld: process.env.STUDIO_ALLOW_OLD === "1" });
  if (verdict === "stop") {
    console.error(staleMessage({ behind, mine, newest }));
    process.exit(1);
  }
  if (behind && behind > 0) console.warn(`Starting an old Studio on purpose (STUDIO_ALLOW_OLD=1): ${behind} update(s) behind GitHub.`);
}

module.exports = { assertFreshStudio, freshnessVerdict, staleMessage };
