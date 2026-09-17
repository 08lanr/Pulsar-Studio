"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useT } from "@/components/locale";
import LaunchSettingsEditor from "@/components/tiktok/LaunchSettingsEditor";
import type { LaunchSettings } from "@/lib/tiktok/settings";

export default function LaunchSettingsDialog({ value, onChange, budgetUsd, regionsEndpoint, onClose }: { value: LaunchSettings; onChange: (value: LaunchSettings) => void; budgetUsd: number; regionsEndpoint: string; onClose: () => void }) {
  const { tt } = useT();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key !== "Tab" || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]')];
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); prior?.focus(); };
  }, [onClose]);
  return createPortal(<div className="launch-dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><div className="launch-dialog" ref={panel} role="dialog" aria-modal="true" aria-labelledby="launch-settings-title"><header><h2 id="launch-settings-title">{tt("lv2.settings")}</h2><button type="button" className="btn btn-outline" onClick={onClose}>{tt("launchRedesign.closeSettings")}</button></header><LaunchSettingsEditor value={value} onChange={onChange} budgetUsd={budgetUsd} regionsEndpoint={regionsEndpoint} /></div></div>, document.body);
}
