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
  const [nameEdited, setNameEdited] = useState(false);
  const [name, setName] = useState(first ? tt("promote.new.defaultName", { title: first.name }) : "");
  const [budget, setBudget] = useState("100");
  const [hypothesis, setHypothesis] = useState("");
  const [audience, setAudience] = useState("");
  const [market, setMarket] = useState("US");
  const [objective, setObjective] = useState<PromoCampaign["objective"]>("views");
  const [spoilers, setSpoilers] = useState<PromoCampaign["spoiler_level"]>("low");
  const [destination, setDestination] = useState("");
  const [direction, setDirection] = useState("");
  const [exclusions, setExclusions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = titles.find((x) => x.id === titleId);
  const locked = Boolean(initialTitleId && titles.some((x) => x.id === initialTitleId));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || hypothesis.trim().length < 10 || audience.trim().length < 3) return;
    setBusy(true); setError(null);
    try {
      const result = unwrap(await postJson<{ campaign?: PromoCampaign } & ApiEnvelope>("/api/producer/promote", {
        title_id: titleId, name: name.trim(), target_market: market, destination_url: destination.trim() || null,
        objective, spoiler_level: spoilers, creative_direction: direction.trim() || null, exclusions: exclusions.trim() || null,
        experiment: { budget_usd: Number(budget) || 100, hypothesis: hypothesis.trim(), audience: audience.trim(), first_batch: 2, signal: "views" },
      }));
      router.push(`/producer/promote/${result.campaign!.id}`);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }

  if (!titles.length) return <div className="promo-empty"><h3>{tt("promote.new.noTitles")}</h3><p>{tt("promote.new.noTitlesHint")}</p><a className="btn btn-primary" href="/producer/titles/new?from=promote">{tt("v3.nav.newTitle")}</a></div>;

  return (
    <form className="promo-brief" onSubmit={submit}>
      <fieldset disabled={readOnly || busy} className="promo-brief-main card" style={{ margin: 0, minWidth: 0 }}>
        <div className="field-group-title">{tt("promote.new.source")}</div>
        <div className="field"><label className="label" htmlFor="np-title">{tt("promote.new.drama")}</label>
          {locked && selected ? (
            <div className="promo-locked-title">
              <div><strong className="bilingual">{selected.name}</strong><span>{selected.episodeCount} {tt("promote.new.episodes")}{!selected.hasVideo ? ` · ${tt("promote.new.noVideo")}` : ""}</span></div>
              <a href="/producer/promote/new">{tt("promote.new.change")}</a>
            </div>
          ) : (
            <select id="np-title" className="input" value={titleId} onChange={(e) => { setTitleId(e.target.value); const title = titles.find((x) => x.id === e.target.value); if (title && !nameEdited) setName(tt("promote.new.defaultName", { title: title.name })); }}>
              {titles.map((title) => <option key={title.id} value={title.id}>{title.name} · {title.episodeCount} {tt("promote.new.episodes")}{!title.hasVideo ? ` · ${tt("promote.new.noVideo")}` : ""}</option>)}
            </select>
          )}
        </div>
        {selected && !selected.hasVideo && <p className="note note-info">{tt("launch.planNote")}</p>}
        <div className="field"><label className="label" htmlFor="np-name">{tt("promote.new.campaignName")}</label><input id="np-name" className="input" value={name} maxLength={120} onChange={(e) => { setName(e.target.value); setNameEdited(true); }} required /></div>
        <div className="field-row"><div className="field"><label className="label" htmlFor="np-market">{tt("promote.new.market")}</label><select id="np-market" className="input" value={market} onChange={(e) => setMarket(e.target.value)}>{["US", "GB", "CA", "AU"].map((code) => <option key={code} value={code}>{tt(`ux.market.${code}`)}</option>)}</select></div><div className="field"><label className="label" htmlFor="np-objective">{tt("promote.new.objective")}</label><select id="np-objective" className="input" value={objective} onChange={(e) => setObjective(e.target.value as PromoCampaign["objective"])}><option value="subscriptions">{tt("promote.objective.subscriptions")}</option><option value="installs">{tt("promote.objective.installs")}</option><option value="views">{tt("promote.objective.views")}</option></select></div></div>
        <div className="field-row"><div className="field"><label className="label" htmlFor="np-budget">{tt("ws.exp.budget")}</label><input id="np-budget" className="input" type="number" min={1} max={100000} value={budget} onChange={(e) => setBudget(e.target.value)} required /><p className="hint">{tt("ws.exp.budgetNote")}</p></div><div className="field"><label className="label" htmlFor="np-audience">{tt("ws.exp.audience")}</label><input id="np-audience" aria-describedby="np-audience-hint" className="input" minLength={3} maxLength={200} value={audience} onChange={(e) => setAudience(e.target.value)} required /><p className="hint" id="np-audience-hint">{tt("review.audienceHint")}</p></div></div>
        <div className="field"><label className="label" htmlFor="np-hypothesis">{tt("ws.exp.hypothesis")}</label><textarea id="np-hypothesis" aria-describedby="np-hypothesis-hint" minLength={10} className="textarea" rows={3} maxLength={400} value={hypothesis} onChange={(e) => setHypothesis(e.target.value)} required /><p className="hint" id="np-hypothesis-hint">{tt("review.hypothesisHint")}</p></div>
        <div className="field"><label className="label" htmlFor="np-destination">{tt("promote.new.destination")}</label><input id="np-destination" className="input" type="url" value={destination} placeholder="https://" onChange={(e) => setDestination(e.target.value)} /></div>
        <div className="field"><label className="label" htmlFor="np-direction">{tt("promote.new.direction")}</label><textarea id="np-direction" maxLength={1000} className="textarea" rows={4} value={direction} placeholder={tt("promote.new.directionHint")} onChange={(e) => setDirection(e.target.value)} /></div>
        <div className="field"><label className="label" htmlFor="np-exclusions">{tt("promote.new.exclusions")}</label><textarea id="np-exclusions" maxLength={1000} className="textarea" rows={3} value={exclusions} placeholder={tt("promote.new.exclusionsHint")} onChange={(e) => setExclusions(e.target.value)} /></div>
      </fieldset>
      <aside className="promo-brief-side card">{readOnly && <p className="hint" role="status">{tt("ws.readOnly")}</p>}<span className="page-kicker">{tt("promote.new.spoilerLabel")}</span><h3>{tt("promote.new.spoilerTitle")}</h3><p>{tt("promote.new.spoilerHint")}</p><div className="promo-choice-grid">{(["low", "medium", "high"] as const).map((level) => <button key={level} type="button" disabled={readOnly || busy} aria-pressed={spoilers === level} className={spoilers === level ? "is-selected" : ""} onClick={() => setSpoilers(level)}><strong>{tt(`promote.spoiler.${level}`)}</strong><span>{tt(`promote.spoiler.${level}Hint`)}</span></button>)}</div><div className="promo-output-note"><strong>{tt("promote.new.outputTitle")}</strong><span>{tt("promote.new.outputHint")}</span></div>{error && <p className="err" role="alert">{error}</p>}{!readOnly && (!name.trim() || hypothesis.trim().length < 10 || audience.trim().length < 3) && <p className="hint">{tt("promote.new.requirements")}</p>}<button className="btn btn-primary promo-wide" disabled={readOnly || busy || !name.trim() || hypothesis.trim().length < 10 || audience.trim().length < 3}>{busy ? tt("common.loading") : tt("promote.new.cta")}</button></aside>
    </form>
  );
}
