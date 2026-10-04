import Info from "@/components/admin/cd-stats/Info";
import type { ArmRow, BoughtMix, CampaignBrief } from "@/lib/crazydramas/stats-brief";
import { BOUGHT_GROUPS } from "@/lib/crazydramas/stats-brief";
import { fmtShare, fmtUsdCents, share } from "@/lib/crazydramas/stats-summary";
import { t, type Locale } from "@/lib/i18n";

// The first tab's three daily answers (decision 2026-10-04 "The summary answers the daily questions"): the paywall
// test's two sheets, what was bought (VIP, a series, coins), and each campaign's spend against what it sold. Server
// components; the sums are lib/crazydramas/stats-brief.ts.

const n0 = (v: number) => v.toLocaleString("en-US");

/** The paywall test: a row per sheet. `rows` null when the report has no arms for the period. */
export function PaywallTestPanel({ rows, wholeSite, href, locale }: { rows: ArmRow[] | null; wholeSite: boolean; href: string; locale: Locale }) {
  const tt = (k: string, v?: Record<string, string | number>) => t(locale, k, v);
  const shown = rows ? rows.reduce((a, r) => a + r.viewer_days, 0) : 0;
  return (
    <section className="rs-panel cdx-card">
      <div className="cdx-card-head">
        <h2>
          {tt("cdbf.test.title")} <Info text={tt("cdbf.test.info")} label={tt("cdx.about", { what: tt("cdbf.test.title") })} />
        </h2>
        <a href={href}>{tt("cdbf.test.more")}&nbsp;→</a>
      </div>
      {!rows ? (
        <p className="rs-empty">{tt("cdbf.test.none")}</p>
      ) : (
        <>
          <div className="an-scroll" tabIndex={0} role="region" aria-label={tt("cdbf.test.title")}>
            <table className="an-table cds-table cdx-table">
              <thead>
                <tr>
                  <th scope="col">{tt("cdbf.test.col.sheet")}</th>
                  <th scope="col" className="gt-num">{tt("cdbf.test.col.shown")}</th>
                  <th scope="col" className="gt-num">{tt("cdbf.test.col.split")}</th>
                  <th scope="col" className="gt-num">{tt("cdbf.test.col.checkout")}</th>
                  <th scope="col" className="gt-num">{tt("cdbf.test.col.paid")}</th>
                  <th scope="col" className="gt-num">{tt("cdbf.test.col.rate")}</th>
                  <th scope="col" className="gt-num">{tt("cdbf.col.vip")}</th>
                  <th scope="col" className="gt-num">{tt("cdbf.col.series")}</th>
                  <th scope="col" className="gt-num">{tt("cdbf.col.coins")}</th>
                  <th scope="col" className="gt-num">{tt("cdm.col.cash")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.arm}>
                    <th scope="row" className="cds-title">{tt(`cdbf.arm.${r.arm}`)}</th>
                    <td className="gt-num">{n0(r.viewer_days)}</td>
                    <td className="gt-num">{shown ? fmtShare(share(r.viewer_days, shown)) : "–"}</td>
                    <td className="gt-num">{n0(r.starter_days)}</td>
                    <td className="gt-num">{n0(r.payers)}</td>
                    <td className="gt-num">{r.viewer_days ? fmtShare(share(r.payers, r.viewer_days)) : "–"}</td>
                    <td className="gt-num">{n0(r.vip)}</td>
                    <td className="gt-num">{n0(r.series)}</td>
                    <td className="gt-num">{n0(r.coins)}</td>
                    <td className="gt-num">{fmtUsdCents(r.cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {wholeSite && <p className="cdx-note">{tt("cdbf.test.wholeSite")}</p>}
        </>
      )}
    </section>
  );
}

/** What was bought in the period: new VIPs, series, coin packs, renewals. */
export function BoughtPanel({ mix, href, locale }: { mix: BoughtMix; href: string; locale: Locale }) {
  const tt = (k: string, v?: Record<string, string | number>) => t(locale, k, v);
  const all = BOUGHT_GROUPS.reduce((a, g) => a + mix[g].payments, 0);
  const top = Math.max(1, ...BOUGHT_GROUPS.map((g) => mix[g].payments));
  return (
    <section className="rs-panel cdx-card">
      <div className="cdx-card-head">
        <h2>
          {tt("cdbf.mix.title")} <Info text={tt("cdbf.mix.info")} label={tt("cdx.about", { what: tt("cdbf.mix.title") })} />
        </h2>
        <a href={href}>{tt("cdbf.mix.more")}&nbsp;→</a>
      </div>
      {all === 0 ? (
        <p className="rs-empty">{tt("cdbf.mix.none")}</p>
      ) : (
        <div className="an-scroll" tabIndex={0} role="region" aria-label={tt("cdbf.mix.title")}>
          <table className="an-table cds-table cdx-table">
            <thead>
              <tr>
                <th scope="col" />
                <th scope="col" className="gt-num">{tt("cdbf.mix.col.payments")}</th>
                <th scope="col" className="gt-num">{tt("cdbf.mix.col.share")}</th>
                <th scope="col" className="gt-num">{tt("cdm.col.cash")}</th>
                <th scope="col" className="cdm-bar-cell" />
              </tr>
            </thead>
            <tbody>
              {BOUGHT_GROUPS.map((g) => (
                <tr key={g}>
                  <th scope="row" className="cds-title">{tt(`cdbf.group.${g}`)}</th>
                  <td className="gt-num">{n0(mix[g].payments)}</td>
                  <td className="gt-num">{fmtShare(share(mix[g].payments, all))}</td>
                  <td className="gt-num">{fmtUsdCents(mix[g].cents)}</td>
                  <td className="cdm-bar-cell">
                    <span className="cdm-bar" style={{ width: `${Math.round((mix[g].payments / top) * 100)}%` }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Each campaign's spend against what its visitors paid for. `nameOf` names a campaign Studio has no launch for. */
export function CampaignBriefPanel({ rows, nameOf, note, href, locale }: { rows: CampaignBrief[]; nameOf: (id: string) => string; note: string | null; href: string; locale: Locale }) {
  const tt = (k: string, v?: Record<string, string | number>) => t(locale, k, v);
  const label = (r: CampaignBrief) => (r.kind === "stored_copy" ? tt("cds.ads.storedCopy") : r.kind === "no_ad" ? tt("cds.ads.noAd") : (r.name ?? (r.campaign_id ? nameOf(r.campaign_id) : "–")));
  const sum = (f: (r: CampaignBrief) => number) => rows.reduce((a, r) => a + f(r), 0);
  const spend = rows.some((r) => r.spend_cents !== null) ? sum((r) => r.spend_cents ?? 0) : null;
  const adPayments = sum((r) => (r.kind === "campaign" ? r.payments : 0));
  return (
    <section className="rs-panel cdx-card">
      <div className="cdx-card-head">
        <h2>
          {tt("cdbf.camp.title")} <Info text={tt("cdbf.camp.info")} label={tt("cdx.about", { what: tt("cdbf.camp.title") })} />
        </h2>
        <a href={href}>{tt("cdbf.camp.more")}&nbsp;→</a>
      </div>
      {rows.length === 0 ? (
        <p className="rs-empty">{tt("cdbf.camp.none")}</p>
      ) : (
        <div className="an-scroll" tabIndex={0} role="region" aria-label={tt("cdbf.camp.title")}>
          <table className="an-table cds-table cdx-table">
            <thead>
              <tr>
                <th scope="col">{tt("cdbf.camp.col.campaign")}</th>
                <th scope="col" className="gt-num">{tt("cdo.spend")}</th>
                <th scope="col" className="gt-num">{tt("cdbf.camp.col.visitors")}</th>
                <th scope="col" className="gt-num">{tt("cdbf.camp.col.checkouts")}</th>
                <th scope="col" className="gt-num">{tt("cdbf.col.paid")}</th>
                <th scope="col" className="gt-num">{tt("cdbf.col.vip")}</th>
                <th scope="col" className="gt-num">{tt("cdbf.col.series")}</th>
                <th scope="col" className="gt-num">{tt("cdbf.col.coins")}</th>
                <th scope="col" className="gt-num">{tt("cdbf.camp.col.cost")}</th>
                <th scope="col" className="gt-num">{tt("cdm.col.cash")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <th scope="row" className="cds-title">{label(r)}</th>
                  <td className="gt-num">{r.spend_cents === null ? "–" : fmtUsdCents(r.spend_cents)}</td>
                  <td className="gt-num">{n0(r.opened)}</td>
                  <td className="gt-num">{n0(r.checkouts)}</td>
                  <td className="gt-num">{n0(r.payments)}</td>
                  <td className="gt-num">{n0(r.vip)}</td>
                  <td className="gt-num">{n0(r.series)}</td>
                  <td className="gt-num">{n0(r.coins)}</td>
                  <td className="gt-num">{r.cost_per_payment_cents === null ? "–" : fmtUsdCents(r.cost_per_payment_cents)}</td>
                  <td className="gt-num">{fmtUsdCents(r.cents)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" className="cds-title">{tt("cdbf.camp.total")}</th>
                <td className="gt-num">{spend === null ? "–" : fmtUsdCents(spend)}</td>
                <td className="gt-num">{n0(sum((r) => r.opened))}</td>
                <td className="gt-num">{n0(sum((r) => r.checkouts))}</td>
                <td className="gt-num">{n0(sum((r) => r.payments))}</td>
                <td className="gt-num">{n0(sum((r) => r.vip))}</td>
                <td className="gt-num">{n0(sum((r) => r.series))}</td>
                <td className="gt-num">{n0(sum((r) => r.coins))}</td>
                <td className="gt-num">{spend && adPayments ? fmtUsdCents(Math.round(spend / adPayments)) : "–"}</td>
                <td className="gt-num">{fmtUsdCents(sum((r) => r.cents))}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      {note && <p className="cdx-note">{note}</p>}
    </section>
  );
}
