"use client";

// One ad, drawn once (docs/launch-ux-round-2.md §1.6 and §2.1). Step 3's chosen
// list, the preview table's content cell and the confirm dialog all render this
// component, so the four surfaces can never describe the same ad differently.
//
// Nothing here leads with an identifier: the thumbnail, the platform and the
// words the ad will carry come first, and the id lives in `title=` and in a
// <small> that the compact form drops entirely.

import { useT } from "@/components/locale";
import type { ContentKind, MetaPlatform } from "@/lib/launch/types";

export type AdCardPlatform = MetaPlatform | "tiktok";
export type AdCardProps = {
  platform: AdCardPlatform;
  /** Both platforms of a clip that runs on Facebook and Instagram alike. */
  platforms?: AdCardPlatform[];
  kind: ContentKind;
  label: string;
  caption: string | null;
  headline?: string | null;
  thumbnail_url: string | null;
  media_url?: string | null;
  permalink?: string | null;
  id: string;
  compact?: boolean;
};

const PLATFORM_WORD: Record<AdCardPlatform, string> = { facebook: "Facebook", instagram: "Instagram", tiktok: "TikTok" };

export default function AdCard({ platform, platforms, kind, label, caption, headline, thumbnail_url, media_url, permalink, id, compact = false }: AdCardProps) {
  const { tt } = useT();
  const badges = platforms?.length ? platforms : [platform];
  const text = caption?.trim() ?? "";
  // A card is never nameless and never named by a provider's reference: content
  // with no words of its own is named by what it is ("Facebook post"), and the
  // reference stays in `title=` and in the <small> of the full-size card. A
  // Spark code is the exception — it is not a machine id but the one thing the
  // producer typed and must recognise, so it is the name when nothing else is.
  const kindWord = tt(`lr2.kind.${kind}`);
  const name = label?.trim() || (kind === "spark" ? id : kindWord);
  return <article className={`ad-card${compact ? " ad-card-compact" : ""}`} title={id} data-content-id={id} data-kind={kind}>
    <span className="ad-card-media" aria-hidden={!media_url && !thumbnail_url}>
      {media_url
        ? <video src={media_url} poster={thumbnail_url ?? undefined} preload="metadata" playsInline muted />
        : thumbnail_url
          ? <span className="ad-card-thumb" role="img" aria-label={name} style={{ backgroundImage: `url(${JSON.stringify(thumbnail_url)})` }} />
          : <span className="ad-card-thumb ad-card-thumb-empty">{tt("lr2.noPreview")}</span>}
    </span>
    <span className="ad-card-body">
      <span className="ad-card-badges">
        {badges.map(value => <span className={`ad-card-badge ad-card-badge-${value}`} key={value}>{PLATFORM_WORD[value]}</span>)}
        {/* When the name already is the kind word, the chip would say it twice. */}
        {name === kindWord ? null : <span className="ad-card-kind">{kindWord}</span>}
      </span>
      <strong className="ad-card-label">{name}</strong>
      {headline ? <span className="ad-card-headline">{headline}</span> : null}
      <span className={`ad-card-caption${text ? "" : " ad-card-caption-empty"}`}>{text || tt("lr2.noCaption")}</span>
      {permalink ? <a className="ad-card-link" href={permalink} target="_blank" rel="noreferrer">{tt("clipsPosting.openPost")}&nbsp;→</a> : null}
      {/* The reference stays in title= and data-content-id; printing it is noise. */}
    </span>
  </article>;
}
