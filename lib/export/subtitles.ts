// Adapted English as a subtitle file, on the source timecodes. Both formats
// walk the same cue list: cut lines and untimed lines produce no cue (SRT has
// no way to say "no time"; the route refuses untimed episodes before it gets
// here), and a line that merged its neighbours takes the union of the
// absorbed source spans when the source lines are supplied, so the merged
// English stays on screen for as long as the Chinese it replaced did.
// Cues are renumbered 1..n after skipping so players never see a gap.

import { srtTime, vttTime } from "./time";

/** What a cue needs; SnapshotAdaptedLine and AdaptedLine both satisfy it. */
export type SubtitleLine = {
  start_ms: number | null;
  end_ms: number | null;
  text_en: string | null;
  change_type?: string;
  /** uuids of absorbed source lines (snapshot shape). */
  merges?: string[];
};

/** Source lines, used only to widen merged cues; SnapshotLine and Line both satisfy it. */
export type SubtitleSource = { id: string; start_ms: number | null; end_ms: number | null };

export type Cue = { start_ms: number; end_ms: number; text: string };

/** The cue list both writers share; exported for tests. */
export function toCues(lines: SubtitleLine[], sources: SubtitleSource[] = []): Cue[] {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const cues: Cue[] = [];
  for (const l of lines) {
    const text = (l.text_en ?? "").trim();
    if (!text || l.change_type === "cut") continue;
    let start = l.start_ms;
    let end = l.end_ms;
    for (const id of l.merges ?? []) {
      const m = byId.get(id);
      if (!m) continue;
      if (m.start_ms !== null && (start === null || m.start_ms < start)) start = m.start_ms;
      if (m.end_ms !== null && (end === null || m.end_ms > end)) end = m.end_ms;
    }
    if (start === null || end === null) continue;
    if (end <= start) end = start + 1000; // a zero-length cue never displays
    cues.push({ start_ms: start, end_ms: end, text: text.replace(/\r\n?/g, "\n") });
  }
  return cues.sort((a, b) => a.start_ms - b.start_ms);
}

/** SubRip: blank-line separated cues, LF line ends, trailing newline. */
export function toSrt(lines: SubtitleLine[], sources: SubtitleSource[] = []): string {
  return toCues(lines, sources)
    .map((c, i) => `${i + 1}\n${srtTime(c.start_ms)} --> ${srtTime(c.end_ms)}\n${c.text}\n`)
    .join("\n");
}

/** WebVTT: header, an optional NOTE block (provenance), numbered cues. */
export function toVtt(lines: SubtitleLine[], sources: SubtitleSource[] = [], note?: string): string {
  const head = ["WEBVTT", ""];
  // A NOTE may not contain "-->" or a blank line, or the parser reads it as a cue.
  if (note) head.push(`NOTE ${note.replace(/-->/g, "-- >").replace(/\n\s*\n/g, "\n")}`, "");
  const body = toCues(lines, sources).map(
    (c, i) => `${i + 1}\n${vttTime(c.start_ms)} --> ${vttTime(c.end_ms)}\n${c.text}\n`,
  );
  return head.join("\n") + "\n" + body.join("\n");
}
