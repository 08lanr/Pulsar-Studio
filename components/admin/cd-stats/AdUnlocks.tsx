import { headers } from "next/headers";
import Info from "@/components/admin/cd-stats/Info";
import { StackedDaysChart, type StackSeries } from "@/components/admin/cd-stats/Money";
import { KpiCard, TrendChart } from "@/components/admin/cd-stats/Overview";
import type { AdmobConnection } from "@/lib/admob/connection";
import { readAdmobConnection } from "@/lib/admob/connection";
import { ADMOB_CALLBACK_PATH } from "@/lib/admob/oauth";
import { readAdmobReport, type AdmobRead } from "@/lib/admob/read";
import { readCrazydramasAdUnlocks, type AdUnlocksRead } from "@/lib/crazydramas/ad-unlocks";
import {
  adDaysIn,
  admobEarningsByDay,
  admobIn,
  admobTotals,
  admobVsOurs,
  admobWindow,
  adUnlockFrame,
  adUnlockSpans,
  adUnlockTotals,
  afterAds,
  capShare,
  episodesPerViewer,
  failuresByReason,
  fmtEcpm,
  grantedByDay,
  microsToCents,
  viewersPerDay,
} from "@/lib/crazydramas/ad-unlocks-summary";
import { changeAbove } from "@/lib/crazydramas/stats-ads";
import { change, fmtShare, fmtUsdCents, oneDay, type StatsRange } from "@/lib/crazydramas/stats-summary";
import { t, type Locale } from "@/lib/i18n";

// The "Ad unlocks" tab of /crazydramas/stats (decision 2026-11-09, "Ad unlocks in Studio"; Ruobin: "why not both? for
// the numbers"): crazydramas' own counts of rewarded ads (POST /api/studio/ad-unlocks, lib/crazydramas/ad-unlocks.ts)
// next to Google AdMob's network report (lib/admob/read.ts). Six headline numbers against the period before, one
// chart of ads per day by platform with AdMob's earnings under it, AdMob against ours per day and platform, the
// series, the failures, and whether ad watchers paid later. Each source says how fresh it is; a missing source (AdMob
// not connected, a crazydramas without the route) is a short note in its place. Sums: lib/crazydramas/ad-unlocks-summary.ts.

const n0 = (v: number) => v.toLocaleString("en-US");
const n1 = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 1 });
const pacificToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" });
const dateOf = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" });
const relChange = (now: number | null, before: number | null) => (now === null || before === null || before === 0 ? null : (now - before) / before);

/** The address Google must send people back to: this Studio's own origin (behind a proxy, its forwarded host). */
function callbackUri(): string {
  const h = headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3200";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}${ADMOB_CALLBACK_PATH}`;
}

export type AdmobNotice = { status: string | null; detail: string | null };

export default async function AdUnlocksTab({ locale, range, fresh, vs, notice }: { locale: Locale; range: StatsRange; fresh: boolean; vs: string | null; notice: AdmobNotice }) {
  const tt = (k: string, v?: Record<string, string | number>) => t(locale, k, v);
  const today = pacificToday();
  const [cd, admob]: [AdUnlocksRead, AdmobRead] = await Promise.all([readCrazydramasAdUnlocks({ fresh }), readAdmobReport(admobWindow(today), { fresh })]);
  const report = cd.ok ? cd.report : null;
  const rows = admob.ok ? admob.rows : null;
  const frame = adUnlockFrame(report, rows, today);
  const { span, prev, chart } = adUnlockSpans(frame, range);
  const compareVs = prev ? vs : null;

  const ours = report ? adUnlockTotals(adDaysIn(report, span)) : null;
  const oursBefore = report && prev ? adUnlockTotals(adDaysIn(report, prev)) : null;
  const am = rows ? admobTotals(admobIn(rows, span)) : null;
  const amBefore = rows && prev ? admobTotals(admobIn(rows, prev)) : null;
  const perViewer = ours ? episodesPerViewer(ours) : null;
  const perViewerBefore = oursBefore ? episodesPerViewer(oursBefore) : null;
  const capped = ours ? capShare(ours) : null;
  const cappedBefore = oursBefore ? capShare(oursBefore) : null;
  const vpd = ours ? viewersPerDay(ours, span) : null;
  const vpdBefore = oursBefore && prev ? viewersPerDay(oursBefore, prev) : null;
  const stacks = report ? grantedByDay(report, chart) : null;
  const earningsDays = rows ? admobEarningsByDay(rows, chart) : null;
  const dash = "–";

  // What stands in for a source that did not answer: one short line, never an error page.
  const cdNote = cd.ok ? null : cd.code === "not_deployed" ? tt("cdau.cd.notDeployed") : cd.code === "read_off" ? tt("cds.failed.readOff", { error: cd.error }) : tt("cdau.cd.failed", { error: cd.error });
  const admobShort = admob.ok ? null : admob.code === "not_configured" || admob.code === "not_connected" || admob.code === "revoked" ? tt("cdau.admob.notConnectedShort") : tt("cdau.admob.failedShort");

  const platformSeries: StackSeries[] = [
    { key: "ios", label: tt("cdau.p.ios"), colour: 1 },
    { key: "android", label: tt("cdau.p.android"), colour: 3 },
    { key: "web", label: tt("cdau.p.web"), colour: 5 },
  ];
  const compare = admobVsOurs(report ? adDaysIn(report, span) : null, rows ? admobIn(rows, span) : null, span);
  const failures = report ? failuresByReason(report.failures, span) : [];
  const failLabel = (reason: string) => {
    const k = `cdau.fail.${reason}`;
    const label = tt(k);
    return label === k ? reason : label;
  };
  const after = report ? afterAds(report.after) : null;
  const refusedList = ours
    ? (["cap", "too_fast", "expired", "duplicate", "already_open", "unknown"] as const)
        .filter((k) => ours.refused[k] > 0)
        .map((k) => `${tt(`cdau.refused.${k}`)} ${n0(ours.refused[k])}`)
        .join(" · ")
    : "";

  return (
    <>
      {notice.status === "connected" && <p className="note" role="status">{tt("cdau.admob.connected")}</p>}
      {notice.status === "disconnected" && <p className="note" role="status">{tt("cdau.admob.disconnected")}</p>}
      {notice.status === "error" && <p className="note note-warn" role="alert">{tt("cdau.admob.connectError", { error: notice.detail ?? "" })}</p>}

      <p className="cdx-muted" data-testid="cdau-fresh">
        {tt("cdau.fresh.cd")}: {cd.ok ? (cd.mode === "fake" ? tt("cdx.testData") : tt("cdau.fresh.counted", { time: timeOf(cd.report.generated_at) })) : tt("cdau.fresh.missing")}
        {" · "}
        {tt("cdau.fresh.admob")}: {admob.ok ? (admob.mode === "fake" ? tt("cdx.testData") : tt("cdau.fresh.read", { time: timeOf(admob.read_at) })) : admobShort}{" "}
        <Info text={tt("cdau.fresh.info")} label={tt("cdx.about", { what: tt("cdau.fresh.name") })} />
      </p>
      {report && (
        <p className="cdx-muted">
          {report.switch.on ? tt("cdau.switch.on", { units: n0(report.switch.admob_units), cap: n0(report.switch.daily_cap), web: tt(`cdau.web.${report.switch.web ?? "off"}`) }) : tt("cdau.switch.off")}
        </p>
      )}
      {cdNote && <p className={`note${cd.ok || cd.code === "not_deployed" ? "" : " note-warn"}`} data-testid="cdau-cd-note">{cdNote}</p>}

      <div className="cdx-kpis">
        <KpiCard
          label={tt("cdau.k.granted")}
          info={tt("cdau.k.granted.info")}
          value={ours ? n0(ours.granted) : dash}
          sub={ours ? tt("cdau.k.granted.sub", { n: n0(ours.opened) }) : null}
          change={ours && oursBefore ? change(ours.granted, oursBefore.granted) : null}
          vs={compareVs}
          spark={stacks ? stacks.map((d) => d.values.ios + d.values.android + d.values.web) : undefined}
        />
        <KpiCard
          label={tt("cdau.k.viewers")}
          info={tt("cdau.k.viewers.info")}
          value={ours && vpd !== null ? (oneDay(range) ? n0(ours.granted_viewer_days) : tt("cdau.k.viewers.avg", { n: n1(vpd) })) : dash}
          sub={after && range === "all" ? tt("cdau.k.viewers.people", { n: n0(after.ad_viewers) }) : null}
          change={vpd !== null && vpdBefore !== null && oursBefore && oursBefore.granted_viewer_days >= 10 ? relChange(vpd, vpdBefore) : null}
          vs={compareVs}
        />
        <KpiCard label={tt("cdau.k.perViewer")} info={tt("cdau.k.perViewer.info")} value={perViewer === null ? dash : n1(perViewer)} change={oursBefore && oursBefore.granted_viewer_days >= 10 ? relChange(perViewer, perViewerBefore) : null} vs={compareVs} />
        <KpiCard
          label={tt("cdau.k.cap")}
          info={tt("cdau.k.cap.info", { cap: report ? n0(report.switch.daily_cap) : "3" })}
          value={fmtShare(capped)}
          sub={ours ? tt("cdau.k.cap.sub", { n: n0(ours.capped_viewer_days) }) : null}
          change={oursBefore && oursBefore.granted_viewer_days >= 10 ? relChange(capped, cappedBefore) : null}
          vs={compareVs}
        />
        <KpiCard
          label={tt("cdau.k.earnings")}
          info={tt("cdau.k.earnings.info")}
          value={am ? fmtUsdCents(microsToCents(am.earnings_micros)) : dash}
          sub={am ? null : admobShort}
          change={am && amBefore ? changeAbove(microsToCents(am.earnings_micros), microsToCents(amBefore.earnings_micros), 100) : null}
          vs={compareVs}
          spark={earningsDays ? earningsDays.map((d) => d.value) : undefined}
        />
        <KpiCard
          label={tt("cdau.k.ecpm")}
          info={tt("cdau.k.ecpm.info")}
          value={am ? fmtEcpm(am.ecpm_micros) : dash}
          sub={am ? tt("cdau.k.ecpm.sub", { n: n0(am.impressions) }) : admobShort}
          change={am && amBefore && amBefore.impressions >= 100 ? relChange(am.ecpm_micros, amBefore.ecpm_micros) : null}
          vs={compareVs}
        />
      </div>

      {!admob.ok && <AdmobCard read={admob} locale={locale} />}

      <section className="rs-panel cdx-card">
        {stacks ? (
          <>
            <StackedDaysChart id="cdau-granted-days" title={tt("cdau.chart")} days={stacks} series={platformSeries} fmt={n0} tableLabel={tt("cdx.numbers")} />
            {ours && (
              <p className="cdm-note">
                {tt("cdau.notGranted", { refused: n0(ours.refused_total), unfinished: n0(ours.unfinished) })}
                {refusedList ? ` (${refusedList})` : ""} · {tt("cdau.verified", { ssv: n0(ours.ssv), granted: n0(ours.granted) })}{" "}
                <Info text={tt("cdau.notGranted.info")} label={tt("cdx.about", { what: tt("cdau.notGranted.name") })} />
              </p>
            )}
          </>
        ) : (
          <p className="rs-empty">{cdNote}</p>
        )}
        {earningsDays && <TrendChart title={tt("cdau.chart.earnings")} points={earningsDays} cents tableLabel={tt("cdx.numbers")} />}
      </section>

      <section className="rs-panel cdx-card">
        <div className="cdx-card-head">
          <h2>
            {tt("cdau.vs.title")} <Info text={tt("cdau.vs.info")} label={tt("cdx.about", { what: tt("cdau.vs.title") })} />
          </h2>
          {!admob.ok && <span className="cdx-muted">{admobShort}</span>}
        </div>
        {compare.length === 0 ? (
          <p className="rs-empty">{tt("cdau.vs.none")}</p>
        ) : (
          <div className="an-scroll" tabIndex={0} role="region" aria-label={tt("cdau.vs.title")}>
            <table className="an-table cds-table cdx-table" data-testid="cdau-vs">
              <thead>
                <tr>
                  <th scope="col">{tt("cdau.col.day")}</th>
                  <th scope="col">{tt("cdau.col.platform")}</th>
                  <th scope="col" className="gt-num">{tt("cdau.col.impressions")}</th>
                  <th scope="col" className="gt-num">{tt("cdau.col.started")}</th>
                  <th scope="col" className="gt-num">{tt("cdau.col.gap")}</th>
                  <th scope="col" className="gt-num">{tt("cdau.col.requests")}</th>
                  <th scope="col" className="gt-num">{tt("cdau.col.match")}</th>
                  <th scope="col" className="gt-num">{tt("cdau.col.earnings")}</th>
                  <th scope="col" className="gt-num">{tt("cdau.col.ecpm")}</th>
                </tr>
              </thead>
              <tbody>
                {compare.map((r) => (
                  <tr key={`${r.day}|${r.platform}`}>
                    <th scope="row">{r.day}</th>
                    <td>{tt(`cdau.p.${r.platform}`)}</td>
                    <td className="gt-num">{r.admob ? n0(r.admob.impressions) : dash}</td>
                    <td className="gt-num">{r.ours ? n0(r.ours.started) : dash}</td>
                    <td className="gt-num">{r.gap === null ? dash : `${r.gap > 0 ? "+" : ""}${n0(r.gap)}`}</td>
                    <td className="gt-num">{r.admob ? n0(r.admob.ad_requests) : dash}</td>
                    <td className="gt-num">{r.admob ? fmtShare(r.admob.match_rate) : dash}</td>
                    <td className="gt-num">{r.admob ? fmtUsdCents(microsToCents(r.admob.earnings_micros)) : dash}</td>
                    <td className="gt-num">{r.admob ? fmtEcpm(r.admob.ecpm_micros) : dash}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {report && (
        <>
          <section className="rs-panel cdx-card">
            <div className="cdx-card-head">
              <h2>
                {tt("cdau.after.title")} <Info text={tt("cdau.after.info")} label={tt("cdx.about", { what: tt("cdau.after.title") })} />
              </h2>
              <span className="cdx-muted">{tt("cdau.window", { from: report.window.from, to: report.window.to })}</span>
            </div>
            {after && (
              <p data-testid="cdau-after">
                {tt("cdau.after.line", { n: n0(after.ad_viewers), m: n0(after.bought_after), share: fmtShare(after.share), cash: fmtUsdCents(after.revenue_cents_after) })}{" "}
                {after.bought_before_only > 0 && tt("cdau.after.before", { n: n0(after.bought_before_only) })}
              </p>
            )}
          </section>

          <section className="rs-panel cdx-card">
            <div className="cdx-card-head">
              <h2>{tt("cdau.series.title")}</h2>
              <span className="cdx-muted">{tt("cdau.window", { from: report.window.from, to: report.window.to })}</span>
            </div>
            {report.series.length === 0 ? (
              <p className="rs-empty">{tt("cdau.series.none")}</p>
            ) : (
              <div className="an-scroll" tabIndex={0} role="region" aria-label={tt("cdau.series.title")}>
                <table className="an-table cds-table cdx-table">
                  <thead>
                    <tr>
                      <th scope="col">{tt("cdau.col.series")}</th>
                      <th scope="col" className="gt-num">{tt("cdau.col.granted")}</th>
                      <th scope="col" className="gt-num">{tt("cdau.col.opened")}</th>
                      <th scope="col" className="gt-num">{tt("cdau.col.viewers")}</th>
                      <th scope="col" className="gt-num">{tt("cdau.col.topEpisode")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.series.map((s) => (
                      <tr key={s.slug}>
                        <th scope="row" className="cds-title">
                          <a href={`/crazydramas/stats/${encodeURIComponent(s.slug)}`}>{s.title}</a>
                        </th>
                        <td className="gt-num">{n0(s.granted)}</td>
                        <td className="gt-num">{n0(s.opened)}</td>
                        <td className="gt-num">{n0(s.viewers)}</td>
                        <td className="gt-num">{s.top_episode === null ? dash : tt("cdau.episode", { n: s.top_episode })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="rs-panel cdx-card">
            <div className="cdx-card-head">
              <h2>
                {tt("cdau.fail.title")} <Info text={tt("cdau.fail.info")} label={tt("cdx.about", { what: tt("cdau.fail.title") })} />
              </h2>
            </div>
            {failures.length === 0 ? (
              <p className="rs-empty">{tt("cdau.fail.none")}</p>
            ) : (
              <div className="an-scroll" tabIndex={0} role="region" aria-label={tt("cdau.fail.title")}>
                <table className="an-table cds-table cdx-table" data-testid="cdau-failures">
                  <thead>
                    <tr>
                      <th scope="col">{tt("cdau.col.reason")}</th>
                      <th scope="col" className="gt-num">{tt("cdau.col.count")}</th>
                      <th scope="col" className="gt-num">{tt("cdau.p.ios")}</th>
                      <th scope="col" className="gt-num">{tt("cdau.p.android")}</th>
                      <th scope="col" className="gt-num">{tt("cdau.p.web")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {failures.map((f) => (
                      <tr key={f.reason}>
                        <th scope="row" className="cds-title">{failLabel(f.reason)}</th>
                        <td className="gt-num">{n0(f.count)}</td>
                        <td className="gt-num">{n0(f.by_platform.ios ?? 0)}</td>
                        <td className="gt-num">{n0(f.by_platform.android ?? 0)}</td>
                        <td className="gt-num">{n0(f.by_platform.web ?? 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      {admob.ok && admob.connection && <AdmobConnected connection={admob.connection} locale={locale} />}
    </>
  );
}

/** AdMob could not be read: connect it (no OAuth client yet: which variables to set), or Google's own message. */
async function AdmobCard({ read, locale }: { read: Extract<AdmobRead, { ok: false }>; locale: Locale }) {
  const tt = (k: string, v?: Record<string, string | number>) => t(locale, k, v);
  const connectButton = (
    <a className="btn btn-primary" href="/api/admin/admob/connect" data-testid="cdau-connect">
      {tt("cdau.admob.connect")}
    </a>
  );
  if (read.code === "not_configured") {
    return (
      <section className="rs-panel cdx-card" data-testid="cdau-admob-card">
        <h2>{tt("cdau.admob.title")}</h2>
        <p>{tt("cdau.admob.notConfigured")}</p>
        <ul>
          {read.missing.map((name) => (
            <li key={name}>
              <code>{name}</code>
            </li>
          ))}
        </ul>
        <p className="cdx-muted">{tt("cdau.admob.redirect", { uri: callbackUri() })}</p>
      </section>
    );
  }
  if (read.code === "not_connected" || read.code === "revoked") {
    return (
      <section className="rs-panel cdx-card" data-testid="cdau-admob-card">
        <h2>{tt("cdau.admob.title")}</h2>
        <p>{read.code === "revoked" ? read.error : tt("cdau.admob.notConnected")}</p>
        <p>{connectButton}</p>
      </section>
    );
  }
  const connection: AdmobConnection = "connection" in read ? read.connection : await readAdmobConnection();
  return (
    <section className="rs-panel cdx-card" data-testid="cdau-admob-card">
      <h2>{tt("cdau.admob.title")}</h2>
      <p className="note note-warn" role="alert">
        {tt("cdau.admob.failed", { error: read.error })}
      </p>
      <AdmobConnected connection={connection} locale={locale} />
    </section>
  );
}

function AdmobConnected({ connection, locale }: { connection: AdmobConnection; locale: Locale }) {
  const tt = (k: string, v?: Record<string, string | number>) => t(locale, k, v);
  return (
    <form method="post" action="/api/admin/admob/disconnect" className="cdx-foot">
      <span className="cdx-muted">
        {connection.connected_at ? tt("cdau.admob.connectedBy", { who: connection.connected_by ?? tt("cdau.admob.someone"), day: dateOf(connection.connected_at) }) : tt("cdau.admob.connectedShort")}
      </span>{" "}
      <button type="submit" className="btn btn-ghost btn-sm">
        {tt("cdau.admob.disconnect")}
      </button>
    </form>
  );
}
