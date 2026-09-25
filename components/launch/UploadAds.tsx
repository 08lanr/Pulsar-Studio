"use client";

// Upload finished ads (decision 2026-09-24, widened 2026-09-25). The cutter
// re-cuts a 20-30 s window out of an episode video; an ad that is already
// graded needs its own file used as delivered. Several at once, each with its
// own ad text, because a round is a handful of creatives for one drama.
//
// It sits in the Ads desk beside the 60-second ad, not on an episode: a clip
// row needs an episode (studio.clips.episode_id is NOT NULL, and
// core.derive_title_id reads the title through it), but a finished ad is not a
// window of one, so the server files it under the title's first episode and no
// episode is shown for it anywhere (clipLibrary, lib/clips/payload.ts).

import { useRef, useState } from "react";
import { postForm, describeError, type ApiErrorBody } from "@/lib/api-client";
import { useT } from "@/components/locale";
import type { LaunchTitleOption } from "@/lib/launch/types";

type Props = {
  titles: LaunchTitleOption[];
  /** Fixed on a title's own page; chosen here otherwise. */
  titleId?: string;
  onUploaded: () => void;
};
type Row = { file: File; hook: string; state: "queued" | "sending" | "done" | "failed"; error?: string };

export default function UploadAds({ titles, titleId, onUploaded }: Props) {
  const { tt } = useT();
  const input = useRef<HTMLInputElement>(null);
  const [chosen, setChosen] = useState(titleId ?? "");
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);

  const target = titleId ?? chosen;
  const pending = rows.filter((r) => r.state !== "done");

  async function sendAll() {
    if (!target) return;
    setBusy(true);
    // Sequential on purpose: ranks are handed out by scanning for a free one,
    // which is not safe to race, and a failure should name its own file.
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].state === "done") continue;
      setRows((r) => r.map((x, j) => (j === i ? { ...x, state: "sending", error: undefined } : x)));
      try {
        const form = new FormData();
        form.set("video", rows[i].file);
        if (rows[i].hook.trim()) form.set("hook", rows[i].hook.trim());
        // postForm resolves for ANY status — it throws only on a network
        // error — so the envelope is what says whether this was refused.
        const body = await postForm<{ clip?: unknown; error?: string }>(`/api/titles/${target}/clips/upload`, form);
        const ok = Boolean(body?.clip);
        setRows((r) => r.map((x, j) => (j === i
          ? { ...x, state: ok ? "done" : "failed", error: ok ? undefined : describeError(body as ApiErrorBody) }
          : x)));
      } catch (e) {
        setRows((r) => r.map((x, j) => (j === i ? { ...x, state: "failed", error: (e as Error).message } : x)));
      }
    }
    setBusy(false);
    if (input.current) input.current.value = "";
    onUploaded();
  }

  return (
    <div className="upload-ads">
      <div className="upload-ads-head">
        {!titleId && (
          <label className="upload-ads-title">
            <span>{tt("uc.title")}</span>
            <select className="select" value={chosen} disabled={busy} onChange={(e) => setChosen(e.target.value)}>
              <option value="">{tt("uc.chooseTitle")}</option>
              {titles.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
        )}
        <label className="upload-ads-file">
          <span>{tt("uc.file")}</span>
          <input
            ref={input}
            type="file"
            accept="video/*"
            multiple
            disabled={busy}
            onChange={(e) => setRows(Array.from(e.target.files ?? []).map((file) => ({ file, hook: "", state: "queued" as const })))}
          />
        </label>
        {pending.length > 0 && (
          <button type="button" className="btn btn-primary btn-sm" disabled={busy || !target} onClick={sendAll}>
            {busy ? tt("uc.busy") : tt("uc.ctaN", { n: pending.length })}
          </button>
        )}
      </div>

      {rows.length > 0 && (
        <ul className="upload-ads-list">
          {rows.map((r, i) => (
            <li key={`${r.file.name}-${i}`} className={`upload-ads-row is-${r.state}`}>
              <span className="upload-ads-name" title={r.file.name}>{r.file.name}</span>
              <input
                className="input"
                type="text"
                maxLength={100}
                value={r.hook}
                disabled={busy || r.state === "done"}
                placeholder={tt("uc.hookHint")}
                aria-label={tt("uc.hook")}
                onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, hook: e.target.value } : x)))}
              />
              <span className="upload-ads-state">{tt(`uc.state.${r.state}`)}</span>
              {r.error && <span className="err upload-ads-err">{r.error}</span>}
            </li>
          ))}
        </ul>
      )}

      <p className="hint">{tt("uc.hint")}</p>
    </div>
  );
}
