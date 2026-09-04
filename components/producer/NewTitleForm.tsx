"use client";

// 新建剧集 for the producer: the platform-console pattern they know — fill in
// the work's info, lay out the episodes with the shared EpisodeSlots picker
// (count field + mixed subtitle/video drop zone), one button. POSTs
// /api/titles (producer_id is forced server-side to their own company), then
// hands off to the same ingest route the add-episodes card uses.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { postForm, postJson } from "@/lib/api-client";
import { unwrap, type ApiEnvelope } from "@/components/workbench/util";
import { useT } from "@/components/locale";
import type { Title } from "@/lib/types";
import EpisodeSlots, { emptySlot, hasDuplicateNumbers, type EpisodeSlot } from "./EpisodeSlots";

export default function NewTitleForm() {
  const { tt } = useT();
  const router = useRouter();
  const [nameZh, setNameZh] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [genre, setGenre] = useState("");
  const [synopsis, setSynopsis] = useState("");
  const [notes, setNotes] = useState("");
  const [slots, setSlots] = useState<EpisodeSlot[]>([emptySlot(1)]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const blocked = hasDuplicateNumbers(slots);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!nameZh.trim() || blocked) return;
    setBusy(true);
    setError(null);
    try {
      setProgress(tt("pw.new.creating"));
      const created = unwrap(
        await postJson<{ title?: Title } & ApiEnvelope>("/api/titles", {
          name_zh: nameZh.trim(),
          name_en: nameEn.trim() || null,
          genre: genre.trim() || null,
          synopsis_zh: synopsis.trim() || null,
          character_notes: notes.trim() || null,
        })
      );
      const title = created.title!;
      for (const slot of slots) {
        if (!slot.subtitle && !slot.video) continue;
        setProgress(tt("pw.new.uploadingEp", { n: slot.number }));
        const form = new FormData();
        form.set("episode_number", String(slot.number));
        if (slot.subtitle) form.set("subtitles", slot.subtitle);
        if (slot.video) form.set("video", slot.video);
        const r = await postForm<ApiEnvelope>(`/api/titles/${title.id}/ingest`, form);
        if (r.error) throw new Error(`${tt("pw.upload.episodeN")} ${slot.number}: ${r.error}`);
      }
      router.push(`/producer/titles/${title.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <div className="field-group">
        <div className="field-group-title">{tt("pw.new.info")}</div>
        <div className="field field-key">
          <label className="label">{tt("pw.new.nameZh")}</label>
          <input className="input bilingual" lang="zh-CN" value={nameZh} required onChange={(e) => setNameZh(e.target.value)} />
        </div>
        <div className="field-row">
          <div className="field">
            <label className="label">{tt("pw.new.nameEn")}</label>
            <input className="input bilingual" lang="en" value={nameEn} onChange={(e) => setNameEn(e.target.value)} />
          </div>
          <div className="field">
            <label className="label">{tt("pw.new.genre")}</label>
            <input className="input" value={genre} placeholder={tt("pw.new.genreHint")} onChange={(e) => setGenre(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label className="label">{tt("pw.new.synopsis")}</label>
          <textarea className="textarea bilingual" lang="zh-CN" rows={3} value={synopsis} onChange={(e) => setSynopsis(e.target.value)} />
        </div>
        <div className="field">
          <label className="label">{tt("pw.new.notes")}</label>
          <textarea
            className="textarea bilingual"
            lang="zh-CN"
            rows={3}
            value={notes}
            placeholder={tt("pw.new.notesHint")}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
      </div>

      <div className="field-group">
        <div className="field-group-title">{tt("pw.upload.title2")}</div>
        <p className="hint">{tt("pw.upload.hint3")}</p>
        <EpisodeSlots slots={slots} setSlots={setSlots} startNumber={1} busy={busy} />
      </div>

      {error && <p className="err">{error}</p>}
      <div className="pline-actions">
        <span className="sticky-bar-note">{progress}</span>
        <span className="spacer" />
        <button className="btn btn-primary" disabled={busy || !nameZh.trim() || blocked}>
          {busy ? tt("common.loading") : tt("pw.new.cta")}
        </button>
      </div>
    </form>
  );
}
