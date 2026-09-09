// Step 1 of the native-Chinese pass: decide which locale keys the producer
// portal can render, and gather them with their English meaning, current
// Chinese, source file and the code that references them.
//
// A key is in scope when a producer-side file (app/(producer), components/
// producer, the shared components, lib/) references it, either as a literal
// or through a template prefix such as `an.state.${state}`. Keys referenced
// only from app/(admin) or components/admin are staff chrome and stay as they
// are. Keys referenced nowhere never render and are skipped.
//
// Output: tmp/zh-native/keys.json (+ a short stats line). No network.

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const keyDir = path.join(root, "locales", "_keys");
const outDir = path.join(root, "tmp", "zh-native");

type Entry = { key: string; en: string; zh: string; file: string; refs: string[] };

function walk(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const entries = new Map<string, Entry>();
for (const name of fs.readdirSync(keyDir).filter((n) => n.endsWith(".json")).sort()) {
  const json = JSON.parse(fs.readFileSync(path.join(keyDir, name), "utf8")) as Record<string, { en: string; zh: string }>;
  for (const [key, v] of Object.entries(json)) entries.set(key, { key, en: v.en, zh: v.zh, file: name, refs: [] });
}

const producerFiles = [
  ...walk(path.join(root, "app", "(producer)")),
  ...walk(path.join(root, "components", "producer")),
  ...walk(path.join(root, "lib")),
  ...fs.readdirSync(path.join(root, "components")).filter((n) => /\.tsx?$/.test(n)).map((n) => path.join(root, "components", n)),
];
const adminFiles = [...walk(path.join(root, "app", "(admin)")), ...walk(path.join(root, "components", "admin")), ...walk(path.join(root, "components", "workbench"))];
// app/login, app/api and the root layout serve both portals.
const sharedFiles = [...walk(path.join(root, "app", "login")).concat(fs.existsSync(path.join(root, "app", "api")) ? [] : []), path.join(root, "app", "layout.tsx")].filter((p) => fs.existsSync(p));

const keys = [...entries.keys()];
const literalRe = /["'`]([a-z0-9]+(?:\.[A-Za-z0-9_-]+)+)["'`]/g;
const templateRe = /`([a-z0-9]+(?:\.[A-Za-z0-9_-]+)*\.)\$\{/g;

function refsIn(file: string): Set<string> {
  const src = fs.readFileSync(file, "utf8");
  const found = new Set<string>();
  for (const m of src.matchAll(literalRe)) if (entries.has(m[1])) found.add(m[1]);
  for (const m of src.matchAll(templateRe)) {
    const prefix = m[1];
    for (const k of keys) if (k.startsWith(prefix)) found.add(k);
  }
  return found;
}

const producerRefs = new Map<string, Set<string>>();
for (const f of [...producerFiles, ...sharedFiles]) {
  for (const k of refsIn(f)) {
    if (!producerRefs.has(k)) producerRefs.set(k, new Set());
    producerRefs.get(k)!.add(path.relative(root, f).replace(/\\/g, "/"));
  }
}
const adminRefs = new Set<string>();
for (const f of adminFiles) for (const k of refsIn(f)) adminRefs.add(k);

const scope: Entry[] = [];
let adminOnly = 0;
let unreferenced = 0;
for (const e of entries.values()) {
  const refs = producerRefs.get(e.key);
  if (refs) scope.push({ ...e, refs: [...refs].sort() });
  else if (adminRefs.has(e.key)) adminOnly += 1;
  else unreferenced += 1;
}
scope.sort((a, b) => a.file.localeCompare(b.file) || a.key.localeCompare(b.key));

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "keys.json"), JSON.stringify(scope, null, 2));
console.log(`keys total ${entries.size} · producer scope ${scope.length} · admin-only ${adminOnly} · unreferenced ${unreferenced}`);
const byFile = new Map<string, number>();
for (const e of scope) byFile.set(e.file, (byFile.get(e.file) ?? 0) + 1);
for (const [f, n] of [...byFile].sort()) console.log(`  ${f}: ${n}`);
