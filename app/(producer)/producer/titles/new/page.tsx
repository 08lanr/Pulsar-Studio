import NewTitleForm from "@/components/producer/NewTitleForm";
import { portalSession, producerLocale } from "@/components/producer/server";
import { t } from "@/lib/i18n";

// /producer/titles/new — the producer creates a work and uploads its script
// files in one pass. Staff previewing can see the form; the API refuses a
// staff create without a producer_id, which is fine for a preview.

export const dynamic = "force-dynamic";

export default async function ProducerNewTitle({ searchParams }: { searchParams: { from?: string } }) {
  await portalSession("/producer/titles/new");
  const locale = producerLocale();
  return (
    <>
      <div className="page-head">
        <div>
          <h2>{t(locale, "pw.new.title")}</h2>
          <p className="page-sub">{t(locale, "pw.new.sub")}</p>
        </div>
      </div>
      <NewTitleForm returnTo={searchParams.from === "promote" ? "promote" : undefined} />
    </>
  );
}
