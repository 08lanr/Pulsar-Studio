"use client";

// One ad, drawn once (docs/launch-ux-round-2.md §1.6 and §2.1). Step 3's chosen
// list, the preview table's content cell, the confirm dialog and the monitor all
// render this component, so the four surfaces can never describe the same ad
// differently.
//
// Nothing here leads with an identifier: the thumbnail, the platform and the
// words the ad will carry come first, and the id lives in `title=` and in a
// <small> that the compact form drops entirely.
//
// `line` is the third form, for a dense confirmation list: an ad with no picture
// and no words of its own has nothing a card can show, so it collapses to one
// row — no empty media frame, no "no text yet" placeholder — and the caller
// passes `fallbackName` ("Ad 1") so a TikTok Spark ad is named by its position
// instead of by the base64 code nobody can read.

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
  /** One dense row instead of a card, for an ad with no picture of its own. */
  line?: boolean;
  /** The name for an ad that carries no words of its own, in place of the kind word or a Spark code. */
  fallbackName?: string;
};

const PLATFORM_WORD: Record<AdCardPlatform, string> = { facebook: "Facebook", instagram: "Instagram", tiktok: "TikTok" };

export default function AdCard({ platform, platforms, kind, label, caption, headline, thumbnail_url, media_url, permalink, id, compact = false, line = false, fallbackName }: AdCardProps) {
  const { tt } = useT();
  const badges = platforms?.length ? platforms : [platform];
  const text = caption?.trim() ?? "";
  const own = label?.trim() ?? "";
  // A card is never nameless and never named by a provider's reference: content
  // with no words of its own is named by what it is ("Facebook post"), or by the
  // position the caller gives it ("Ad 1"), and the reference stays in `title=`
  // and `data-content-id`. A Spark code used to be the one exception — and a
  // base64 blob set in bold is exactly what made the confirm dialog unreadable
  // ("we dont need the spark code", 2026-09-17), so that exception is gone.
  const kindWord = tt(`lr2.kind.${kind}`);
  const name = own || fallbackName?.trim() || kindWord;
  const hasMedia = Boolean(media_url || thumbnail_url);
  // In the line form an ad with no words of its own is already named by its
  // position, so the kind chip beside it would only add a machine detail.
  const showKind = name !== kindWord && (!line || own !== "");
  return <article className={`ad-card${compact ? " ad-card-compact" : ""}${line ? " ad-card-line" : ""}`} title={id} data-content-id={id} data-kind={kind}>
    {line && !hasMedia ? null : <span className="ad-card-media" aria-hidden={!hasMedia}>
      {media_url
        ? <video src={media_url} poster={thumbnail_url ?? undefined} preload="metadata" playsInline muted />
        : thumbnail_url
          ? <span className="ad-card-thumb" role="img" aria-label={name} style={{ backgroundImage: `url(${JSON.stringify(thumbnail_url)})` }} />
          : <span className="ad-card-thumb ad-card-thumb-empty">{tt("lr2.noPreview")}</span>}
    </span>}
    <span className="ad-card-body">
      <span className="ad-card-badges">
        {badges.map(value => <span className={`ad-card-badge ad-card-badge-${value}`} key={value}>{PLATFORM_WORD[value]}</span>)}
        {/* When the name already is the kind word, the chip would say it twice. */}
        {showKind ? <span className="ad-card-kind">{kindWord}</span> : null}
      </span>
      <strong className="ad-card-label">{name}</strong>
      {headline ? <span className="ad-card-headline">{headline}</span> : null}
      {line && !text ? null : <span className={`ad-card-caption${text ? "" : " ad-card-caption-empty"}`}>{text || tt("lr2.noCaption")}</span>}
      {permalink ? <a className="ad-card-link" href={permalink} target="_blank" rel="noreferrer">{tt("clipsPosting.openPost")}&nbsp;→</a> : null}
      {/* The reference stays in title= and data-content-id; printing it is noise. */}
    </span>
  </article>;
}
