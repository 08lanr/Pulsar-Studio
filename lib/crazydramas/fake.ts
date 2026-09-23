// The crazydramas fake (plan A2): a deterministic catalog that mirrors the
// fixture workspace under tests/fixtures/workspace — the READY film there is
// `fixture-film` (three episodes of 120, 150 and 180 frames at 30 fps, which
// is what the import's `ffprobe -count_packets` measures on cut/eps) — so
// fixture mode and the e2e server show every chip state with no network.
// The six fixture slugs:
//
//   fixture-film              live, complete, every episode "same length"
//   fixture-film-partial      episode 3 is not on crazydramas
//   fixture-film-differs      episode 1 is one older render (+3, "close"), episode 2 is another length
//   fixture-film-processing   episode 3 is still processing on Mux
//   fixture-film-draft        404: a draft (or nothing uploaded — the public API cannot tell)
//   fixture-film-broken       the series read fails (in the catalog, unreadable)
//
// plus the three real series that match no Studio title today, with their
// placeholder posters, so the staff mirror has something to list. Nothing
// here is a credential and nothing reaches a network — the posters are two
// SVGs under public/crazydramas-fake/, served by the app itself, so the
// browser's <img> never asks crazydramas.com in fixture mode or e2e; the
// fake never holds a playback id or a thumbnail URL either.

import type { PlatformDrama, PlatformEpisode } from "@/lib/types";
import { CrazydramasApiError, type CrazydramasTransport } from "./transport";
import { type CatalogEntry, isMockSlug, type SeriesRead } from "./types";

/** (frames + MUX_FRAME_OFFSET) / fps to three decimals, the way Mux reports a length. */
const muxLength = (frames: number, fps = 30, offset = 2) => Math.round(((frames + offset) / fps) * 1000) / 1000;

/** The fixture film's frame counts, as ffprobe counts them on tests/fixtures/workspace/low-quality/fixture-film/cut/eps. */
const FIXTURE_FRAMES = [120, 150, 180];

/** Same-origin stand-ins for the platform's poster art; the `-placeholder` name keeps `poster_placeholder` true for the three real series. */
export const FAKE_POSTER_URL = "/crazydramas-fake/poster.svg";
export const FAKE_PLACEHOLDER_POSTER_URL = "/crazydramas-fake/poster-placeholder.svg";

function drama(id: string, slug: string, title: string, episodeCount: number, placeholder = false): PlatformDrama {
  return {
    id,
    slug,
    title,
    status: "published",
    language: "en",
    free_episode_count: Math.min(5, episodeCount),
    series_price_cents: 999,
    iap_product_id: `crazydrama.series.${slug.replace(/-/g, "_")}`,
    poster_url: placeholder ? FAKE_PLACEHOLDER_POSTER_URL : FAKE_POSTER_URL,
    poster_blurhash: "LIDuMMRk9G=_}=ay-QxZr;xZ={NG",
    episode_count: episodeCount,
    cta_mode: "web_checkout",
  };
}

function episodes(durations: (number | null)[], statuses: string[] = []): PlatformEpisode[] {
  return durations.map((duration_s, i) => ({ n: i + 1, duration_s, status: statuses[i] ?? "ready", is_published: true }));
}

type FakeSeries = { drama: PlatformDrama; episodes: PlatformEpisode[]; inCatalog: boolean; fails?: boolean };

const SERIES: FakeSeries[] = [
  {
    drama: drama("f1000000-0000-4000-8000-000000000001", "fixture-film", "Fixture Film", 3),
    episodes: episodes(FIXTURE_FRAMES.map((f) => muxLength(f))),
    inCatalog: true,
  },
  {
    drama: drama("f1000000-0000-4000-8000-000000000002", "fixture-film-partial", "Fixture Film (partial)", 2),
    episodes: episodes(FIXTURE_FRAMES.slice(0, 2).map((f) => muxLength(f))),
    inCatalog: true,
  },
  {
    drama: drama("f1000000-0000-4000-8000-000000000003", "fixture-film-differs", "Fixture Film (differs)", 3),
    episodes: episodes([muxLength(FIXTURE_FRAMES[0], 30, 3), 5.5, muxLength(FIXTURE_FRAMES[2])]),
    inCatalog: true,
  },
  {
    drama: drama("f1000000-0000-4000-8000-000000000004", "fixture-film-processing", "Fixture Film (processing)", 3),
    episodes: episodes([muxLength(FIXTURE_FRAMES[0]), muxLength(FIXTURE_FRAMES[1]), null], ["ready", "ready", "processing"]),
    inCatalog: true,
  },
  {
    drama: drama("f1000000-0000-4000-8000-000000000006", "fixture-film-broken", "Fixture Film (unreadable)", 3),
    episodes: [],
    inCatalog: true,
    fails: true,
  },
  // The three live series with no Studio title (plan A4, the staff mirror), as the catalog listed them on 2026-09-23.
  {
    drama: drama("ad79296b-e500-4a7b-a53a-bf0af576bc46", "he-mocked-her-crush-on-him-and-sent-her", "He Mocked Her Crush on Him and Sent Her", 25, true),
    episodes: episodes(Array.from({ length: 25 }, (_, i) => 90 + (i % 7) * 5.1)),
    inCatalog: true,
  },
  {
    drama: drama("cd441acd-4269-41e3-83ec-e3cc43c25859", "he-treated-our-love-like-a-prank", "He Treated Our Love Like a Prank", 28, true),
    episodes: episodes(Array.from({ length: 28 }, (_, i) => 88 + (i % 5) * 6.2)),
    inCatalog: true,
  },
  {
    drama: drama("3eac5840-6c66-4e47-a8e5-32cefa9cb49e", "ever-since-i-played-that-game-paranormal", "Ever Since I Played That Game (Paranormal)", 60, true),
    episodes: episodes(Array.from({ length: 60 }, (_, i) => 95 + (i % 9) * 3.3)),
    inCatalog: true,
  },
];

/** The fixture transport: every read answers from the table above, in order, with no network. */
export class FakeCrazydramasTransport implements CrazydramasTransport {
  readonly mode = "fake" as const;
  readonly calls: { what: "catalog" | "series"; slug?: string }[] = [];
  /** Tests: make the next catalog read fail. */
  failCatalogOnce = false;

  reset(): void {
    this.calls.length = 0;
    this.failCatalogOnce = false;
  }

  async catalog(): Promise<CatalogEntry[]> {
    this.calls.push({ what: "catalog" });
    if (this.failCatalogOnce) {
      this.failCatalogOnce = false;
      throw new CrazydramasApiError("crazydramas did not answer (timeout, DNS or a refused connection).");
    }
    return SERIES.filter((s) => s.inCatalog).map((s) => ({ ...s.drama }));
  }

  async series(slug: string): Promise<SeriesRead> {
    this.calls.push({ what: "series", slug });
    const found = SERIES.find((s) => s.drama.slug === slug);
    if (!found || isMockSlug(slug)) return { http_status: 404, drama: null, episodes: null };
    if (found.fails) throw new CrazydramasApiError("crazydramas answered HTTP 502.", 502);
    return { http_status: 200, drama: { ...found.drama }, episodes: found.episodes.map((e) => ({ ...e })) };
  }
}

/** The fixture slugs, for the e2e specs and the docs: one per chip state. */
export const FAKE_SLUGS = {
  complete: "fixture-film",
  partial: "fixture-film-partial",
  differs: "fixture-film-differs",
  processing: "fixture-film-processing",
  draft: "fixture-film-draft",
  broken: "fixture-film-broken",
} as const;

// One instance per process (Next bundles lib/ per route): parked on globalThis like the TikTok fake.
const holder = globalThis as unknown as { __studioCrazydramasFake?: FakeCrazydramasTransport };
export const fakeCrazydramasTransport: FakeCrazydramasTransport = holder.__studioCrazydramasFake ??= new FakeCrazydramasTransport();
