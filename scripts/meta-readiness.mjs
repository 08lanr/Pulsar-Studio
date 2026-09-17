// Explicit read-only live diagnostic. Never imported by the fixture application.
// Run from Studio: node scripts/meta-readiness.mjs --live --account=4565068993810003
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const args = process.argv.slice(2);
if (!args.includes('--live')) {
  console.error('No network request made. Pass --live and --account=<numeric ad account ID>.');
  process.exit(1);
}
const account = args.find(a => a.startsWith('--account='))?.slice(10).replace(/^act_/, '');
if (!account || !/^\d+$/.test(account)) {
  console.error('A numeric --account ID is required.');
  process.exit(1);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { loadEnvConfig } = require('@next/env');
loadEnvConfig(root, true, { info() {}, error() {} });
const token = process.env.META_ACCESS_TOKEN;
if (!token?.trim()) {
  console.error('META_ACCESS_TOKEN is missing or empty. Set it in Studio .env.local.');
  process.exit(1);
}
const version = process.env.META_API_VERSION || 'v26.0';
if (!/^v\d+\.0$/.test(version)) throw new Error('Invalid META_API_VERSION.');
const base = `https://graph.facebook.com/${version}/`;

// Never emit response bodies, headers, next URLs or access tokens in diagnostics.
async function get(endpoint, params = {}) {
  const url = new URL(endpoint, base);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(25000),
      redirect: 'error',
    });
    const body = await response.json();
    if (!response.ok || body.error) {
      const code = Number(body.error?.code);
      const subcode = Number(body.error?.error_subcode);
      return { ok: false, http_status: response.status,
        code: Number.isFinite(code) ? code : null,
        subcode: Number.isFinite(subcode) ? subcode : null };
    }
    return { ok: true, body };
  } catch {
    return { ok: false, reason: 'Network, timeout or response parsing failure.' };
  }
}

async function list(endpoint, fields, pick) {
  let after;
  const rows = [];
  const cursors = new Set();
  for (let page = 0; page < 100; page++) {
    const result = await get(endpoint, { fields, limit: 100, ...(after ? { after } : {}) });
    if (!result.ok) return { ...result, rows, complete: false };
    if (!Array.isArray(result.body.data)) return { ok: false, rows, complete: false, reason: 'Unexpected list response.' };
    rows.push(...result.body.data.map(pick));
    if (!result.body.paging?.next) return { ok: true, rows, complete: true };
    after = result.body.paging?.cursors?.after;
    if (!after || cursors.has(after)) return { ok: false, rows, complete: false, reason: 'Pagination could not be completed.' };
    cursors.add(after);
  }
  return { ok: false, rows, complete: false, reason: 'Pagination safety limit reached.' };
}

const [permissions, accountResult, pages, pixels, instagram] = await Promise.all([
  list('me/permissions', 'permission,status', p => ({ permission: p.permission, status: p.status })),
  get(`act_${account}`, { fields: 'id,name,account_status,currency,timezone_name,business{id,name},disable_reason' }),
  list('me/accounts', 'id,name,tasks,instagram_business_account{id,username}', p => ({
    id: p.id, name: p.name, tasks: p.tasks || [],
    instagram_business_account: p.instagram_business_account ? {
      id: p.instagram_business_account.id, username: p.instagram_business_account.username,
    } : null,
  })),
  list(`act_${account}/adspixels`, 'id,name', p => ({ id: p.id, name: p.name })),
  list(`act_${account}/instagram_accounts`, 'id,username', p => ({ id: p.id, username: p.username })),
]);
const a = accountResult.body;
const accountSummary = accountResult.ok ? { ok: true, id: a.id, name: a.name,
  account_status: a.account_status, currency: a.currency, timezone_name: a.timezone_name,
  disable_reason: a.disable_reason,
  business: a.business ? { id: a.business.id, name: a.business.name } : null,
} : accountResult;
const required = ['ads_read', 'ads_management', 'business_management', 'pages_show_list', 'pages_read_engagement'];
const granted = new Set(permissions.rows.filter(p => p.status === 'granted').map(p => p.permission));
const missing = required.filter(p => !granted.has(p));
const readChecksPassed = [permissions, accountSummary, pages, pixels, instagram].every(r => r.ok) && missing.length === 0;
console.log(JSON.stringify({ checked_at: new Date().toISOString(), api_version: version,
  read_checks_passed: readChecksPassed, missing_permissions: missing,
  account: accountSummary, permissions, accessible_pages: pages, account_pixels: pixels,
  account_instagram: instagram,
  limits: [
    'Read checks only; no ad creation, activation or conversion events were attempted.',
    'Accessible Pages are not proof that every Page is eligible on the selected ad account.',
    'Pixel visibility does not prove CAPI write permission or installed website tracking.',
    'An empty Instagram list means no identity returned by this query, not proof none exists.',
  ],
}, null, 2));
if (!readChecksPassed) process.exitCode = 1;
