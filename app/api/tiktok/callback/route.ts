// Alias of /api/admin/tiktok/callback at the shorter path a developer app
// may have registered as its redirect URI (TIKTOK_REDIRECT_URI decides which
// one the consent screen is sent). Same handler, same staff-admin check.
export { GET, dynamic } from "@/app/api/admin/tiktok/callback/route";
