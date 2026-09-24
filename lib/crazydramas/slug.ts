// The two slug rules, pure and client-safe, so the launch screens and the
// TikTok ad link (lib/tiktok/ad-url.ts) test a slug with the very rule the
// crazydramas reads use. lib/crazydramas/types.ts re-exports both; nothing
// here may import a server module.

/** A crazydramas slug: lowercase words joined by hyphens (`forced-to-marry-the-mafia-boss`). */
export const CRAZYDRAMAS_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Series the edge cache mixes into the catalog for design work; never real. */
export function isMockSlug(slug: string): boolean {
  return slug.startsWith("mock-");
}
