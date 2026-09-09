import { LocaleProvider } from "@/components/locale";
import { getData } from '@/lib/data';
import { dataSource } from "@/lib/data-source";
import PortalHeader from "@/components/producer/PortalHeader";
import { isStaffPreview, portalSession, producerLocale } from "@/components/producer/server";
import { t } from "@/lib/i18n";
import { ensureScheduler } from "@/lib/tiktok/scheduler";

// The partner portal shell. Chinese by default (decision #8: the route group
// decides when no cookie is set), so the nested LocaleProvider overrides the
// root layout's cookie-or-zh default with cookie-or-zh — the same today, but
// the two groups must not drift when the admin side passes `en`. Staff may
// open the portal to preview what the producer sees; they get a note and,
// on the review screen, disabled actions.

export const dynamic = "force-dynamic";

export default async function ProducerLayout({ children }: { children: React.ReactNode }) {
  ensureScheduler();
  const session = await portalSession();
  const locale = producerLocale();
  const company = await getData().getCompanyIdentity(session);
  return (
    <LocaleProvider locale={locale}>
      <PortalHeader company={company} demo={dataSource() === "fixture"} />
      <main className="producer-main" id="main-content" tabIndex={-1}>
        {isStaffPreview(session) && (
          <div className="producer-preview-note">
            <p className="note note-info">{t(locale, "portal.staffPreview")}</p>
          </div>
        )}
        {children}
      </main>
    </LocaleProvider>
  );
}
