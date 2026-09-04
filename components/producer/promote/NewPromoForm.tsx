"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { postJson } from "@/lib/api-client";
import { unwrap, type ApiEnvelope } from "@/components/workbench/util";
import { useT } from "@/components/locale";
import type { PromoCampaign } from "@/lib/types";

type TitleChoice = { id: string; name: string; episodeCount: number; hasVideo: boolean };

export default function NewPromoForm({ titles, initialTitleId, readOnly = false }: { titles: TitleChoice[]; initialTitleId?: string; readOnly?: boolean }) {
  const { tt } = useT();
  const router = useRouter();
  const first = titles.find((x) => x.id === initialTitleId) ?? titles.find((x) => x.hasVideo) ?? titles[0];
  const [titleId, setTitleId] = useState(first?.id ?? "");
  const [name, setName] = useState(first ? `${first.name} — TikTok launch` : "");
  const [market, setMarket] = useState("US");
  const [objective, setObjective] = useState<PromoCampaign["objective"]>("subscriptions");
  const [spoilers, setSpoilers] = useState<PromoCampaign["spoiler_level"]>("medium");
  const [destination, setDestination] = useState("");
  const [direction, setDirection] = useState("");
  const [exclusions, setExclusions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = titles.find((x) => x.id === titleId);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!selected?.hasVideo || !name.trim()) return;
    setBusy(true); setError(null);
    try {
      const result = unwrap(await postJson<{ campaign?: PromoCampaign } & ApiEnvelope>("/api/producer/promote", {
        title_id: titleId, name: name.trim(), target_market: market, destination_url: destination.trim() || null,
        objective, spoiler_level: spoilers, creative_direction: direction.trim() || null, exclusions: exclusions.trim() || null,
      }));
      router.push(`/producer/promote/${result.campaign!.id}`);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }

  if (!titles.length) return <div className="promo-empty"><h3>{tt("promote.new.noTitles")}</h3><p>{tt("promote.new.noTitlesHint")}</p><a className="btn btn-primary" href="/producer/titles/new">{tt("v3.nav.newTitle")}</a></div>;

  return (
    <form className="promo-brief" onSubmit={submit}>
      <section className="promo-brief-main card">
        <div className="field-group-title">{tt("promote.new.source")}</div>
        <div className="field"><label className="label">{tt("promote.new.drama")}</label>
          <select className="input" value={titleId} onChange={(e) => { setTitleId(e.target.value); const title = titles.find((x) => x.id === e.target.value); if (title) setName(`${title.name} — TikTok launch`); }}>
            {titles.map((title) => <option key={title.id} value={title.id} disabled={!title.hasVideo}>{title.name} · {title.episodeCount} {tt("promote.new.episodes")}{!title.hasVideo ? ` · ${tt("promote.new.noVideo")}` : ""}</option>)}
          </select>
        </div>
        {selected && !selected.hasVideo && <p className="note note-warning">{tt("promote.new.videoRequired")}</p>}
        <div className="field"><label className="label">{tt("promote.new.campaignName")}</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} required /></div>
        <div className="field-row"><div className="field"><label className="label">{tt("promote.new.market")}</label><select className="input" value={market} onChange={(e) => setMarket(e.target.value)}><option value="US">United States</option><option value="GB">United Kingdom</option><option value="CA">Canada</option><option value="AU">Australia</option></select></div><div className="field"><label className="label">{tt("promote.new.objective")}</label><select className="input" value={objective} onChange={(e) => setObjective(e.target.value as PromoCampaign["objective"])}><option value="subscriptions">{tt("promote.objective.subscriptions")}</option><option value="installs">{tt("promote.objective.installs")}</option><option value="views">{tt("promote.objective.views")}</option></select></div></div>
        <div className="field"><label className="label">{tt("promote.new.destination")}</label><input className="input" type="url" value={destination} placeholder="https://" onChange={(e) => setDestination(e.target.value)} /></div>
        <div className="field"><label className="label">{tt("promote.new.direction")}</label><textarea className="textarea" rows={4} value={direction} placeholder={tt("promote.new.directionHint")} onChange={(e) => setDirection(e.target.value)} /></div>
        <div className="field"><label className="label">{tt("promote.new.exclusions")}</label><textarea className="textarea" rows={3} value={exclusions} placeholder={tt("promote.new.exclusionsHint")} onChange={(e) => setExclusions(e.target.value)} /></div>
      </section>
      <aside className="promo-brief-side card"><span className="page-kicker">{tt("promote.new.spoilerLabel")}</span><h3>{tt("promote.new.spoilerTitle")}</h3><p>{tt("promote.new.spoilerHint")}</p><div className="promo-choice-grid">{(["low", "medium", "high"] as const).map((level) => <button key={level} type="button" className={spoilers === level ? "is-selected" : ""} onClick={() => setSpoilers(level)}><strong>{tt(`promote.spoiler.${level}`)}</strong><span>{tt(`promote.spoiler.${level}Hint`)}</span></button>)}</div><div className="promo-output-note"><strong>{tt("promote.new.outputTitle")}</strong><span>{tt("promote.new.outputHint")}</span></div>{error && <p className="err">{error}</p>}<button className="btn btn-primary promo-wide" disabled={readOnly || busy || !selected?.hasVideo || !name.trim()}>{busy ? tt("common.loading") : tt("promote.new.cta")}</button></aside>
    </form>
  );
}
