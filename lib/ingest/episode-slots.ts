// The pure half of the episode-file picker (components/producer/EpisodeSlots.tsx):
// the row model and how a drop of mixed files is sorted into rows. Kept out
// of the component so the sorting rule has unit tests; the component owns
// the drag state and the count field.

import { guessEpisodeNumber, isPartialFile } from "./episode-number";

export const SUBTITLE_EXT = /\.(srt|vtt|ass|ssa|txt)$/i;
export const VIDEO_EXT = /\.(mp4|mov|webm)$/i;

export type EpisodeSlot = {
  number: number;
  subtitle: File | null;
  video: File | null;
  status: "idle" | "busy" | "ok" | "error";
  message?: string;
};

export function emptySlot(number: number): EpisodeSlot {
  return { number, subtitle: null, video: null, status: "idle" };
}

export function hasDuplicateNumbers(slots: EpisodeSlot[]): boolean {
  const seen = new Set<number>();
  for (const s of slots) {
    if (seen.has(s.number)) return true;
    seen.add(s.number);
  }
  return false;
}

/**
 * Sort dropped files into rows. A file that names its episode (第3集, S01E03,
 * ep03) lands on that episode and nowhere else: its row when there is one
 * that is not already uploaded, otherwise a NEW row with that number — never
 * another number's open slot (before 2026-09-22 an `ep30.mp4` dropped on a
 * fresh form landed on episode 1). A file with no number takes the first
 * open slot of its kind, then a new row from `startNumber`. A partial render
 * (`.part.mp4`) is ignored. The latest pick wins a slot it names.
 */
export function assignFiles(prev: EpisodeSlot[], list: Iterable<File>, startNumber: number): EpisodeSlot[] {
  const files = Array.from(list).filter((f) => (SUBTITLE_EXT.test(f.name) || VIDEO_EXT.test(f.name)) && !isPartialFile(f.name));
  if (!files.length) return prev;
  const slots = prev.map((s) => ({ ...s }));
  for (const file of files) {
    const kind: "subtitle" | "video" = SUBTITLE_EXT.test(file.name) ? "subtitle" : "video";
    const n = guessEpisodeNumber(file.name);
    let slot = n != null ? slots.find((s) => s.number === n && s.status !== "ok") : slots.find((s) => !s[kind] && s.status !== "ok");
    if (!slot) {
      let next = n ?? startNumber;
      if (n == null) {
        const taken = new Set(slots.map((s) => s.number));
        while (taken.has(next)) next += 1;
      }
      slot = emptySlot(next);
      slots.push(slot);
    }
    slot[kind] = file;
  }
  slots.sort((a, b) => a.number - b.number);
  return slots;
}
