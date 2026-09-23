// The shared process runner (lib/python.ts): stdout and stderr streamed by
// line and kept as tails, stdin delivered, the exit code answered rather
// than thrown, a timeout that kills the process tree, a cancel that does the
// same, a heartbeat while it runs, the spawn-failure message the transcription
// and alignment helpers always gave, and Git Bash found for index_cut.sh.
// Every python case is skipped when no python answers --version.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { gitBashPath, lastLine, pipelinePython, pythonAvailable, runBashScript, runProcess, runPython } from "@/lib/python";

const HAVE_PYTHON = pythonAvailable();
const skipNote = `no python answers --version (STUDIO_PIPELINE_PYTHON=${pipelinePython()})`;

test("pipelinePython: STUDIO_PIPELINE_PYTHON, else python", () => {
  const prev = process.env.STUDIO_PIPELINE_PYTHON;
  try {
    delete process.env.STUDIO_PIPELINE_PYTHON;
    assert.equal(pipelinePython(), "python");
    process.env.STUDIO_PIPELINE_PYTHON = "C:/py/python.exe";
    assert.equal(pipelinePython(), "C:/py/python.exe");
  } finally {
    if (prev === undefined) delete process.env.STUDIO_PIPELINE_PYTHON;
    else process.env.STUDIO_PIPELINE_PYTHON = prev;
  }
});

test("a python -c run: lines in order, tails kept, the exit code answered, the duration measured", async (t) => {
  if (!HAVE_PYTHON) return t.skip(skipNote);
  const lines: string[] = [];
  const r = await runPython(["-c", "import sys\nprint('one')\nprint('two', flush=True)\nprint('warn', file=sys.stderr)\nsys.exit(3)"], {
    onLine: (stream, line) => lines.push(`${stream}:${line}`),
  }).done;
  assert.equal(r.code, 3);
  assert.equal(r.timedOut, false);
  assert.equal(r.cancelled, false);
  assert.ok(r.durationMs >= 0);
  assert.deepEqual(lines.filter((l) => l.startsWith("stdout:")), ["stdout:one", "stdout:two"]);
  assert.deepEqual(lines.filter((l) => l.startsWith("stderr:")), ["stderr:warn"]);
  assert.equal(r.stdoutTail.replace(/\r/g, ""), "one\ntwo\n");
  assert.equal(r.stderrTail.replace(/\r/g, ""), "warn\n");
  assert.equal(r.stdout, "", "the whole stdout is kept only on request");
  assert.equal(lastLine(r.stdoutTail), "two");
});

test("stdin is delivered and the whole stdout kept when asked (the transcription helper's shape); a refusal is exit 1 with its reason on stdout", async (t) => {
  if (!HAVE_PYTHON) return t.skip(skipNote);
  const r = await runPython(["-c", "import sys, json\nd = json.load(sys.stdin)\nprint(json.dumps({'echo': d['x'], 'utf8': '你好'}))"], { stdin: JSON.stringify({ x: 42 }), captureStdout: true }).done;
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout), { echo: 42, utf8: "你好" }, "PYTHONIOENCODING=utf-8 keeps a Chinese line whole");

  const refused = await runPython(["-c", "print('REFUSED: this film has delivered cuts (review/cuts-0-900-DELIVERED.json). Add')\nprint('  --pin-from review/cuts-0-900-DELIVERED.json')\nraise SystemExit(1)"], { tailChars: 60 }).done;
  assert.equal(refused.code, 1);
  assert.ok(refused.stdoutTail.length <= 60, "the tail is capped");
  assert.match(refused.stdoutTail, /--pin-from review\/cuts-0-900-DELIVERED\.json/);
});

test("a timeout kills the process tree and says so; a cancel does the same", async (t) => {
  if (!HAVE_PYTHON) return t.skip(skipNote);
  const dir = mkdtempSync(path.join(tmpdir(), "studio-runner-"));
  try {
    // The fake script starts a child of its own and sleeps; a tree kill must take the child too.
    const marker = path.join(dir, "child-alive.txt").replace(/\\/g, "/");
    const script = path.join(dir, "sleepy.py");
    writeFileSync(
      script,
      [
        "import subprocess, sys, time",
        `child = subprocess.Popen([sys.executable, '-c', 'import time\\nwhile True: time.sleep(0.1)'])`,
        `open(${JSON.stringify(marker)}, 'w').write(str(child.pid))`,
        "print('started', flush=True)",
        "time.sleep(60)",
      ].join("\n")
    );
    const t0 = Date.now();
    const r = await runPython([script], { timeoutMs: 1500 }).done;
    assert.equal(r.timedOut, true);
    assert.equal(r.cancelled, false);
    assert.ok(r.code !== 0, `killed: code ${r.code} signal ${r.signal}`);
    assert.ok(Date.now() - t0 < 30_000, "did not wait for the sleep");
    assert.ok(existsSync(marker), "the script ran far enough to start its child");
    const childPid = Number(require("node:fs").readFileSync(marker, "utf8"));
    // The grandchild is gone too: a liveness check by pid.
    const { pidAlive } = await import("@/lib/locks");
    for (let i = 0; i < 20 && pidAlive(childPid); i++) await new Promise((r) => setTimeout(r, 250));
    assert.equal(pidAlive(childPid), false, "the child process of the script was killed with it");

    const run = runPython(["-c", "import time\nprint('go', flush=True)\ntime.sleep(60)"], {});
    await new Promise((r) => setTimeout(r, 300));
    await run.cancel();
    const c = await run.done;
    assert.equal(c.cancelled, true);
    assert.ok(c.code !== 0);
    await run.cancel(); // idempotent after exit
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a heartbeat fires while the process runs and stops with it", async (t) => {
  if (!HAVE_PYTHON) return t.skip(skipNote);
  let beats = 0;
  const r = await runPython(["-c", "import time\ntime.sleep(2.6)"], { heartbeat: { cb: () => void beats++, everyMs: 1000 } }).done;
  assert.equal(r.code, 0);
  assert.ok(beats >= 1 && beats <= 3, `beats: ${beats}`);
  const after = beats;
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(beats, after, "no beat after the process ended");
});

test("a command that cannot start rejects with the message lib/asr.ts always gave", async () => {
  await assert.rejects(runProcess("definitely-not-a-program-xyz", ["--version"]).done, /^Error: could not run definitely-not-a-program-xyz: /);
});

test("git bash is found on a machine with Git for Windows, and runs a script from the film's cut/ folder", async (t) => {
  const bash = gitBashPath();
  if (!bash) return t.skip("no bash found (set STUDIO_BASH)");
  if (process.platform === "win32") {
    assert.match(bash, /bash\.exe$/i);
    assert.ok(!/System32/i.test(bash), "never the WSL launcher");
    assert.ok(existsSync(bash));
  }
  const dir = mkdtempSync(path.join(tmpdir(), "studio-bash-"));
  try {
    const cut = path.join(dir, "cut");
    require("node:fs").mkdirSync(path.join(cut, "scripts"), { recursive: true });
    writeFileSync(path.join(cut, "scripts", "hello.sh"), 'cd "$(dirname "$0")/.." || exit 1\necho "cwd $(basename "$PWD") args $*"\necho "== whisper" >&2\nexit 0\n');
    const r = await runBashScript("scripts\\hello.sh", ["--src", "../source/original.mp4", "--to", "900"], { cwd: cut }).done;
    assert.equal(r.code, 0, r.stderrTail);
    assert.equal(lastLine(r.stdoutTail), "cwd cut args --src ../source/original.mp4 --to 900");
    assert.equal(lastLine(r.stderrTail), "== whisper");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
