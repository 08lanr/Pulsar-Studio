"use client";

// The studio-profile questionnaire. Chips, not free text, so every answer
// is a taxonomy id the engine can use directly. PUTs
// /api/producer/research/profile; the server re-validates with zod and the
// data layer refuses viewers and staff.

import { toggleDistribution, normalizeMarkets } from '@/lib/research/navigation';
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/components/locale";
import { TROPES, type TropeId } from "@/lib/research/taxonomy";
import type { ResearchProfile } from "@/lib/research/types";

type Distribution = ResearchProfile["distribution"][number];
const DISTRIBUTIONS: Distribution[] = ["licensed", "self", "youtube", "none"];

export default function OnboardingForm({ initial, readOnly }: { initial: ResearchProfile | null; readOnly: boolean }) {
  const { tt, locale } = useT();
  const router = useRouter();
  const [tropes, setTropes] = useState<TropeId[]>(initial?.tropes ?? []);
  const [audience, setAudience] = useState<ResearchProfile["audience"]>(initial?.audience ?? null);
  const [volume, setVolume] = useState<string>(initial?.titles_per_year != null ? String(initial.titles_per_year) : "");
  const [distribution, setDistribution] = useState<Distribution[]>(initial?.distribution ?? []);
  const [markets, setMarkets] = useState<string>(normalizeMarkets(initial?.target_markets ?? []).join(", "));
  const [busy, setBusy] = useState(false);

  const [error, setError] = useState<string | null>(null);

  function toggle<T>(list: T[], value: T, max?: number): T[] {
    if (list.includes(value)) return list.filter((x) => x !== value);
    if (max && list.length >= max) return list;
    return [...list, value];
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (readOnly || busy) return;
    setBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/producer/research/profile", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tropes,
          audience,
          titles_per_year: volume.trim() ? Number(volume) : null,
          distribution,
          target_markets: markets
            .split(/[,，]/)
            .map((s) => s.trim())
            .filter(Boolean)
            .slice(0, 8),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      router.push("/producer?mode=company&saved=1");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form className="rs-form" onSubmit={submit}>
      <fieldset disabled={readOnly || busy}>
        <legend>{tt("research.onboard.tropes")}</legend>
        <p className="hint">{tt("research.onboard.tropesHint")} <span role="status">{tropes.length}/12</span></p>
        <div className="rs-choices">
          {TROPES.map((tr) => {
            const on = tropes.includes(tr.id);
            return (
              <label key={tr.id} className={`rs-choice${on ? " on" : ""}`}>
                <input type="checkbox" disabled={!on && tropes.length >= 12} checked={on} onChange={() => setTropes((l) => toggle(l, tr.id, 12))} />
                {locale === "zh" ? tr.zh : tr.en}
              </label>
            );
          })}
        </div>
      </fieldset>

      <fieldset disabled={readOnly || busy}>
        <legend>{tt("research.onboard.audience")}</legend>
        <p className="hint">{tt("research.onboard.audienceHint")}</p>
        <div className="rs-choices">
          {(["female", "male", "both"] as const).map((v) => (
            <label key={v} className={`rs-choice${audience === v ? " on" : ""}`}>
              <input type="radio" name="audience" checked={audience === v} onChange={() => setAudience(v)} />
              {v === "both" ? tt("research.onboard.audienceBoth") : tt(`research.audience.${v}`)}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset disabled={readOnly || busy}>
        <legend>{tt("research.onboard.distribution")}</legend>
        <div className="rs-choices">
          {DISTRIBUTIONS.map((d) => {
            const on = distribution.includes(d);
            return (
              <label key={d} className={`rs-choice${on ? " on" : ""}`}>
                <input type="checkbox" checked={on} onChange={() => setDistribution((l) => toggleDistribution(l, d))} />
                {tt(`research.onboard.dist.${d}`)}
              </label>
            );
          })}
        </div>
      </fieldset>

      <fieldset disabled={readOnly || busy}>
        <legend>{tt("research.onboard.volume")}</legend>
        <input className="input" aria-label={tt("research.onboard.volume")} type="number" min={0} max={1000} value={volume} onChange={(e) => setVolume(e.target.value)} />
      </fieldset>

      <fieldset disabled={readOnly || busy}>
        <legend>{tt("research.onboard.markets")}</legend>
        <p className="hint">{tt("research.onboard.marketsHint")}</p>
        <div className="rs-choices">{['US','CA','GB','AU','SG','MY','JP','KR',...markets.split(',').map(x=>x.trim()).filter(x=>x && !['US','CA','GB','AU','SG','MY','JP','KR'].includes(x))].map(code => <label key={code} className="rs-choice"><input type="checkbox" disabled={!markets.split(',').map(x=>x.trim()).includes(code) && markets.split(',').filter(x=>x.trim()).length>=8} checked={markets.split(',').map(x=>x.trim()).includes(code)} onChange={()=>setMarkets(toggle(markets.split(',').map(x=>x.trim()).filter(Boolean), code, 8).join(', '))} />{tt('ux.market.'+code) === 'ux.market.'+code ? code : tt('ux.market.'+code)}</label>)}</div>
      </fieldset>

      <div className="rs-form-foot">
        <button className="btn btn-primary" type="submit" disabled={readOnly || busy || tropes.length === 0}>
          {busy ? tt("ux.loading") : tt("research.onboard.save")}
        </button>
        <a className="btn btn-outline" href="/producer/company" aria-disabled={busy} onClick={e=>{if(busy)e.preventDefault();}}>{tt("ux.cancel")}</a>
        {error && <span className="err" role="alert">{error}</span>}
      </div>
    </form>
  );
}
