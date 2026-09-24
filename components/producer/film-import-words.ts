// The words of a workspace film and its import, shared by Import films
// (FilmImport.tsx) and the CrazyDramas hub (crazydramas/Hub.tsx): why a film
// is not ready, a running import's line, a settled import's counts, and which
// films fold into "Not ready (n)". Pure, no styles, so the tests import it.

import type { FilmRow, ImportProgress } from "@/lib/film-import/import";
import type { ScanReason } from "@/lib/film-import/types";

function running(p: ImportProgress | null | undefined): boolean {
  return !!p && p.step !== "done" && p.step !== "failed";
}

export type Tt = (k: string, v?: Record<string, string | number>) => string;

/** Why a film is not ready (or what changed), in words; null when there is nothing to say. Shared with the CrazyDramas hub. */
export function filmReasonText(tt: Tt, r: ScanReason | null | undefined): string | null {
  if (!r) return null;
  switch (r.code) {
    case "bad_delivered":
      return tt("fi.reason.bad_delivered", { file: r.file, detail: r.detail });
    case "part_file":
      return tt("fi.reason.part_file", { file: r.file });
    case "recent_write":
      return tt("fi.reason.recent_write", { file: r.file, seconds: r.seconds_ago });
    case "episode_gap":
      return tt("fi.reason.episode_gap", { missing: r.missing.join(", ") || "—" });
    case "count_mismatch":
      return tt("fi.reason.count_mismatch", { planned: r.planned, found: r.found });
    case "placeholder":
      return tt("fi.reason.placeholder", { file: r.file });
    case "files_changed":
      return tt("fi.reason.files_changed", { n: r.episodes.length, episodes: r.episodes.join(", ") });
    default:
      return tt(`fi.reason.${r.code}`);
  }
}

/** A running import's line ("Episode 2 of 3: hashing"); empty once it settled. Shared with the CrazyDramas hub. */
export function importProgressText(tt: Tt, p: ImportProgress): string {
  switch (p.step) {
    case "episodes":
      return tt("fi.progress.episodes", { n: p.episode ?? 0, total: p.total, what: tt(`fi.progress.what.${p.what ?? "link"}`) });
    case "transcripts":
      return tt("fi.progress.transcripts", { n: p.episode ?? 0, total: p.total });
    case "done":
    case "failed":
      return "";
    default:
      return tt(`fi.progress.${p.step}`);
  }
}

/** A settled import's counts, or its failure; null while it runs. Shared with the CrazyDramas hub. */
export function importResultText(tt: Tt, p: ImportProgress): { text: string; error: boolean } | null {
  if (p.step === "failed") return { text: tt("fi.result.failed", { detail: p.error ?? "" }), error: true };
  if (p.step === "done" && p.result) {
    const c = p.result.counts;
    const parts = [tt("fi.result.done", { added: c.added, updated: c.updated, unchanged: c.unchanged, flagged: c.flagged })];
    if (c.transcripts) parts.push(tt("fi.result.transcripts", { n: c.transcripts }));
    if (p.result.changed_during_import) parts.push(tt("fi.result.changed"));
    return { text: parts.join(" "), error: false };
  }
  return null;
}

/** Films that cannot be imported yet fold into one "Not ready (n)" line (a render in progress, not delivered, a narrated work folder); an imported film or a running import always keeps its row. */
export function isNotReady(film: Pick<FilmRow, "state" | "imported" | "progress">): boolean {
  if (film.imported || running(film.progress)) return false;
  return film.state === "RENDERING" || film.state === "NOT_DELIVERED" || film.state === "NO_MANIFEST";
}

