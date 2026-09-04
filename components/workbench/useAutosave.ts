// Debounced autosave for the adapted-line textarea. The editor types, the
// text goes to PATCH 600ms after the last keystroke, and the header shows
// "Saving… / All changes saved". Switching lines flushes the pending edit
// first so a fast j/k never loses a sentence, and a save that comes back
// after the user has typed again does not clobber the newer text.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type SaveState = "saved" | "saving" | "error";

export type AutosaveOptions = {
  /** The row being edited; a change resets the buffer to `initial`. */
  id: string;
  initial: string;
  save: (id: string, text: string) => Promise<void>;
  delay?: number;
  /** Lifts the state to whoever renders the indicator. */
  onState?: (s: SaveState) => void;
  disabled?: boolean;
};

export function useAutosave(o: AutosaveOptions) {
  const [value, setValueState] = useState(o.initial);
  const [state, setState] = useState<SaveState>("saved");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ id: string; text: string } | null>(null);
  const lastSaved = useRef<{ id: string; text: string }>({ id: o.id, text: o.initial });
  const saveRef = useRef(o.save);
  saveRef.current = o.save;
  const onStateRef = useRef(o.onState);
  onStateRef.current = o.onState;

  const report = useCallback((s: SaveState) => {
    setState(s);
    onStateRef.current?.(s);
  }, []);

  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const p = pending.current;
    pending.current = null;
    if (!p || (p.id === lastSaved.current.id && p.text === lastSaved.current.text)) return;
    report("saving");
    try {
      await saveRef.current(p.id, p.text);
      lastSaved.current = p;
      // Only report saved when nothing newer is waiting.
      if (!pending.current) report("saved");
    } catch {
      report("error");
    }
  }, [report]);

  // A new line: flush what the previous one had, then show its text.
  const idRef = useRef(o.id);
  useEffect(() => {
    if (idRef.current !== o.id) {
      void flush();
      idRef.current = o.id;
      lastSaved.current = { id: o.id, text: o.initial };
      setValueState(o.initial);
      return;
    }
    // Same line, but the row changed underneath (a rewrite, a chosen
    // alternative): adopt the server text unless an edit is in flight.
    if (!pending.current && o.initial !== lastSaved.current.text) {
      lastSaved.current = { id: o.id, text: o.initial };
      setValueState(o.initial);
    }
  }, [o.id, o.initial, flush]);

  const setValue = useCallback(
    (text: string) => {
      setValueState(text);
      if (o.disabled) return;
      pending.current = { id: o.id, text };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), o.delay ?? 600);
    },
    [o.id, o.delay, o.disabled, flush]
  );

  // Unmount: fire whatever is left rather than drop it.
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
      const p = pending.current;
      pending.current = null;
      if (p && p.text !== lastSaved.current.text) void saveRef.current(p.id, p.text);
    };
  }, []);

  return { value, setValue, state, flush };
}
