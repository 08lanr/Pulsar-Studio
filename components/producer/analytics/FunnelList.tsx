import type { FunnelView } from "@/lib/analytics/types";
import { t, type Locale } from "@/lib/i18n";
import { DefName } from "./bits";

// The monetization funnel as a list: each step shows its count, whether it
// counts people, events or orders, and the ratio to the previous step. The
// demo data is event counts, not a linked user cohort, and the heading says
// so; the largest observed loss is marked with text. No causation.

export default function FunnelList({ f, locale }: { f: FunnelView; locale: Locale }) {
  const max = Math.max(1, ...f.steps.map((s) => s.metric.value ?? 0));
  return (
    <div className="an-funnel">
      <p className="an-funnel-kind">{t(locale, f.linked_cohort ? "an.funnel.linked" : "an.funnel.events")}</p>
      <ol className="an-funnel-list">
        {f.steps.map((s) => {
          const v = s.metric.value;
          const width = v == null ? 0 : Math.max(2, (v / max) * 100);
          const worst = s.key === f.largest_loss_key;
          return (
            <li key={s.key} className={worst ? "is-largest-loss" : ""}>
              <div className="an-funnel-label">
                <DefName metricKey={s.key} locale={locale} />
                <span className="ev ev-inferred">{t(locale, `an.unit.${s.unit}`)}</span>
              </div>
              <div className="an-funnel-bar" aria-hidden><i style={{ width: `${width}%` }} /></div>
              <div className="an-funnel-num gt-num">{v == null ? t(locale, "an.unavailable") : v.toLocaleString("en-US")}</div>
              <div className="an-funnel-ratio">
                {s.loss_from_previous?.value != null ? (
                  <>
                    {(s.loss_from_previous.value * 100).toFixed(1)}% {t(locale, "an.funnel.ofPrevious")}
                    {worst && <b> · {t(locale, "an.funnel.largestLoss")}</b>}
                  </>
                ) : (
                  <span className="gt-muted">{t(locale, "an.funnel.first")}</span>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
