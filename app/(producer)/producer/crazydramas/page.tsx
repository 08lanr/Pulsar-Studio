import CrazydramasHub from "@/components/producer/crazydramas/Hub";
import { isStaffPreview, portalSession, producerLocale } from "@/components/producer/server";
import { loadCrazydramasHub } from "@/lib/crazydramas/hub";
import { t } from "@/lib/i18n";

// /producer/crazydramas — the company's CrazyDramas hub (the producer mirror
// of /crazydramas, 2026-09-24): the workspace films and the company's own
// titles, each with where it stands in Studio and on crazydramas.com and the
// one next step. The company's approver imports, uploads and publishes in
// place; everyone else reads, and staff previewing the portal cannot act
// (CLAUDE.md). Series that match no title are staff's list, not shown here.

export const dynamic = "force-dynamic";

export default async function ProducerCrazydramasHubPage() {
  const session = await portalSession("/producer/crazydramas");
  const locale = producerLocale();
  const preview = isStaffPreview(session);
  const canAct = !preview && session.producerRole === "approver";
  const hub = await loadCrazydramasHub(session, { portal: "producer", can_act: canAct });
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t(locale, "cdh.title")}</h1>
          <p className="page-sub">{t(locale, "cdh.subProducer")}</p>
        </div>
      </div>
      <CrazydramasHub hub={hub} portal="producer" canAct={canAct} reason={preview ? "preview" : canAct ? null : "readOnly"} />
    </>
  );
}
