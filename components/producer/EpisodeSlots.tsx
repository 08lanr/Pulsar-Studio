"use client";

// The shared episode-file picker (new-title flow AND a title's add-episodes
// card). Built after the founder's "what am I supposed to upload?" feedback:
//
//   · A count field lays out one explicit row per episode, each with two
//     labeled slots — subtitles (REQUIRED) and video (optional) — so the
//     expectation is visible before any file is touched.
//   · One drop zone takes everything at once, subtitles and videos mixed,
//     and sorts files into episodes by filename (第1集.srt + 第1集.mp4 land
//     on the same row; see lib/ingest/episode-number).
//   · Files can also be dragged onto a SPECIFIC row: they land on that
//     episode regardless of filename, routed to the right slot by extension.
//   · A row holding only a video is flagged (subtitles are what we adapt);
//     parents block submit on that and on duplicate numbers.

import { useState, type Dispatch, type SetStateAction } from "react";
import { guessEpisodeNumber } from "@/lib/ingest/episode-number";
import { useT } from "@/components/locale";
import { IconCheck } from "./icons";

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

/** A row that can never upload: a video with no subtitles to burn into it. */
export function hasVideoOnlyRow(slots: EpisodeSlot[]): boolean {
  return slots.some((s) => s.video && !s.subtitle && s.status !== "ok");
}

/** Sort dropped files into slots: by filename number first, then the first
 * open slot of that kind, then a new row. Latest pick wins a filled slot. */
function assignFiles(prev: EpisodeSlot[], list: FileList | File[], startNumber: number): EpisodeSlot[] {
  const files = Array.from(list).filter((f) => SUBTITLE_EXT.test(f.name) || VIDEO_EXT.test(f.name));
  if (!files.length) return prev;
  const slots = prev.map((s) => ({ ...s }));
  for (const file of files) {
    const kind: "subtitle" | "video" = SUBTITLE_EXT.test(file.name) ? "subtitle" : "video";
    const n = guessEpisodeNumber(file.name);
    let slot = n != null ? slots.find((s) => s.number === n && s.status !== "ok") : undefined;
    if (!slot) slot = slots.find((s) => !s[kind] && s.status !== "ok");
    if (!slot) {
      const taken = new Set(slots.map((s) => s.number));
      let next = n != null && !taken.has(n) ? n : startNumber;
      while (taken.has(next)) next += 1;
      slot = emptySlot(next);
      slots.push(slot);
    }
    slot[kind] = file;
  }
  slots.sort((a, b) => a.number - b.number);
  return slots;
}

type Props = {
  slots: EpisodeSlot[];
  setSlots: Dispatch<SetStateAction<EpisodeSlot[]>>;
  /** First episode number for new rows (1 on a new title; next free on an existing one). */
  startNumber: number;
  busy: boolean;
};

export default function EpisodeSlots({ slots, setSlots, startNumber, busy }: Props) {
  const { tt } = useT();
  const [dragging, setDragging] = useState(false);
  const [rowDrag, setRowDrag] = useState<number | null>(null);

  function applyCount(raw: number) {
    const n = Math.max(0, Math.min(200, Math.floor(raw) || 0));
    setSlots((prev) => {
      if (n <= prev.length) return prev.slice(0, n);
      const next = [...prev];
      const taken = new Set(prev.map((s) => s.number));
      let cursor = startNumber;
      while (next.length < n) {
        while (taken.has(cursor)) cursor += 1;
        taken.add(cursor);
        next.push(emptySlot(cursor));
      }
      return next;
    });
  }

  function update(i: number, patch: Partial<EpisodeSlot>) {
    setSlots((s) => s.map((slot, j) => (j === i ? { ...slot, ...patch } : slot)));
  }

  /** Files dropped on one row land on that episode, whatever their names say. */
  function dropOnRow(i: number, list: FileList) {
    const patch: Partial<EpisodeSlot> = {};
    for (const file of Array.from(list)) {
      if (SUBTITLE_EXT.test(file.name)) patch.subtitle = file;
      else if (VIDEO_EXT.test(file.name)) patch.video = file;
    }
    if (Object.keys(patch).length) update(i, patch);
  }

  return (
    <>
      <div className="bulk-count">
        <label className="label" htmlFor="ep-count">
          {tt("pw.slots.count")}
        </label>
        <input
          id="ep-count"
          className="input bulk-num"
          type="number"
          min={0}
          max={200}
          value={slots.length}
          disabled={busy}
          onChange={(e) => applyCount(Number(e.target.value))}
        />
      </div>

      <label
        className={`bulk-drop ${dragging ? "is-dragging" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          setSlots((prev) => assignFiles(prev, e.dataTransfer.files, startNumber));
        }}
      >
        <input
          type="file"
          multiple
          hidden
          accept=".srt,.vtt,.ass,.ssa,.txt,video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm"
          disabled={busy}
          onChange={(e) => {
            const files = e.target.files;
            if (files) setSlots((prev) => assignFiles(prev, files, startNumber));
            e.target.value = "";
          }}
        />
        <strong>{tt("pw.upload.pick")}</strong>
        <span>{tt("pw.upload.pickHint")}</span>
      </label>

      {slots.length > 0 && (
        <div className="bulk-rows">
          {slots.map((slot, i) => {
            const dupe = slots.some((x, j) => j !== i && x.number === slot.number) && slot.status !== "ok";
            const videoOnly = !!slot.video && !slot.subtitle && slot.status !== "ok";
            const locked = slot.status === "ok" || busy;
            return (
              <div
                className={`bulk-row ${slot.status === "ok" ? "is-ok" : ""} ${dupe ? "is-dupe" : ""} ${rowDrag === i ? "is-dragover" : ""}`}
                key={`${slot.number}:${i}`}
                onDragOver={(e) => {
                  if (locked) return;
                  e.preventDefault();
                  e.stopPropagation();
                  setRowDrag(i);
                }}
                onDragLeave={() => setRowDrag((d) => (d === i ? null : d))}
                onDrop={(e) => {
                  if (locked) return;
                  e.preventDefault();
                  e.stopPropagation();
                  setRowDrag(null);
                  dropOnRow(i, e.dataTransfer.files);
                }}
              >
                <span className="bulk-eplabel">{tt("pw.slots.ep")}</span>
                <input
                  className="input bulk-num"
                  type="number"
                  min={1}
                  value={slot.number}
                  disabled={locked}
                  aria-label={tt("pw.upload.episodeN")}
                  onChange={(e) => update(i, { number: Number(e.target.value) })}
                />
                <span className="bulk-eplabel">{tt("pw.slots.epSuffix")}</span>
                <label className={`bulk-slot ${slot.subtitle ? "is-filled" : videoOnly ? "is-missing" : "is-empty"}`}>
                  {slot.subtitle ? slot.subtitle.name : tt("pw.slots.sub")}
                  <input
                    type="file"
                    hidden
                    accept=".srt,.vtt,.ass,.ssa,.txt"
                    disabled={locked}
                    onChange={(e) => update(i, { subtitle: e.target.files?.[0] ?? null })}
                  />
                </label>
                <label className={`bulk-slot ${slot.video ? "is-filled" : "is-empty"}`}>
                  {slot.video ? slot.video.name : tt("pw.upload.video")}
                  <input
                    type="file"
                    hidden
                    accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm"
                    disabled={locked}
                    onChange={(e) => update(i, { video: e.target.files?.[0] ?? null })}
                  />
                </label>
                {slot.status === "busy" && <span className="spinner" />}
                {slot.status === "ok" && (
                  <span className="bulk-ok">
                    <IconCheck size={14} /> {tt("pw.upload.done")}
                    {slot.message ? ` · ${slot.message}` : ""}
                  </span>
                )}
                {slot.status === "error" && <span className="err">{slot.message}</span>}
                {dupe && <span className="err">{tt("pw.upload.dupe")}</span>}
                {videoOnly && <span className="err">{tt("pw.slots.missingSub")}</span>}
                {!locked && (
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => setSlots((s) => s.filter((_, j) => j !== i))}
                  >
                    {tt("pw.upload.remove")}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
