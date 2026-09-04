// Bulk upload names its own episodes: read the episode number out of a
// subtitle filename so a producer can drop a whole season at once. Patterns
// in confidence order — 第N集, S01E02, EP01 — then the last bare number in
// the name as a guess. Returns null when nothing usable is found; the
// caller falls back to sequential numbering and the field stays editable.

export function guessEpisodeNumber(filename: string): number | null {
  const base = filename.replace(/\.[^.]+$/, "");

  const zh = base.match(/第\s*(\d{1,4})\s*[集话回]/);
  if (zh) return clamp(zh[1]);

  const se = base.match(/[Ss]\d{1,3}\s*[Ee](\d{1,4})/);
  if (se) return clamp(se[1]);

  const ep = base.match(/(?:^|[^a-z])(?:ep(?:isode)?|e)[\s._-]*(\d{1,4})/i);
  if (ep) return clamp(ep[1]);

  const nums = base.match(/\d{1,4}/g);
  if (nums?.length) {
    // Skip anything that reads as a year (2026-09-04 exports, 1080p rips).
    const plausible = nums.map(Number).filter((n) => n >= 1 && n <= 999 && n !== 720 && n !== 480);
    if (plausible.length) return plausible[plausible.length - 1];
  }
  return null;
}

function clamp(digits: string): number | null {
  const n = Number(digits);
  return n >= 1 && n <= 9999 ? n : null;
}
