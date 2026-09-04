// Scene segmentation: lines → studio.scenes rows.
//
// The scene is the working unit (context block, workflow stage, Approve /
// Request Changes), so a mini drama's 60–100 lines per episode need to land
// in a handful of scenes rather than one or sixty. Without a script marking
// them, the best free signal a subtitle file gives is silence: a gap of a
// few seconds between cues is almost always a cut. Explicit markers (a
// script's 第X场) are honoured when present. Segmentation is a heuristic the
// editor can re-run before any version exists (studio.guard_source_text), so
// it aims for "usually right", not perfect.

export type SceneInput = {
  seq: number;
  start_ms: number | null;
  end_ms: number | null;
  /** An explicit marker said a new scene starts at this line. */
  scene_break?: boolean;
};

export type Scene = {
  number: number;
  /** null only when the source had no timecodes at all. */
  start_ms: number | null;
  end_ms: number | null;
  from_seq: number;
  to_seq: number;
};

export type SegmentOptions = {
  /** Silence between one cue's end and the next's start that counts as a cut. */
  gapMs?: number;
  /** A scene never has fewer lines than this unless it is the last one. */
  minLines?: number;
};

export function segmentScenes(items: SceneInput[], opts: SegmentOptions = {}): Scene[] {
  const gapMs = opts.gapMs ?? 2500;
  const minLines = Math.max(1, opts.minLines ?? 2);
  const scenes: Scene[] = [];
  if (!items.length) return scenes;

  let current: SceneInput[] = [];
  let prev: SceneInput | undefined;

  const flush = () => {
    if (!current.length) return;
    const starts = current.map((c) => c.start_ms).filter((v): v is number => v !== null);
    const ends = current.map((c) => c.end_ms).filter((v): v is number => v !== null);
    scenes.push({
      number: scenes.length + 1,
      start_ms: starts.length ? Math.min(...starts) : null,
      // max, not last: overlapping cues can end out of order
      end_ms: ends.length ? Math.max(...ends) : null,
      from_seq: current[0].seq,
      to_seq: current[current.length - 1].seq,
    });
    current = [];
  };

  for (const item of items) {
    if (prev && current.length >= minLines) {
      const silence =
        prev.end_ms !== null && item.start_ms !== null ? item.start_ms - prev.end_ms : 0;
      if (item.scene_break || silence >= gapMs) flush();
    }
    current.push(item);
    prev = item;
  }
  flush();
  return scenes;
}
