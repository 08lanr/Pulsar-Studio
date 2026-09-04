import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const keyDir = path.join(root, "locales", "_keys");
const files = fs.readdirSync(keyDir).filter((name) => name.endsWith(".json")).sort();
const additions = { en: {}, zh: {} };

for (const name of files) {
  const entries = JSON.parse(fs.readFileSync(path.join(keyDir, name), "utf8"));
  for (const [key, value] of Object.entries(entries)) {
    additions.en[key] = value.en;
    additions.zh[key] = value.zh;
  }
}

for (const locale of ["en", "zh"]) {
  const target = path.join(root, "locales", `${locale}.json`);
  const base = JSON.parse(fs.readFileSync(target, "utf8"));
  fs.writeFileSync(target, `${JSON.stringify({ ...base, ...additions[locale] }, null, 2)}\n`);
}
