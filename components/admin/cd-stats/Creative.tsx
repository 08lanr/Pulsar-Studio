import Info from "@/components/admin/cd-stats/Info";
import type { AdFormat } from "@/lib/ad-formats";
import type { CompareAd, GapReason } from "@/lib/crazydramas/stats-ads";

// Pieces the Campaigns and Buyers tabs share (decision 2026-09-26), for server and client components alike (no
// hooks here: the caller passes its translate function): which clip an ad played, and why TikTok's purchases
// and ours differ.

type Tt = (k: string, v?: Record<string, string | number>) => string;

/** A still of the clip: the video's first frames, loaded only as far as its first picture. */
export function Thumb({ src, className = "cdc-thumb" }: { src: string | null; className?: string }) {
  if (!src) return <span className={`${className} is-empty`} aria-hidden />;
  return <video className={className} src={`${src}#t=0.5`} preload="metadata" muted playsInline aria-hidden tabIndex={-1} />;
}

/** The clip an ad played: still, ad-type pill, its words, and the TikTok id in grey. */
export function CreativeLabel({ ad, media, href, tt }: { ad: { ad_id: string; creative: CompareAd["creative"] }; media: string | null; href?: string; tt: Tt }) {
  const c = ad.creative;
  const words = c?.text ?? c?.file_name ?? tt("cdc.ad.unknown");
  const body = (
    <>
      <Thumb src={media} />
      <span className="cdc-creative-text">
        <span className="cdc-creative-top">
          <FormatPill format={c?.ad_format ?? null} tt={tt} />
          <span className="cdc-words">{words}</span>
        </span>
        <span className="cdc-id">{tt("cdc.ad.id", { id: ad.ad_id })}</span>
      </span>
    </>
  );
  return href ? (
    <a className="cdc-creative" href={href}>
      {body}
    </a>
  ) : (
    <span className="cdc-creative">{body}</span>
  );
}

export function FormatPill({ format, tt }: { format: AdFormat | null; tt: Tt }) {
  if (!format) return <span className="pill pill-neutral cdc-pill cdc-pill-none">{tt("cdc.type.none")}</span>;
  return (
    <span className={`pill pill-accent cdc-pill cdc-pill-${format}`} title={tt(`adFormat.${format}.desc`)}>
      {tt(`adFormat.${format}`)}
    </span>
  );
}

export function reasonText(r: GapReason, tt: Tt): string {
  switch (r.code) {
    case "not_purchases":
      return tt("cdc.why.not_purchases", { goal: tt(`cdc.goal.${r.goal}`) });
    case "untagged":
      return tt(r.n === 1 ? "cdc.why.untagged1" : "cdc.why.untagged", { n: r.n });
    default:
      return tt(`cdc.why.${r.code}`);
  }
}

export function Reasons({ reasons, tt }: { reasons: GapReason[]; tt: Tt }) {
  if (!reasons.length) return null;
  return (
    <span className="cdc-reasons">
      {reasons.map((r) => (
        <span key={r.code} className={`cdc-chip cdc-chip-${r.code}`}>
          {reasonText(r, tt)}
          {r.code === "tiktok_higher" && <Info text={tt("cdc.why.info")} label={tt("cdx.about", { what: tt("cdc.col.tiktok") })} />}
        </span>
      ))}
    </span>
  );
}
