// Shared OAuth constants and the external-URL helper — ported from Pulsar
// Grow (lib/oauth.ts, lib/request-url.ts). Route modules may only export
// handlers, so these live here.

/** Holds the CSRF `state` between starting the TikTok authorization and the callback. httpOnly. */
export const OAUTH_STATE_COOKIE = "studio_tiktok_oauth_state";

/**
 * The app's REAL external base URL from the reverse proxy's forwarded
 * headers. Behind Caddy, req.nextUrl reports the internal bind address;
 * redirects built from it send the operator to a dead localhost URL
 * (overlord's first go-live bug). Header-only, so it is safe anywhere.
 */
export function externalBaseUrl(req: { headers: Headers; nextUrl: { protocol: string; host: string } }): string {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? req.nextUrl.host;
  const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(/:$/, "");
  return `${proto}://${host}`;
}

/** Must EXACTLY match a redirect URI registered on the TikTok developer app. */
export function redirectUriFor(req: { headers: Headers; nextUrl: { protocol: string; host: string } }): string {
  return process.env.TIKTOK_REDIRECT_URI || `${externalBaseUrl(req)}/api/admin/tiktok/callback`;
}
