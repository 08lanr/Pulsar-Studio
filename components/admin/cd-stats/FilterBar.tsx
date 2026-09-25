"use client";

import { useRouter } from "next/navigation";
import { useT } from "@/components/locale";

// The dashboard's filters (Ruobin, 2026-09-25: "a comprehensive dashboard that contains all these things?
// al these options?"): the series, the kind of phone, the source and the country, kept in the address bar with the
// period, so a filtered view can be shared or reloaded. Choosing one reloads the page with it.

export type FilterOptions = {
  series: { slug: string; title: string }[];
  devices: string[];
  countries: { key: string; label: string }[];
  sources: { key: string; label: string }[];
};

export default function FilterBar({
  range,
  value,
  options,
}: {
  range: string;
  value: { series: string | null; device: string | null; source: string | null; country: string | null };
  options: FilterOptions;
}) {
  const { tt } = useT();
  const router = useRouter();
  const go = (patch: Partial<typeof value>) => {
    const next = { ...value, ...patch };
    const q = new URLSearchParams({ range });
    if (next.series) q.set("series", next.series);
    if (next.device) q.set("device", next.device);
    if (next.source) q.set("source", next.source);
    if (next.country) q.set("country", next.country);
    router.push(`/crazydramas/stats?${q.toString()}`);
  };
  const any = value.series || value.device || value.source || value.country;
  return (
    <div className="cdd-filters" role="group" aria-label={tt("cdd.filter.label")}>
      <label className="cdd-filter">
        <span>{tt("cdd.filter.series")}</span>
        <select value={value.series ?? ""} onChange={(e) => go({ series: e.target.value || null })}>
          <option value="">{tt("cdd.filter.allSeries")}</option>
          {options.series.map((s) => (
            <option key={s.slug} value={s.slug}>
              {s.title}
            </option>
          ))}
        </select>
      </label>
      <label className="cdd-filter">
        <span>{tt("cdd.filter.device")}</span>
        <select value={value.device ?? ""} onChange={(e) => go({ device: e.target.value || null })}>
          <option value="">{tt("cdd.filter.allDevices")}</option>
          {options.devices.map((d) => (
            <option key={d} value={d}>
              {tt(`cds.dev.${d}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="cdd-filter">
        <span>{tt("cdd.filter.source")}</span>
        <select value={value.source ?? ""} onChange={(e) => go({ source: e.target.value || null })}>
          <option value="">{tt("cdd.filter.allSources")}</option>
          {options.sources.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <label className="cdd-filter">
        <span>{tt("cdd.filter.country")}</span>
        <select value={value.country ?? ""} onChange={(e) => go({ country: e.target.value || null })}>
          <option value="">{tt("cdd.filter.allCountries")}</option>
          {options.countries.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      {any && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => go({ series: null, device: null, source: null, country: null })}>
          {tt("cdd.filter.clear")}
        </button>
      )}
    </div>
  );
}
