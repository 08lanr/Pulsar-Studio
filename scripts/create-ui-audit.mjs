// Temporary, same-origin UI accessibility runner for the in-app browser.
// Generate: node scripts/create-ui-audit.mjs
// Remove generated public assets: node scripts/create-ui-audit.mjs --clean
// Never deploy the generated files. This script does not import application code.
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const marker = "PULSAR_TEMPORARY_UI_AUDIT";
const htmlPath = path.join(root, "public", "producer", "__ui-audit.html");
const axePath = path.join(root, "public", "producer", "__ui-audit-axe.js");
const generated = [htmlPath, axePath];
for (const file of generated) {
  if (existsSync(file) && !readFileSync(file, "utf8").slice(0, 200).includes(marker)) {
    throw new Error("Refusing to replace an unrelated file: " + file);
  }
}
if (process.argv.includes("--clean")) {
  for (const file of generated) if (existsSync(file)) unlinkSync(file);
  console.log("Removed the two generated UI-audit public assets.");
  process.exit(0);
}
if (process.env.NODE_ENV === "production") throw new Error("The temporary UI audit harness cannot be generated in production.");

const source = path.join(root, "tmp", "browser-check", "node_modules", "axe-core", "axe.min.js");
if (!existsSync(source)) throw new Error("axe-core is unavailable at " + source);
mkdirSync(path.dirname(htmlPath), { recursive: true });
writeFileSync(axePath, "/* " + marker + " — do not deploy. */\n" + readFileSync(source, "utf8"));
writeFileSync(htmlPath, String.raw`<!doctype html>
<!-- PULSAR_TEMPORARY_UI_AUDIT — generated development evidence tool, do not deploy. -->
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Pulsar Studio — temporary UI accessibility runner</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font: 14px/1.5 "Segoe UI", sans-serif; color: #17243b; background: #f3f6fa; }
    header { padding: 16px; border-bottom: 1px solid #b8c4d5; }
    h1 { font-size: 20px; margin: 0 0 6px; }
    p { margin: 0 0 12px; }
    form, .actions { display: flex; align-items: end; gap: 8px; flex-wrap: wrap; }
    label { display: grid; gap: 4px; flex: 1 1 300px; }
    input, button { font: inherit; min-height: 40px; padding: 8px 12px; border: 1px solid #526176; border-radius: 6px; }
    input { min-width: 0; width: 100%; background: white; }
    button { background: #1e40af; color: white; cursor: pointer; }
    button:disabled { cursor: wait; opacity: .65; }
    :focus-visible { outline: 3px solid #1e40af; outline-offset: 3px; }
    iframe { display: block; width: 100%; height: 760px; border: 0; background: white; }
    #status { margin-top: 12px; }
    section { padding: 16px; border-top: 1px solid #b8c4d5; }
    h2 { font-size: 18px; margin: 0 0 12px; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; font: 12px/1.6 Consolas, monospace; }
  </style>
</head>
<body>
  <header>
    <h1>UI accessibility runner</h1>
    <p>Temporary local test tool. Uses your signed-in app session. Checks the rendered application inside the frame with axe-core.</p>
    <form id="route-form">
      <label for="route">Route path<input id="route" name="route" value="/producer" required autocomplete="off" spellcheck="false"></label>
      <button type="submit">Load</button>
      <button id="run" type="button" disabled>Run accessibility checks</button>
    </form>
    <p id="status" role="status" aria-live="polite">Loading /producer…</p>
  </header>
  <iframe id="app-frame" title="Pulsar Studio application under accessibility test" src="/producer"></iframe>
  <section aria-labelledby="result-heading">
    <h2 id="result-heading">Accessibility results</h2>
    <pre id="results" tabindex="0">No checks run yet.</pre>
  </section>
  <script>
    (function () {
      'use strict';
      var frame = document.getElementById('app-frame');
      var input = document.getElementById('route');
      var run = document.getElementById('run');
      var status = document.getElementById('status');
      var results = document.getElementById('results');
      var busy = false;
      function localRoute(value) {
        var route = value.trim();
        if (!route.startsWith('/') || route.startsWith('//') || route.includes('\\')) throw new Error('Enter a local path beginning with one /, such as /producer/titles.');
        var parsed = new URL(route, location.origin);
        if (parsed.origin !== location.origin || parsed.pathname.includes('/__ui-audit')) throw new Error('Only application paths on this origin are allowed.');
        return parsed.pathname + parsed.search + parsed.hash;
      }
      document.getElementById('route-form').addEventListener('submit', function (event) {
        event.preventDefault();
        if (busy) return;
        try {
          var route = localRoute(input.value);
          run.disabled = true;
          status.textContent = 'Loading ' + route + '…';
          results.textContent = 'No checks run for this navigation yet.';
          frame.src = route;
        } catch (error) { status.textContent = error.message; }
      });
      frame.addEventListener('load', function () {
        run.disabled = false;
        try { status.textContent = 'Loaded ' + frame.contentWindow.location.pathname + '. Wait for pending application updates, then run accessibility checks.'; }
        catch (_) { run.disabled = true; status.textContent = 'The frame left the local app origin. Load a local application route to continue.'; }
      });
      function loadAxe() {
        return new Promise(function (resolve, reject) {
          var win = frame.contentWindow;
          if (win.axe) { resolve(win.axe); return; }
          var script = win.document.createElement('script');
          script.src = '/producer/__ui-audit-axe.js';
          script.onload = function () { resolve(win.axe); };
          script.onerror = function () { reject(new Error('Could not load the local axe-core asset.')); };
          win.document.head.appendChild(script);
        });
      }
      run.addEventListener('click', async function () {
        if (busy) return;
        busy = true;
        run.disabled = true;
        status.textContent = 'Running axe-core against the rendered application…';
        try {
          if (frame.contentWindow.location.origin !== location.origin) throw new Error('Application frame is not on the local origin.');
          var axe = await loadAxe();
          var report = await axe.run(frame.contentWindow.document);
          var summary = {
            engine: report.testEngine,
            url: report.url,
            checkedAt: report.timestamp,
            viewport: { width: frame.contentWindow.innerWidth, height: frame.contentWindow.innerHeight },
            violationCount: report.violations.length,
            affectedNodeCount: report.violations.reduce(function (sum, item) { return sum + item.nodes.length; }, 0),
            passedRuleCount: report.passes.length,
            incompleteRuleCount: report.incomplete.length,
            violations: report.violations.map(function (item) {
              return { id: item.id, impact: item.impact, description: item.description, help: item.help, helpUrl: item.helpUrl, nodes: item.nodes.map(function (node) { return { target: node.target, html: node.html, failureSummary: node.failureSummary }; }) };
            }),
            needsManualReview: report.incomplete.map(function (item) { return { id: item.id, impact: item.impact, targets: item.nodes.map(function (node) { return node.target; }) }; })
          };
          results.textContent = JSON.stringify(summary, null, 2);
          status.textContent = 'Completed: ' + summary.violationCount + ' violations across ' + summary.affectedNodeCount + ' nodes; ' + summary.passedRuleCount + ' rules passed; ' + summary.incompleteRuleCount + ' rules need manual review. Results below.';
        } catch (error) {
          results.textContent = JSON.stringify({ error: error.message }, null, 2);
          status.textContent = 'Accessibility check failed: ' + error.message;
        } finally { busy = false; run.disabled = false; }
      });
    }());
  </script>
</body>
</html>
`);
console.log("Created temporary accessibility runner at /producer/__ui-audit.html using local axe-core.");
console.log("After verification run: node scripts/create-ui-audit.mjs --clean");
