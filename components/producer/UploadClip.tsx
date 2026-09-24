"use client";

// Upload a finished ad as a clip (decision 2026-09-24). The cutter re-cuts a
// 20-30 s window from an episode video; a partner who already has a graded ad
// needs the file used as delivered. The bytes go up untouched and the clip is
// launchable immediately.

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { postForm, describeError, type ApiErrorBody } from "@/lib/api-client";
import { useT } from "@/components/locale";

type Props = { titleId: string; episodeNumber: number };

export default function UploadClip({ titleId, episodeNumber }: Props) {
  const { tt } = useT();
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [hook, setHook] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    const file = input.current?.files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("video", file);
      if (hook.trim()) form.set("hook", hook.trim());
      // postForm resolves for ANY status (lib/api-client.ts) — it throws only
      // on a network failure — so the envelope is what says whether the
      // upload was refused. Without this check a 400/403/404 clears the form
      // and reads as success.
      const body = await postForm<{ clip?: unknown; error?: string; detail?: unknown }>(
        `/api/titles/${titleId}/episodes/${episodeNumber}/clips/upload`,
        form
      );
      if (!body?.clip) {
        setError(describeError(body as ApiErrorBody));
        return;
      }
      if (input.current) input.current.value = "";
      setHook("");
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ep-upload-clip">
      <label className="ep-upload-clip-file">
        <span>{tt("uc.file")}</span>
        <input ref={input} type="file" accept="video/*" disabled={busy} />
      </label>
      <label className="ep-upload-clip-hook">
        <span>{tt("uc.hook")}</span>
        <input
          className="input"
          type="text"
          maxLength={100}
          value={hook}
          disabled={busy}
          placeholder={tt("uc.hookHint")}
          onChange={(e) => setHook(e.target.value)}
        />
      </label>
      <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={send}>
        {busy ? tt("uc.busy") : tt("uc.cta")}
      </button>
      <p className="hint ep-upload-clip-hint">{tt("uc.hint")}</p>
      {error && <p className="err">{error}</p>}
    </div>
  );
}
