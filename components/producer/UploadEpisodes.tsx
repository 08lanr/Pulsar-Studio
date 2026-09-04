"use client";

// A title's add-episodes card: the shared EpisodeSlots picker (count field +
// mixed drop zone + per-episode subtitle/video slots) posting rows one by
// one to /api/titles/[id]/ingest, so a bad file never blocks the rest. The
// parser and its warnings live server-side (lib/ingest).

import { useState } from "react";
import { useRouter } from "next/navigation";
import { postForm } from "@/lib/api-client";
import { useT } from "@/components/locale";
import EpisodeSlots, { emptySlot, hasDuplicateNumbers, type EpisodeSlot } from "./EpisodeSlots";

export default function UploadEpisodes({ titleId, nextNumber }: { titleId: string; nextNumber: number }) {
  const { tt } = useT();
  const router = useRouter();
  const [slots, setSlots] = useState<EpisodeSlot[]>([emptySlot(nextNumber)]);
  const [busy, setBusy] = useState(false);

  function update(i: number, patch: Partial<EpisodeSlot>) {
    setSlots((s) => s.map((slot, j) => (j === i ? { ...slot, ...patch } : slot)));
  }

  async function uploadAll() {
    setBusy(true);
    let anyOk = false;
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if ((!slot.subtitle && !slot.video) || slot.status === "ok") continue;
      update(i, { status: "busy", message: undefined });
      const form = new FormData();
      form.set("episode_number", String(slot.number));
      if (slot.subtitle) form.set("subtitles", slot.subtitle);
      if (slot.video) form.set("video", slot.video);
      try {
        const r = await postForm<{ episode?: unknown; warnings?: string[]; error?: string }>(
          `/api/titles/${titleId}/ingest`,
          form
        );
        if (r.error) {
          update(i, { status: "error", message: r.error });
        } else {
          anyOk = true;
          update(i, { status: "ok", message: r.warnings?.length ? tt("ingest.warnings", { n: r.warnings.length }) : undefined });
        }
      } catch (e) {
        update(i, { status: "error", message: (e as Error).message });
      }
    }
    setBusy(false);
    if (anyOk) router.refresh();
  }

  const pending = slots.filter((s) => (s.subtitle || s.video) && s.status !== "ok").length;
  const blocked = hasDuplicateNumbers(slots.filter((s) => s.status !== "ok"));

  return (
    <div className="field-group">
      <div className="field-group-title">{tt("pw.upload.title2")}</div>
      <p className="hint">{tt("pw.upload.hint3")}</p>
      <EpisodeSlots slots={slots} setSlots={setSlots} startNumber={nextNumber} busy={busy} />
      <div className="pline-actions">
        <span className="spacer" />
        <button type="button" className="btn btn-sm btn-primary" disabled={busy || blocked || pending === 0} onClick={uploadAll}>
          {busy ? tt("pw.upload.uploading") : pending > 0 ? tt("pw.upload.ctaN", { n: pending }) : tt("pw.upload.cta")}
        </button>
      </div>
    </div>
  );
}
