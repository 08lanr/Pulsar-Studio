"use client";

import { switchLocale } from "@/lib/i18n";
import { useT } from "./locale";

/** 中文 ⇄ EN. A cookie flip plus reload — see lib/i18n.ts. Rendered as the
 *  system's segmented control; margin:0 so it sits flush in a header row. */
export default function LangToggle() {
  const { locale } = useT();
  return (
    <div
      className="seg"
      role="group"
      aria-label="Switch language"
      style={{ margin: 0 }}
    >
      <button
        type="button"
        className={`seg-btn ${locale === "zh" ? "on" : ""}`}
        aria-pressed={locale === "zh"}
        onClick={() => locale !== "zh" && switchLocale("zh")}
      >
        中文
      </button>
      <button
        type="button"
        className={`seg-btn ${locale === "en" ? "on" : ""}`}
        aria-pressed={locale === "en"}
        onClick={() => locale !== "en" && switchLocale("en")}
      >
        EN
      </button>
    </div>
  );
}
