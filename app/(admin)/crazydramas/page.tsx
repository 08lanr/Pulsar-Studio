import CrazydramasHub from "@/components/producer/crazydramas/Hub";
import { adminLocale, staffSession } from "@/components/admin/server";
import { loadCrazydramasHub } from "@/lib/crazydramas/hub";
import { getData } from "@/lib/data";
import { t } from "@/lib/i18n";

// /crazydramas — the CrazyDramas hub (overnight spec item 10, 2026-09-24):
// one row per film or title — every workspace film, every Studio title, and
// every series live on crazydramas.com that matches neither — with where it
// stands in Studio and on crazydramas and one button for the next step
// (Import → Upload to CrazyDramas → Publish → Open on site). Films that
// cannot be imported yet fold into "Not ready (n)". A staff administrator
// acts (imports for the company picked above the table, uploads and
// publishes in place); other staff read the same rows.

export const dynamic = "force-dynamic";

export default async function StaffCrazydramasHubPage() {
  const session = await staffSession();
  const locale = adminLocale();
  const canAct = session.staffRole === "admin";
  const [hub, producers] = await Promise.all([
    loadCrazydramasHub(session, { portal: "admin", can_act: canAct }),
    getData().listProducers(session).then((ps) => ps.map((p) => ({ id: p.id, name: locale === "en" ? p.name_en || p.name_zh : p.name_zh })).sort((a, b) => a.name.localeCompare(b.name))),
  ]);
  // Import for the company most of the imported films already belong to; else the first.
  const owners = new Map<string, number>();
  for (const r of hub.rows) if (r.producer_id && r.in_studio.code === "imported") owners.set(r.producer_id, (owners.get(r.producer_id) ?? 0) + 1);
  const defaultProducerId = [...owners.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? producers[0]?.id ?? null;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t(locale, "cdh.title")}</h1>
          <p className="page-sub">{t(locale, "cdh.sub")}</p>
        </div>
      </div>
      <CrazydramasHub hub={hub} portal="admin" canAct={canAct} reason={canAct ? null : "notAdmin"} producers={producers} defaultProducerId={defaultProducerId} />
    </>
  );
}
