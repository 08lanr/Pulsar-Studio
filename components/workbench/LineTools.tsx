// The line toolbar at the foot of the adapted column: Regenerate, Shorten,
// Rewrite with an instruction (a small field that opens inline), and the
// "n / total lines adapted" counter. Every verb is a POST rewrite with a
// different instruction; all three go dark together when the version is
// frozen or the API key is missing.

"use client";

import { useState } from "react";
import { useT } from "@/components/locale";
import { IconEdit, IconRefresh, IconSparkle } from "./icons";

export function LineTools({
  aiAvailable,
  frozen,
  hasLine,
  busy,
  adaptedCount,
  totalLines,
  onRewrite,
}: {
  aiAvailable: boolean;
  frozen: boolean;
  hasLine: boolean;
  busy: boolean;
  adaptedCount: number;
  totalLines: number;
  onRewrite: (instruction: string) => void;
}) {
  const { tt } = useT();
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const off = !hasLine || frozen || busy || !aiAvailable;
  const why = frozen ? tt("wb.frozen.hint") : !aiAvailable ? tt("wb.ai.unavailable.hint") : undefined;

  function submit() {
    const text = instruction.trim();
    if (!text) return;
    onRewrite(text);
    setInstruction("");
    setOpen(false);
  }

  return (
    <>
      {open && !off && (
        <div className="line-tools">
          <label className="field">
            <span className="sr-only">{tt("wb.tools.instruction")}</span>
            <input
              className="input"
              value={instruction}
              placeholder={tt("wb.tools.instruction.ph")}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
                if (e.key === "Escape") setOpen(false);
              }}
              autoFocus
            />
          </label>
          <button type="button" className="btn btn-primary btn-sm" onClick={submit} disabled={!instruction.trim()}>
            {tt("wb.tools.apply")}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>
            {tt("wb.tools.cancel")}
          </button>
        </div>
      )}
      <div className="line-tools">
        <button type="button" className="btn btn-ghost btn-sm" disabled={off} title={why} onClick={() => onRewrite("regenerate")}>
          {busy ? <span className="spinner" /> : <IconRefresh />}
          {tt("wb.tools.regenerate")}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={off} title={why} onClick={() => onRewrite("shorten")}>
          <IconEdit />
          {tt("wb.tools.shorten")}
        </button>
        <span className="vsep" />
        <button type="button" className="btn btn-ghost btn-sm" disabled={off} title={why} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <IconSparkle />
          {tt("wb.tools.rewrite")}
        </button>
        <span className="line-tools-count">
          <b>{adaptedCount}</b> / {tt("wb.tools.count", { total: totalLines })}
        </span>
      </div>
    </>
  );
}
