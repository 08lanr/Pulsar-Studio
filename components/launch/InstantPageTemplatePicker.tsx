"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useT } from "@/components/locale";
import { call } from "@/components/tiktok/api";
import { SALES_MASTER_SHA256, SALES_MASTER_VERSION } from "@/lib/tiktok/instant-page-master";
import type { LaunchSettings } from "@/lib/tiktok/settings";
import type { InstantPageTemplate } from "@/lib/types";

const DEFAULT_ID = "00000000-0000-4000-8000-000000000001";
type Design = NonNullable<LaunchSettings["instant_page_template"]>;

export default function InstantPageTemplatePicker({ value, onChange }: { value: Design | undefined; onChange: (value: Design) => void }) {
  const { tt } = useT();
  const templateSelectId = useId();
  const staff = usePathname().startsWith("/promote");
  const [templates, setTemplates] = useState<InstantPageTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    try {
      const result = await call<{ templates: InstantPageTemplate[] }>("/api/producer/tiktok/instant-page-templates");
      if (id === requestId.current) { setTemplates(result.templates); setError(""); }
    } catch (e) {
      if (id === requestId.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const requests = requestId;
    void refresh();
    const onFocus = () => { void refresh(); };
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      requests.current++;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);
  const selectedSaved = templates.some(t => t.id === value?.id);
  const selectedId = value?.id === DEFAULT_ID || selectedSaved ? value?.id : value ? "__snapshot__" : "";
  function choose(id: string) {
    if (id === DEFAULT_ID) return onChange({ id: DEFAULT_ID, name: "(default)", button_text: "Watch now", background: "white", hand_cursor: false, master_version: SALES_MASTER_VERSION, master_sha256: SALES_MASTER_SHA256 });
    const template = templates.find(t => t.id === id);
    if (template) onChange({ id: template.id, name: template.name, button_text: template.button_text, background: template.background, hand_cursor: template.hand_cursor, master_version: SALES_MASTER_VERSION, master_sha256: SALES_MASTER_SHA256 });
  }
  return <div className="tk-field launch-page-picker"><div className="launch-page-picker-controls"><label className="tk-label launch-page-picker-select" htmlFor={templateSelectId}>{tt("salesLaunch.pageTemplate")}<select id={templateSelectId} className="select" value={selectedId} onFocus={() => void refresh()} onChange={e => choose(e.target.value)}><option value="" disabled>{tt("salesLaunch.chooseTemplate")}</option><option value={DEFAULT_ID}>{tt("salesLaunch.defaultTemplate")}</option>{value && selectedId === "__snapshot__" && <option value="__snapshot__">{value.name} {tt("salesLaunch.savedSnapshot")}</option>}{templates.map(t => <option value={t.id} key={t.id}>{t.name}</option>)}</select></label><button type="button" className="btn btn-outline btn-sm" disabled={loading} onClick={() => void refresh()}>{loading ? tt("common.loading") : tt("tk.refresh")}</button>{staff && <Link href="/tiktok/templates?tab=pages" target="_blank" rel="noopener noreferrer">{tt("salesLaunch.manageTemplates")}&nbsp;↗</Link>}</div>{error && <span className="note note-warn" role="alert">{error}</span>}<span className="hint">{tt("salesLaunch.pageTemplateHelp")}</span></div>;
}
