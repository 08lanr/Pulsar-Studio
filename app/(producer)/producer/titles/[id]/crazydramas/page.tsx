import CrazydramasPanel from "@/components/producer/CrazydramasPanel";
import TitleShell from "@/components/producer/TitleShell";
import { isStaffPreview, portalSession, producerLocale } from "@/components/producer/server";
import { crazydramasPublicUrl } from "@/lib/crazydramas";
import { t } from "@/lib/i18n";
import { loadTitleWorkspace } from "@/lib/research/title-workspace";

// /producer/titles/[id]/crazydramas — the CrazyDramas section of the title
// workspace (plan A4.2): where the series stands on crazydramas.com, read
// from the newest public snapshot, and Check now. Staff previewing the
// portal see the state and cannot act (CLAUDE.md); viewers read only.

export const dynamic = "force-dynamic";

export default async function CrazydramasPage({ params }: { params: { id: string } }) {
  const session = await portalSession(`/producer/titles/${params.id}/crazydramas`);
  const locale = producerLocale();
  const w = await loadTitleWorkspace(session, params.id);
  const preview = isStaffPreview(session);
  const canCheck = !preview && (session.producerRole === "approver" || session.producerRole === "reviewer");
  const adStep = w.ads.flow ? t(locale, `workflow.step.${w.ads.flow.step}`) : null;
  return (
    <TitleShell locale={locale} titleId={params.id} name_zh={w.detail.title.name_zh} name_en={w.detail.title.name_en} platform={w.platform} ads={w.ads.status} adStep={adStep} crazydramas={w.crazydramas.state} crazydramasStale={w.crazydramas.stale} section="crazydramas">
      <p className="page-sub">{t(locale, "cd.sub")}</p>
      <CrazydramasPanel
        titleId={params.id}
        status={w.crazydramas}
        publicUrl={w.crazydramas.slug ? crazydramasPublicUrl(w.crazydramas.slug) : null}
        imported={!!w.detail.title.source_ref}
        canCheck={canCheck}
        reason={preview ? "preview" : canCheck ? null : "readOnly"}
      />
    </TitleShell>
  );
}
