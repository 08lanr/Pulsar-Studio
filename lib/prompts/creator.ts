// The two model passes of creator accounts (decision 2026-10-12): three caption
// options for a post, and one reply to a comment, both written in the
// creator's own voice from her character bible (`persona`). The rules the
// schema cannot express are `check`s, so a model answer that breaks one gets
// the repair turn (lib/llm.ts) and, if it still breaks it, never reaches a
// post or a comment: the caller re-checks with the same functions.

import { z } from "zod";
import type { CreatorPersona } from "@/lib/creators/types";
import { replyProblem } from "@/lib/creators/reply-policy";
import { captionIssues, hashtagsOf } from "@/lib/creators/validate";

export const CREATOR_CAPTIONS_PROMPT_VERSION = "creator-captions-v1";
export const CREATOR_REPLY_PROMPT_VERSION = "creator-reply-v1";
export const CAPTION_OPTION_MAX = 600;
export const CAPTION_HASHTAGS_MAX = 3;

const EMPLOYER_OR_CREDENTIAL = /\b(i\s+work\s+(at|for)|my\s+(company|employer|firm)\b|cfa|cpa|cfp|financial\s+advis[oe]r|(analyst|banker|associate|trader)\s+at|goldman|morgan\s+stanley|jp\s*morgan|blackrock|wells\s+fargo|citi(bank|group)?|deloitte|kpmg|pwc|mckinsey)\b/i;
const LINKISH = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|ly|co|me|link)\b)/i;
const NATURE = /\b(as\s+an\s+ai|i'?m\s+(an?\s+)?(ai|bot|robot)|i'?m\s+(a\s+)?(real|human))\b/i;

/** Why a caption option may not be offered, or null. Pure. */
export function captionOptionProblem(caption: string): string | null {
  const text = caption.trim();
  if (!text) return "an option is empty";
  if (text.length > CAPTION_OPTION_MAX) return `an option is longer than ${CAPTION_OPTION_MAX} characters`;
  if (hashtagsOf(text).length > CAPTION_HASHTAGS_MAX) return `an option has more than ${CAPTION_HASHTAGS_MAX} hashtags`;
  const issue = captionIssues(text)[0];
  if (issue) return issue;
  if (LINKISH.test(text)) return "an option contains a link";
  if (EMPLOYER_OR_CREDENTIAL.test(text)) return "an option names an employer or a credential";
  if (NATURE.test(text)) return "an option says what she is (human, real or AI)";
  return null;
}

function personaBlock(name: string, handle: string, p: CreatorPersona): string {
  const list = (label: string, items: string[]) => (items.length ? `${label}:\n${items.map(i => `- ${i}`).join("\n")}` : "");
  return [
    `You are writing as ${name} (@${handle}) on Instagram.`,
    p.summary && `Who she is: ${p.summary}`,
    p.age ? `Age: ${p.age}` : "",
    p.city && `City: ${p.city}`,
    p.interests.length ? `Interests: ${p.interests.join(", ")}` : "",
    p.voice && `Voice: ${p.voice}`,
    list("Always", p.do),
    list("Never", p.dont),
    list("Never talk about", p.banned_topics),
  ].filter(Boolean).join("\n");
}

const HARD_RULES = `HARD RULES (never broken)
- Never mention CrazyDramas, any app, show, brand deal or link.
- Never name a real employer, a job title at a real company, or a professional credential; "work", "the office" and "after work" are fine.
- Never say or hint whether you are human, real, a bot or AI.
- No links. No @mentions.`;

// ---- captions ----------------------------------------------------------------------

export const CaptionOptionsSchema = z.object({
  options: z.array(z.object({
    caption: z.string().min(1).max(CAPTION_OPTION_MAX).describe("The whole caption as it would be posted: short, natural, a few lowercase lines are fine, 0-3 relevant hashtags at the end or none"),
  })).length(3).describe("Three different options"),
});
export type CaptionOptionsOutput = z.infer<typeof CaptionOptionsSchema>;

export type CaptionInput = {
  name: string;
  handle: string;
  persona: CreatorPersona;
  kind: "image" | "carousel" | "reel";
  /** What is in each picture or video, in post order. */
  media: string[];
  /** Her latest captions, newest first: the voice to match and the openings not to repeat. */
  recent: string[];
  notes: string | null;
};

export function buildCaptionOptions(input: CaptionInput) {
  const system = `${personaBlock(input.name, input.handle, input.persona)}

You write Instagram captions for her own posts. She is a person posting her life, not a brand: no calls to action, no "link in bio", no questions fishing for engagement in every caption, no "Here's" or "Just" openings, no inspirational-quote tone.

WRITE three different caption options for the post described. Each one:
- sounds like her latest captions (the voice reference below), the same casing and emoji habits;
- is short: one to three short lines, a few lowercase lines are fine;
- says something specific about what is in the post, never a generic line that fits any photo;
- has 0 to ${CAPTION_HASHTAGS_MAX} relevant hashtags at the end, or none (none is often best);
- does not reuse an opening, a joke or an emoji pattern from her recent captions.

${HARD_RULES}

Answer by calling the tool.`;
  const media = input.media.map((m, i) => `${input.media.length > 1 ? `${i + 1}. ` : ""}${m || "(no description)"}`).join("\n");
  const user = [
    `Post type: ${input.kind === "carousel" ? `a carousel of ${input.media.length}` : input.kind === "reel" ? "a Reel (video)" : "one photo"}`,
    "",
    "WHAT IS IN IT",
    media,
    "",
    "HER RECENT CAPTIONS (newest first; match the voice, never repeat them)",
    input.recent.length ? input.recent.map(c => `- ${c.replace(/\s+/g, " ").slice(0, 300)}`).join("\n") : "(none yet)",
    ...(input.notes ? ["", `NOTES FROM THE TEAM: ${input.notes}`] : []),
    "",
    "Write the three options.",
  ].join("\n");
  return {
    name: "caption_options",
    description: "Record three caption options for the post.",
    system: [{ text: system, cache: false }],
    user,
    schema: CaptionOptionsSchema,
    maxTokens: 1200,
    effort: "low" as const,
    prompt_version: CREATOR_CAPTIONS_PROMPT_VERSION,
    check: (out: CaptionOptionsOutput) => {
      for (const o of out.options) { const p = captionOptionProblem(o.caption); if (p) return `Rewrite: ${p}`; }
      if (new Set(out.options.map(o => o.caption.trim().toLowerCase())).size < 3) return "The three options must differ";
      return null;
    },
  };
}

// ---- replies -------------------------------------------------------------------------

export const ReplyDraftSchema = z.object({
  decision: z.enum(["reply", "skip", "flag"]).describe("reply: answer it; skip: nothing worth answering; flag: a person must look (anything the rules say never to answer)"),
  reason: z.string().min(1).max(200).describe("A few words on why"),
  reply: z.string().max(150).nullable().describe("The reply when decision is reply: ONE short sentence; else null"),
});
export type ReplyDraftOutput = z.infer<typeof ReplyDraftSchema>;

export type ReplyInput = {
  name: string;
  handle: string;
  persona: CreatorPersona;
  caption: string;
  username: string;
  comment: string;
  /** Her latest sent replies, so this one does not sound like them. */
  recent: string[];
};

export function buildReplyDraft(input: ReplyInput) {
  const system = `${personaBlock(input.name, input.handle, input.persona)}

Someone commented on one of her Instagram posts. Decide whether she answers, and if she does, write her reply.

A REPLY IS
- one short sentence, the way she would type it on her phone; lowercase-casual is fine, at most one or two emoji;
- an answer to what they actually said (a question gets an answer, a compliment gets a warm thanks with a small specific touch);
- in the commenter's language (Spanish comment, Spanish reply);
- different from her recent replies below.

DECIDE "flag" (a person handles it, she never answers) when the comment asks whether she is real, human, AI, a bot or fake; is sexual; involves anyone under 18; is hostile or harassing; asks to meet, for contact details, about money or investing, or to DM.
DECIDE "skip" when there is nothing to answer (spam, a stray word, a conversation between other people).

${HARD_RULES}
- No hashtags in a reply.

Answer by calling the tool.`;
  const user = [
    `Her post's caption: ${input.caption.replace(/\s+/g, " ").slice(0, 500) || "(no caption)"}`,
    `Comment from @${input.username}: ${input.comment.replace(/\s+/g, " ").slice(0, 600)}`,
    "",
    "HER RECENT REPLIES (do not sound like these)",
    input.recent.length ? input.recent.map(r => `- ${r}`).join("\n") : "(none yet)",
  ].join("\n");
  return {
    name: "comment_reply",
    description: "Record the decision on this comment and, when she replies, the reply.",
    system: [{ text: system, cache: false }],
    user,
    schema: ReplyDraftSchema,
    maxTokens: 500,
    effort: "low" as const,
    prompt_version: CREATOR_REPLY_PROMPT_VERSION,
    check: (out: ReplyDraftOutput) => {
      if (out.decision !== "reply") return out.reply ? "When the decision is not reply, reply must be null" : null;
      if (!out.reply) return "A reply decision needs the reply";
      const p = replyProblem(out.reply);
      return p ? `Rewrite: ${p}` : null;
    },
  };
}
