// TikTok Instant Page builder adapter. The Sales master is a captured builder
// structure from Overlord; OAuth mints the short-lived TIP SDK token. No browser
// cookie or separate account credential is used. Only this module calls the
// private builder endpoints. A create with an uncertain result must never be
// retried automatically: the caller checkpoints its intent before calling and
// the returned page ID before publishing.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { accessTokenFor, launchMode, tiktokTransport, type LaunchMode, type TikTokResponse } from "./index";
import { SALES_MASTER_SHA256 } from "./instant-page-master";

const BUILDER_BASE = "https://ads.tiktok.com";
const TIMEOUT_MS = 30_000;
type Node = Record<string, unknown>;
export type InstantPageMasterSnapshot = {
  business_type: number; template_id: string; thumbnail_uri: string;
  page_data: unknown; sha256: string;
};
export type SalesPageOptions = { trackingUrl: string; buttonText?: string; background?: "white" | "black"; handCursor?: boolean };
type WriteGuard = { assertActive: () => Promise<void> };
export type CreateInstantPageDraft = SalesPageOptions & WriteGuard & {
  advertiserId: string; pageName: string; masterSnapshot: InstantPageMasterSnapshot;
  /** Persist creating intent only after token mint and immediately before the builder write. */
  beforeCreate?: () => Promise<void>;
};
export type PublishInstantPage = WriteGuard & { advertiserId: string; pageId: string };

/** Provenance: Overlord masters/sales.json, captured 2026-07-27. */
export function loadSalesMasterSnapshot(): InstantPageMasterSnapshot {
  const bytes = readFileSync(path.join(process.cwd(), "lib", "tiktok", "masters", "sales.json"));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== SALES_MASTER_SHA256) throw new Error("Sales Instant Page master changed; review and approve the new capture.");
  const raw = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  if (raw.business_type !== 6 || typeof raw.template_id !== "string" ||
      typeof raw.thumbnail_uri !== "string" || !raw.page_data) throw new Error("Invalid Sales Instant Page master.");
  return { business_type: 6, template_id: raw.template_id, thumbnail_uri: raw.thumbnail_uri,
    page_data: raw.page_data, sha256 };
}

function nodesOf(page: unknown): [string, Node][] {
  const data = (page as { data?: unknown })?.data;
  if (!data || typeof data !== "object") return [];
  return Object.entries(data).filter(([, node]) => !!node && typeof node === "object") as [string, Node][];
}
function linked(node: Node): boolean {
  const link = node.link as { url?: unknown } | undefined;
  return typeof link?.url === "string" && /^https?:\/\//.test(link.url);
}
function ctaNode(page: unknown): Node {
  const candidates = nodesOf(page).filter(([, node]) => linked(node));
  if (candidates.length === 1) return candidates[0][1];
  const buttons = candidates.filter(([, node]) => node.name === "LpButton");
  if (buttons.length === 1) return buttons[0][1];
  const named = buttons.filter(([, node]) => /call to action/i.test(String(node.aliasName ?? "")));
  if (named.length === 1) return named[0][1];
  throw new Error("Sales Instant Page master needs exactly one identifiable call-to-action link.");
}
/** Copy and customize one campaign's CTA; never mutate the signed template. */
export function customizeSalesPage(snapshot: InstantPageMasterSnapshot, options: SalesPageOptions): unknown {
  const approved = loadSalesMasterSnapshot();
  if (snapshot.sha256 !== approved.sha256 || snapshot.business_type !== approved.business_type ||
      snapshot.template_id !== approved.template_id || snapshot.thumbnail_uri !== approved.thumbnail_uri ||
      JSON.stringify(snapshot.page_data) !== JSON.stringify(approved.page_data))
    throw new Error("Instant Page master differs from the approved Sales capture.");
  const url = new URL(options.trackingUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Instant Page destination must be an HTTP(S) URL without credentials.");
  if (!url.searchParams.get("campid")?.trim()) throw new Error("Instant Page destination needs a campaign campid.");
  const page = structuredClone(snapshot.page_data);
  const cta = ctaNode(page);
  (cta.link as Node).url = url.toString();
  if (options.buttonText) {
    const content = cta.content as Node | undefined;
    if (!content) throw new Error("Sales Instant Page call-to-action has no text field.");
    content.text = options.buttonText;
    if ("i18nKey" in content) content.i18nKey = "";
  }
  if (options.background) {
    const meta = nodesOf(page).find(([id]) => id === "meta")?.[1];
    const theme = meta?.theme as Node | undefined;
    if (theme) theme.preset = options.background === "white" ? "light" : "dark";
    for (const [, node] of nodesOf(page)) if (node.name === "LpHeader") {
      const bg = node.bgColor as Node | undefined, icon = node.initIconColor as Node | undefined;
      if (bg) bg.color = options.background === "white" ? "rgba(255,255,255,1)" : "rgba(0,0,0,1)";
      if (icon) icon.color = options.background === "white" ? "rgb(0,0,0)" : "rgb(255,255,255)";
    }
  }
  if (options.handCursor !== undefined)
    for (const [, node] of nodesOf(page)) if (node.name === "LpButton") node.gestureEnable = options.handCursor;
  return page;
}

export class InstantPageCreateUncertainError extends Error {
  constructor() { super("Instant Page creation may have succeeded without a confirmed page ID. Reconcile the page in TikTok before retrying."); this.name = "InstantPageCreateUncertainError"; }
}
export class InstantPageCreateRejectedError extends Error {
  constructor(detail: string) { super(`TikTok rejected Instant Page creation: ${detail}`); this.name = "InstantPageCreateRejectedError"; }
}
export class InstantPageCreateNotSentError extends Error {
  constructor() { super("Instant Page creation was stopped before the builder request was sent."); this.name = "InstantPageCreateNotSentError"; }
}
type BuilderResponse = { code?: number; message?: string; data?: { page_id?: unknown; err_msg?: unknown } };
function safeBuilderDetail(response: BuilderResponse | null, status?: number, secrets: string[] = []): string {
  const code = [status ? `HTTP ${status}` : null, typeof response?.code === "number" ? `code ${response.code}` : null]
    .filter(Boolean).join(", ") || "provider error";
  const raw = [response?.message, response?.data?.err_msg].filter(v => typeof v === "string").join(" — ");
  const clean = secrets.filter(Boolean).reduce((text, secret) => text.replaceAll(secret, "[redacted]"), raw)
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/[A-Za-z0-9_-]{24,}/g, "[redacted]")
    .replace(/[\r\n\t]/g, " ").slice(0, 160);
  return clean ? `${code}: ${clean}` : code;
}
export type InstantPageDependencies = {
  mode: () => LaunchMode;
  accessToken: (advertiserId: string) => string | null;
  marketingPost: (pathname: string, token: string, body: Record<string, unknown>) => Promise<TikTokResponse>;
  request: typeof fetch;
};
const realDependencies: InstantPageDependencies = {
  mode: launchMode, accessToken: accessTokenFor,
  marketingPost: (pathname, token, body) => tiktokTransport().post(pathname, token, body),
  request: fetch,
};
async function builder(pathname: string, token: string, oauth: string, body: Record<string, unknown>, create: boolean,
  deps: InstantPageDependencies): Promise<BuilderResponse> {
  const csrf = `studio${randomBytes(10).toString("hex")}`;
  let response: Response;
  try {
    response = await deps.request(`${BUILDER_BASE}${pathname}`, {
      method: "POST", headers: { "content-type": "application/json", "ix-access-token": token,
        "x-csrftoken": csrf, cookie: `csrftoken=${csrf}`, origin: BUILDER_BASE },
      body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    if (create) throw new InstantPageCreateUncertainError();
    throw new Error("Instant Page publish response was unavailable; check the saved page before retrying.");
  }
  if (!response.ok) {
    if (create && response.status >= 500) throw new InstantPageCreateUncertainError();
    const rejected = await response.json().catch(() => null) as BuilderResponse | null;
    if (create) throw new InstantPageCreateRejectedError(safeBuilderDetail(rejected, response.status, [token, oauth]));
    throw new Error(`Instant Page builder rejected publish: ${safeBuilderDetail(rejected, response.status, [token, oauth])}.`);
  }
  let parsed: BuilderResponse;
  try { parsed = await response.json() as BuilderResponse; }
  catch { if (create) throw new InstantPageCreateUncertainError(); throw new Error("Instant Page publish response was unreadable."); }
  return parsed;
}
async function tipToken(advertiserId: string, assertActive: WriteGuard["assertActive"], deps: InstantPageDependencies): Promise<{ token: string; oauth: string }> {
  const oauth = deps.accessToken(advertiserId);
  if (!oauth) throw new Error("TikTok OAuth access is unavailable for this advertiser.");
  await assertActive();
  const result = await deps.marketingPost("/oauth2/access_token/tip_sdk/create/", oauth, { advertiser_id: advertiserId });
  if (result.code !== 0) throw new Error("TikTok refused the Instant Page editor token.");
  const data = result.data ?? {};
  const token = data.tip_sdk_access_token ?? data.ix_access_token ?? data.access_token ?? data.token;
  if (typeof token !== "string" || !token) throw new Error("TikTok returned no Instant Page editor token.");
  return { token, oauth };
}
function normalizeThumbnail(uri: string): string {
  if (!/^https?:\/\//.test(uri)) return uri;
  return new URL(uri).pathname.replace(/^\/+/, "").split("~")[0];
}
function safeName(name: string): string {
  const value = name.trim();
  if (!value || value.length > 100 || !/^[a-zA-Z0-9][a-zA-Z0-9 _.-]*$/.test(value)) throw new Error("Invalid Instant Page name.");
  return value;
}

export async function createInstantPageDraft(input: CreateInstantPageDraft, deps: InstantPageDependencies = realDependencies): Promise<string> {
  const pageName = safeName(input.pageName);
  const data = customizeSalesPage(input.masterSnapshot, input);
  if (deps.mode() === "fake") {
    return `fake-tip-${createHash("sha256").update(`${input.advertiserId}:${pageName}`).digest("hex").slice(0, 20)}`;
  }
  if (deps.mode() !== "production") throw new Error("Instant Page creation is unavailable in TikTok sandbox mode.");
  const { token, oauth } = await tipToken(input.advertiserId, input.assertActive, deps);
  try { await input.assertActive(); await input.beforeCreate?.(); await input.assertActive(); }
  catch { throw new InstantPageCreateNotSentError(); }
  const response = await builder("/instant_page/api/v1/create/", token, oauth, {
    business_type: input.masterSnapshot.business_type, template_id: input.masterSnapshot.template_id,
    thumbnail_uri: normalizeThumbnail(input.masterSnapshot.thumbnail_uri), title: pageName,
    account_id: input.advertiserId, data: JSON.stringify(data),
  }, true, deps);
  if (typeof response.code !== "number") throw new InstantPageCreateUncertainError();
  if (response.code !== 0) throw new InstantPageCreateRejectedError(safeBuilderDetail(response, undefined, [token, oauth]));
  const pageId = response.data?.page_id;
  if (typeof pageId !== "string" || !/^\d{5,30}$/.test(pageId)) throw new InstantPageCreateUncertainError();
  return pageId;
}

export async function publishInstantPage(input: PublishInstantPage, deps: InstantPageDependencies = realDependencies): Promise<void> {
  if (!input.pageId) throw new Error("A saved Instant Page ID is required before publish.");
  if (deps.mode() === "fake") return;
  if (deps.mode() !== "production") throw new Error("Instant Page publish is unavailable in TikTok sandbox mode.");
  const { token, oauth } = await tipToken(input.advertiserId, input.assertActive, deps);
  await input.assertActive();
  const response = await builder(`/instant_page/api/v1/publish/${encodeURIComponent(input.pageId)}/`, token, oauth,
    { account_id: input.advertiserId }, false, deps);
  if (response.code !== 0) throw new Error(`TikTok rejected Instant Page publish: ${safeBuilderDetail(response, undefined, [token, oauth])}.`);
}
