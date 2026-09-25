"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

// The ⓘ beside a number or a heading (Ruobin, 2026-09-25: "the information buttons don't work"): a real button.
// A tap or click pins its explanation open, a hover shows it on a computer, and a tap elsewhere, Escape or a
// scroll closes it. The explanation floats over the page (fixed to the button), so no card or table clips it.

const WIDTH = 280;

export default function Info({ text, label }: { text: string; label: string }) {
  const [pinned, setPinned] = useState(false);
  const [hover, setHover] = useState(false);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  const open = pinned || hover;

  const place = useCallback(() => {
    const r = button.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.min(Math.max(8, r.left + r.width / 2 - WIDTH / 2), window.innerWidth - WIDTH - 8);
    setAt({ top: r.bottom + 6, left });
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    const away = (e: Event) => {
      if (button.current && !button.current.contains(e.target as Node)) {
        setPinned(false);
        setHover(false);
      }
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPinned(false);
        setHover(false);
      }
    };
    const shut = () => {
      setPinned(false);
      setHover(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    window.addEventListener("scroll", shut, true);
    window.addEventListener("resize", shut);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
      window.removeEventListener("scroll", shut, true);
      window.removeEventListener("resize", shut);
    };
  }, [open, place]);

  return (
    <>
      <button
        ref={button}
        type="button"
        className={`cdx-info${open ? " on" : ""}`}
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={(e) => {
          // Inside a link (a clickable card) the tap is the button's, never the link's.
          e.preventDefault();
          e.stopPropagation();
          setPinned((p) => !p);
        }}
        onPointerEnter={(e) => e.pointerType === "mouse" && setHover(true)}
        onPointerLeave={(e) => e.pointerType === "mouse" && setHover(false)}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
      >
        ⓘ
      </button>
      {open && at && (
        <span role="tooltip" id={id} className="cdx-info-pop" style={{ top: at.top, left: at.left, width: WIDTH }}>
          {text}
        </span>
      )}
    </>
  );
}
