import { portalSession, producerLocale } from "@/components/producer/server";
import { t } from "@/lib/i18n";
import { IconLibrary } from "@/components/producer/icons";

// /producer/library — the producer's full catalog with Pulsar. Placeholder
// until the Stage connection lands: it will list every title in contact with
// us alongside Stage viewing metrics. Adapt/Promote work stays in Studio.

export const dynamic = "force-dynamic";

export default async function DramaLibrary() {
  await portalSession("/producer/library");
  const locale = producerLocale();

  return (
    <>
      <div className="page-head">
        <div>
          <span className="page-kicker">{t(locale, "v3.dramaLibrary.kicker")}</span>
          <h2>{t(locale, "v3.nav.library")}</h2>
          <p className="page-sub">{t(locale, "v3.dramaLibrary.sub")}</p>
        </div>
      </div>
      <section className="promo-empty">
        <span className="promo-empty-mark"><IconLibrary /></span>
        <h3>{t(locale, "v3.dramaLibrary.emptyTitle")}</h3>
        <p>{t(locale, "v3.dramaLibrary.emptyHint")}</p>
      </section>
    </>
  );
}
