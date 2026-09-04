"use client";

import { useState } from "react";
import { useT } from "@/components/locale";
import { IconChevron, IconDownload } from "@/components/icons";

// The title page's Export action: one button that opens a panel with the
// episode picker and the six formats as download links. Subtitle formats
// and the CSV are per episode; the diff is per episode; the brief and the
// package are per title (the episode picker is ignored for those). Links
// are plain hrefs so the browser's download handling does the work.

type Props = {
  titleId: string;
  episodes: { number: number; name_zh: string | null; name_en: string | null }[];
};

const PER_EPISODE = ["srt", "vtt", "csv", "diff"] as const;
const PER_TITLE = ["brief", "package"] as const;

export default function ExportMenu({ titleId, episodes }: Props) {
  const { tt } = useT();
  const [open, setOpen] = useState(false);
  const [episode, setEpisode] = useState<number>(episodes[0]?.number ?? 1);

  const href = (format: string, perEpisode: boolean) =>
    `/api/titles/${titleId}/export?format=${format}${perEpisode ? `&episode=${episode}` : ""}`;

  return (
    <div>
      <button
        type="button"
        className="btn"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        disabled={episodes.length === 0}
      >
        <IconDownload />
        {tt("admin.export.button")}
        <IconChevron dir={open ? "up" : "down"} size={12} />
      </button>
      {open && (
        <div className="group">
          <label className="field">
            <span className="label">{tt("admin.export.episode")}</span>
            <select className="select select-inline" value={episode} onChange={(e) => setEpisode(Number(e.target.value))}>
              {episodes.map((ep) => (
                <option key={ep.number} value={ep.number}>
                  {tt("admin.episode.n", { n: ep.number })}
                  {ep.name_en ? ` · ${ep.name_en}` : ep.name_zh ? ` · ${ep.name_zh}` : ""}
                </option>
              ))}
            </select>
          </label>
          <span className="label">{tt("admin.export.perEpisode")}</span>
          <div className="filter-row">
            {PER_EPISODE.map((f) => (
              <a key={f} className="btn btn-sm" href={href(f, true)}>
                {tt(`admin.export.format.${f}`)}
              </a>
            ))}
          </div>
          <span className="label">{tt("admin.export.perTitle")}</span>
          <div className="filter-row">
            {PER_TITLE.map((f) => (
              <a key={f} className="btn btn-sm" href={href(f, false)}>
                {tt(`admin.export.format.${f}`)}
              </a>
            ))}
          </div>
          <p className="hint">{tt("admin.export.sourceHint")}</p>
        </div>
      )}
    </div>
  );
}
