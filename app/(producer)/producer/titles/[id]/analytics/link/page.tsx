import AnalyticsFrame from "@/components/producer/analytics/AnalyticsFrame";
import { ConfirmLink, UnlinkButton } from "@/components/producer/analytics/LinkWorkflow";
import { loadAnalyticsPage } from "@/components/producer/analytics/load";
import { fmtUtc } from "@/components/producer/research/ui";
import { getData } from "@/lib/data";
import { dataSource } from "@/lib/data-source";
import { t } from "@/lib/i18n";
import type { AnalyticsListing } from "@/lib/analytics/types";

// /producer/titles/[id]/analytics/link — the fixture-only linking workflow:
// pick a demo listing → preview identity, platform, reporting scope and
// coverage → confirm → open analytics. A listing linked to another title is
// shown as a conflict and cannot be confirmed; near-identical names are
// surfaced as ambiguous with what tells them apart. The wording says "demo
// listing" throughout; nothing here imitates a real provider connection.
// In supabase mode there is nothing to pick until a provider is connected.

export const dynamic = "force-dynamic";

function normalize(name: string): string {
  return name.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

export default async function AnalyticsLinkPage({ params, searchParams }: { params: { id: string }; searchParams: { range?: string; listing?: string } }) {
  const data = await loadAnalyticsPage(params.id, "link", searchParams);
  const { locale, record: a, base, query, canEdit, session } = data;
  const listings = await getData().listAnalyticsListings(session);
  const fixture = dataSource() === "fixture";
  const current = a.listing;
  const picked: AnalyticsListing | null = searchParams.listing ? listings.find((l) => l.id === searchParams.listing) ?? null : null;
  const siblings = picked ? listings.filter((l) => l.id !== picked.id && normalize(l.name) === normalize(picked.name)) : [];
  const conflict = picked?.linked_title_id != null && picked.linked_title_id !== a.title.id;
  const already = picked?.linked_title_id === a.title.id;
  const titleName = locale === "en" ? a.title.name_en || a.title.name_zh : a.title.name_zh;
  const suggested = listings.filter((l) => !l.linked_title_id && normalize(l.name) === normalize(a.title.name_en ?? "")).map((l) => l.id);
  const next = `${base}${query}`;

  return (
    <AnalyticsFrame data={data} view="link">
      {!canEdit && <p className="note note-info" role="status">{t(locale, "an.readOnly")} {t(locale, "an.link.readOnlyHint")}</p>}
      {!fixture || listings.length === 0 ? (
        <section className="rs-panel rs-empty" role="status">
          <h2>{t(locale, "an.link.requiresConnection")}</h2>
          <p>{t(locale, "an.link.requiresConnectionBody")}</p>
          <a className="btn btn-outline" href="/producer/company?tab=accounts">{t(locale, "an.link.accounts")}</a>
        </section>
      ) : (
        <div className="rs-grid an-grid an-link">
          <section className="rs-panel">
            <div className="rs-panel-head"><div><h2>{t(locale, "an.link.step1")}</h2><p>{t(locale, "an.link.step1Sub", { title: titleName })}</p></div></div>
            {current && (
              <div className="an-link-current">
                <p><b>{t(locale, "an.link.current")}:</b> {current.name} <span className="ev ev-partner_reported">{current.platform_label}</span> <code>{current.id}</code></p>
                {canEdit && <UnlinkButton titleId={a.title.id} next={`${base}/link${query}`} />}
              </div>
            )}
            <ul className="rs-list an-listings">
              {listings.map((l) => {
                const other = l.linked_title_id != null && l.linked_title_id !== a.title.id;
                const mine = l.linked_title_id === a.title.id;
                return (
                  <li key={l.id} className={picked?.id === l.id ? "is-picked" : ""}>
                    <a className="rs-title-name" lang="en" href={`${base}/link?range=${a.range}&listing=${l.id}`} aria-current={picked?.id === l.id ? "true" : undefined}>{l.name}</a>
                    <span className="gt-muted">{t(locale, `an.link.path.${l.publishing_path}`)}</span>
                    {suggested.includes(l.id) && <span className="ev ev-inferred">{t(locale, "an.link.nameMatch")}</span>}
                    {mine && <span className="state state-available">{t(locale, "an.link.linkedHere")}</span>}
                    {other && <span className="state state-failed">{t(locale, "an.link.linkedElsewhere", { title: l.linked_title_name ?? "" })}</span>}
                    <span className="spacer" />
                    <small className="gt-muted">{l.coverage_from ? `${l.coverage_from} → ${l.coverage_to}` : t(locale, "an.link.noCoverage")}</small>
                  </li>
                );
              })}
            </ul>
            <div className="rs-panel-foot">{t(locale, "an.link.demoNote")}</div>
          </section>

          <section className="rs-panel" aria-live="polite">
            <div className="rs-panel-head"><div><h2>{t(locale, "an.link.step2")}</h2><p>{t(locale, "an.link.step2Sub")}</p></div></div>
            {!picked ? (
              <div className="rs-empty">{t(locale, "an.link.pickOne")}</div>
            ) : (
              <>
                <dl className="an-kv">
                  <div><dt>{t(locale, "an.link.identity")}</dt><dd lang="en">{picked.name} <code>{picked.id}</code></dd></div>
                  <div><dt>{t(locale, "an.link.platform")}</dt><dd>{picked.platform_label} · {t(locale, `an.link.path.${picked.publishing_path}`)}</dd></div>
                  <div><dt>{t(locale, "an.link.account")}</dt><dd><code>{picked.provider_account_ref}</code></dd></div>
                  <div><dt>{t(locale, "an.link.region")}</dt><dd>{picked.region_scope}</dd></div>
                  <div><dt>{t(locale, "an.link.scope")}</dt><dd>{picked.reporting_scope}</dd></div>
                  <div><dt>{t(locale, "an.link.coverage")}</dt><dd>{picked.coverage_from ? `${picked.coverage_from} → ${picked.coverage_to}` : t(locale, "an.link.noCoverage")}</dd></div>
                  <div><dt>{t(locale, "an.link.lastSync")}</dt><dd>{fmtUtc(picked.last_sync_at)} · {t(locale, `an.sync.${picked.sync_status}`)}</dd></div>
                  {picked.unavailable_components.length > 0 && <div><dt>{t(locale, "an.link.notDelivered")}</dt><dd>{picked.unavailable_components.map((k) => t(locale, `an.note.unavailable.${k}`)).join(" · ")}</dd></div>}
                  {picked.episode_attribution === "unavailable" && <div><dt>{t(locale, "an.link.episodes")}</dt><dd>{t(locale, "an.note.noEpisodeAttribution")}</dd></div>}
                </dl>
                {siblings.length > 0 && (
                  <p className="note note-warn" role="status">
                    {t(locale, "an.link.ambiguous", { n: siblings.length })}{" "}
                    {siblings.map((s) => <span key={s.id}><a href={`${base}/link?range=${a.range}&listing=${s.id}`} lang="en">{s.name}</a> ({t(locale, `an.link.path.${s.publishing_path}`)}, <code>{s.provider_account_ref}</code>) </span>)}
                    {t(locale, "an.link.ambiguousHint")}
                  </p>
                )}
                {conflict && <p className="note note-warn" role="alert">{t(locale, "an.link.conflictBody", { title: picked.linked_title_name ?? "" })}</p>}
                {already && <p className="note note-success" role="status">{t(locale, "an.link.alreadyBody")}</p>}
                <div className="rs-panel-body">
                  <h3>{t(locale, "an.link.step3")}</h3>
                  <p className="gt-muted">{t(locale, "an.link.step3Sub", { title: titleName, listing: picked.name })}</p>
                  {canEdit ? (
                    already ? (
                      <a className="btn btn-primary" href={next}>{t(locale, "an.link.openAnalytics")}&nbsp;→</a>
                    ) : (
                      <ConfirmLink titleId={a.title.id} listingId={picked.id} next={next} disabled={conflict} />
                    )
                  ) : (
                    <p className="note note-info">{t(locale, "an.readOnly")}</p>
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </AnalyticsFrame>
  );
}
