import "./globals.css";
import "./studio-v3.css";
import "./redesign.css";
import "./redesign-catalog.css";
import "./redesign-editors.css";
import "./workflow.css";
import "./workflow-campaign.css";
import "./desk-refinement.css";
import "./catalog-refinement.css";
import "./analytics.css";
import "./title-workspace.css";
import "./polish.css";
import { cookies } from "next/headers";
import { LocaleProvider } from "@/components/locale";
import { LOCALE_COOKIE, parseLocale } from "@/lib/i18n";

export const metadata = {
  title: "Pulsar Studio",
  description: "A US launch workspace for short-drama catalogs, market evidence, and experiments.",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
};

// Runs before first paint so the page never flashes the wrong theme:
// use the saved choice if there is one, otherwise follow the system.
const themeInit = `(function(){try{var t=localStorage.getItem("theme");if(t!=="dark"&&t!=="light"){t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}document.documentElement.dataset.theme=t}catch(e){}})()`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Server-side cookie read so SSR and hydration agree on the language.
  const locale = parseLocale(cookies().get(LOCALE_COOKIE)?.value);
  return (
    <html lang={locale === "zh" ? "zh-CN" : "en"} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body>
        <LocaleProvider locale={locale}>{children}</LocaleProvider>
      </body>
    </html>
  );
}
