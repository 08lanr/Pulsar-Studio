// The clean report (2026-09-04, docs/decisions.md "subtitles, not dubbing"):
// JUST the English script — timecode, speaker, line — with a small stats
// row (lines, words, runtime). No Chinese, no rationale, no machinery; the
// deliverable a producer forwards or prints without explaining anything.

import type { Version, VersionSnapshot } from "@/lib/types";
import { docShell, esc, type DocLocale } from "./html";

function tc(ms: number | null): string {
  if (ms === null) return "";
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const L = {
  en: { episode: (n: number) => `Episode ${n}`, lines: "lines", words: "words", runtime: "runtime", state: { approved: "Final", other: "Working draft" } },
  zh: { episode: (n: number) => `第 ${n} 集`, lines: "句", words: "词", runtime: "时长", state: { approved: "定稿", other: "工作稿" } },
} as const;

export function scriptHtml(o: {
  title: { name_zh: string; name_en: string | null };
  snapshot: VersionSnapshot;
  version: Version | null;
  locale?: DocLocale;
}): string {
  const locale: DocLocale = o.locale ?? "en";
  const t = L[locale];
  const s = o.snapshot;

  // The English character names when the bible has them; the pinyin speaker otherwise.
  const nameOf = new Map(s.characters.map((c) => [c.id, c.name_en ?? c.name_zh]));

  type Row = { start_ms: number | null; speaker: string | null; text: string };
  const rows: Row[] = [];
  for (const sc of s.scenes) {
    const src = new Map(sc.lines.map((l) => [l.id, l]));
    for (const a of [...sc.adapted_lines].sort((x, y) => x.seq - y.seq)) {
      if (a.change_type === "cut" || !a.text_en) continue;
      const line = a.line_id ? src.get(a.line_id) : undefined;
      const speaker = line?.character_id ? nameOf.get(line.character_id) ?? line.speaker : line?.speaker ?? null;
      rows.push({ start_ms: a.start_ms, speaker: speaker ?? null, text: a.text_en });
    }
  }

  const words = rows.reduce((n, r) => n + r.text.split(/\s+/).filter(Boolean).length, 0);
  const last = rows.reduce<number | null>((m, r) => (r.start_ms !== null && (m === null || r.start_ms > m) ? r.start_ms : m), null);
  const runtime = s.episode.duration_ms ?? last;
  const state = o.version?.status === "approved" ? t.state.approved : t.state.other;

  const body = `
  <header>
    <h1>${esc(o.title.name_en ?? o.title.name_zh)}</h1>
    <p class="sub">${esc(t.episode(s.episode.number))} · ${esc(state)}</p>
    <p class="stats">${rows.length} ${t.lines} · ${words} ${t.words}${runtime ? ` · ${t.runtime} ${tc(runtime)}` : ""}</p>
  </header>
  <main>
    ${rows
      .map(
        (r) => `<div class="row"><time>${esc(tc(r.start_ms))}</time><div>${
          r.speaker ? `<b>${esc(r.speaker)}</b>` : ""
        }<p lang="en">${esc(r.text)}</p></div></div>`
      )
      .join("\n    ")}
  </main>
  <style>
    header { margin: 0 0 28px; }
    h1 { font-size: 26px; margin: 0 0 4px; }
    .sub { color: #5c6470; margin: 0 0 2px; }
    .stats { color: #8a919e; font-size: 13px; margin: 0; font-variant-numeric: tabular-nums; }
    .row { display: grid; grid-template-columns: 44px 1fr; gap: 14px; padding: 7px 0; }
    .row time { color: #8a919e; font-size: 12px; font-variant-numeric: tabular-nums; padding-top: 3px; }
    .row b { display: block; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: #5c6470; font-weight: 600; }
    .row p { margin: 0; font-size: 15px; line-height: 1.55; }
    @media print { .row { break-inside: avoid; } }
  </style>`;

  return docShell({ lang: locale, title: `${o.title.name_en ?? o.title.name_zh} — ${t.episode(s.episode.number)}`, body });
}
