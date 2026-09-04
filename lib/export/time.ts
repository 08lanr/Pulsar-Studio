// Timecode formatting shared by every export. SRT and VTT differ by one
// character (comma vs dot before the milliseconds), and the printed documents
// want the shorter m:ss form; keeping all three here means an off-by-one in
// rounding shows up in one place.

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

type Parts = { h: number; m: number; s: number; ms: number };

function split(totalMs: number): Parts {
  const t = Math.max(0, Math.round(totalMs));
  const ms = t % 1000;
  const total = (t - ms) / 1000;
  return { h: Math.floor(total / 3600), m: Math.floor((total % 3600) / 60), s: total % 60, ms };
}

/** hh:mm:ss,mmm (SubRip). */
export function srtTime(ms: number): string {
  const p = split(ms);
  return `${pad(p.h, 2)}:${pad(p.m, 2)}:${pad(p.s, 2)},${pad(p.ms, 3)}`;
}

/** hh:mm:ss.mmm (WebVTT). */
export function vttTime(ms: number): string {
  const p = split(ms);
  return `${pad(p.h, 2)}:${pad(p.m, 2)}:${pad(p.s, 2)}.${pad(p.ms, 3)}`;
}

/** m:ss (or h:mm:ss past the hour) for documents and CSV; "" for an untimed value. */
export function clockTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "";
  const p = split(ms);
  return p.h > 0 ? `${p.h}:${pad(p.m, 2)}:${pad(p.s, 2)}` : `${p.m}:${pad(p.s, 2)}`;
}

/** "0:23–0:41" style range for documents; one side alone when the other is untimed. */
export function clockRange(start: number | null | undefined, end: number | null | undefined): string {
  const a = clockTime(start);
  const b = clockTime(end);
  return a && b ? `${a}–${b}` : a || b;
}
