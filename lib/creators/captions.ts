// The caption writer (decision 2026-10-12): three caption options for a creator
// post, written from the media's descriptions, the character bible and her
// latest captions (the voice reference: lowercase, soft, emoji-light on
// @chloelin.diary, whose first post was made by hand), plus optional notes.
//
// The rules every model call follows (CLAUDE.md): a studio.jobs row of kind
// `creator_captions` with usage and cost_cents, the answer validated with zod
// and the caption rules (lib/prompts/creator.ts) before anyone sees it,
// ADS_TEXT_PROVIDER's fast tier. Fixture mode (demo replay) answers canned
// options and calls nothing; with no key the answer says so and offers none.
// Idempotent per request: the key is the inputs' hash and the attempt, so the
// same "Write captions" press is answered from its row and the next attempt
// asks again.

import { createHash } from "node:crypto";
import { systemSession, type Session } from "@/lib/auth";
import { demoReplayActive } from "@/lib/data-source";
import { getData } from "@/lib/data";
import { invalid } from "@/lib/data/errors";
import { runJob } from "@/lib/jobs";
import { KEY_VAR, LlmUnavailableError, adsTextProvider, callStructured, isLlmAvailable, modelFor, type LlmProvider } from "@/lib/llm";
import { CREATOR_CAPTIONS_PROMPT_VERSION, CaptionOptionsSchema, buildCaptionOptions, captionOptionProblem, type CaptionOptionsOutput } from "@/lib/prompts/creator";
import { metaPublishTransport } from "@/lib/meta";
import type { CreatorAccount, CreatorMedia, CreatorPostKind } from "./types";

export const CAPTIONS_JOB_KIND = "creator_captions" as const;
export const RECENT_CAPTIONS = 12;

export type CaptionRequest = {
  account: string;
  kind: CreatorPostKind;
  media_ids: string[];
  notes?: string | null;
  /** 1 for the first press; each "Write again" is the next attempt. */
  attempt?: number;
};
export type CaptionReply = { status: "drafted" | "reused" | "demo" | "unavailable"; options: string[]; note: string | null };

export type CaptionOptions = { call?: typeof callStructured; provider?: LlmProvider };

/** The canned answer of fixture mode: plain, lowercase, built from the first description. */
export function cannedCaptions(media: CreatorMedia[]): string[] {
  const first = (media[0]?.description || "a quiet moment").replace(/[.\s]+$/, "").toLowerCase();
  const short = first.split(/[,;]| with | in /)[0].trim().slice(0, 60) || "today";
  return [
    `${short} 🤍`,
    `little things lately\n${short}`,
    `saving this one for a slow day`,
  ];
}

/**
 * Her latest captions, newest first: Studio's own posts and, when they are
 * fewer than twelve, what the account itself shows (posts made by hand count —
 * they are the voice). A failed read leaves Studio's alone.
 */
export async function recentCaptions(account: CreatorAccount): Promise<string[]> {
  const posts = (await getData().listCreatorPosts(systemSession(), { account_id: account.id }))
    .filter(p => ["published", "scheduled", "publishing"].includes(p.status) && p.caption.trim())
    .sort((a, b) => (b.published_at ?? b.scheduled_at ?? b.created_at).localeCompare(a.published_at ?? a.scheduled_at ?? a.created_at))
    .map(p => p.caption.trim());
  if (posts.length < RECENT_CAPTIONS) {
    try {
      const transport = account.page_id ? metaPublishTransport().forPage(account.page_id) : metaPublishTransport();
      const listed = await transport.get(`${account.instagram_id}/media`, { fields: "id,caption,timestamp", limit: RECENT_CAPTIONS });
      for (const row of Array.isArray(listed.data) ? (listed.data as { caption?: unknown }[]) : []) {
        const caption = typeof row.caption === "string" ? row.caption.trim() : "";
        if (caption && !posts.includes(caption)) posts.push(caption);
      }
    } catch { /* Studio's own captions are enough to go on */ }
  }
  return posts.slice(0, RECENT_CAPTIONS);
}

/** The caller checked who may ask (any staff member; the MCP tool is the same). Never returns the job or its cost. */
export async function writeCaptionOptions(session: Session, req: CaptionRequest, opts: CaptionOptions = {}): Promise<CaptionReply> {
  const data = getData();
  const account = await data.getCreatorAccount(session, req.account);
  const library = await data.listCreatorMedia(session, account.id);
  const media = req.media_ids.map(id => library.find(m => m.id === id || m.external_id === id));
  if (!media.length || media.some(m => !m)) throw invalid("Pick media from this account's library.");
  const picked = media as CreatorMedia[];
  if (demoReplayActive() && !opts.call) return { status: "demo", options: cannedCaptions(picked), note: "Demo mode: sample captions, no model was called." };
  const provider = opts.provider ?? adsTextProvider();
  if (!opts.call && !isLlmAvailable(provider)) {
    return { status: "unavailable", options: [], note: `No ${provider} key on this server (${KEY_VAR[provider]}), so Studio did not write captions; write one here.` };
  }
  const recent = await recentCaptions(account);
  const notes = req.notes?.trim() || null;
  const call = buildCaptionOptions({
    name: account.display_name, handle: account.handle, persona: account.persona, kind: req.kind,
    media: picked.map(m => [m.description, m.tags.length ? `(tags: ${m.tags.join(", ")})` : ""].filter(Boolean).join(" ")), recent, notes,
  });
  const attempt = Math.max(1, Math.floor(req.attempt ?? 1));
  const hash = createHash("sha256").update(JSON.stringify([req.kind, picked.map(m => [m.id, m.description, m.tags]), recent, notes, account.persona])).digest("hex").slice(0, 16);
  const model = modelFor(provider, "fast");
  const invoke = opts.call ?? callStructured;
  try {
    const r = await runJob<CaptionOptionsOutput>(systemSession(), {
      kind: CAPTIONS_JOB_KIND, title_id: null, target_type: "creator_account", target_id: account.id,
      idempotency_key: `creator_captions:${CREATOR_CAPTIONS_PROMPT_VERSION}:${account.id}:${hash}:a${attempt}`,
      provider, model,
      input: { account: account.external_id, media: picked.map(m => m.external_id), kind: req.kind, recent: recent.length, notes: !!notes, attempt, prompt_version: CREATOR_CAPTIONS_PROMPT_VERSION },
      run: async () => {
        const res = await invoke({ ...call, provider, model });
        return { output: res.data, usage: res.usage, cost_cents: res.cost_cents, model: res.model, provider: res.provider };
      },
    });
    const valid = CaptionOptionsSchema.safeParse(r.output);
    if (!valid.success) throw new Error("the caption options do not validate");
    const options = valid.data.options.map(o => o.caption.trim()).filter(c => !captionOptionProblem(c));
    return { status: r.skipped ? "reused" : "drafted", options, note: options.length < 3 ? "An option broke a caption rule and was left out." : null };
  } catch (e) {
    if (e instanceof LlmUnavailableError) return { status: "unavailable", options: [], note: e.message };
    throw e;
  }
}
