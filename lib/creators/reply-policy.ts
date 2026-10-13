// The deterministic half of comment replies (decision 2026-10-12, "Creator
// accounts"). Pure, so the table of comments → decisions is pinned by
// tests/creator-reply-policy.test.ts without a model or a provider.
//
// `preFilter` runs before any model sees a comment and settles everything a
// rule can settle:
//   skip   nothing to answer: empty, the account's own words, too old, inside a
//          thread, a link or promotion/spam, a tag of a friend
//   flag   a person looks at it and Studio never answers: asks whether she is
//          real / AI / a bot / fake, anything sexual, anything involving
//          minors, hostile or harassing, asks to meet, for contact details,
//          about money, or to DM
//   reply  an emoji-only comment gets a short emoji back, no model
//   llm    everything else: the model drafts one reply in her voice
// `replyProblem` is the guard on every reply Studio would send, the model's
// included: it is checked as the model's repair rule and again before the
// draft is stored, so a reply that slips a rule is flagged, never sent.

export type PolicyDecision = "skip" | "flag" | "reply" | "llm";
export type PolicyResult = { decision: PolicyDecision; reason: string; reply_text?: string };

export type PolicyInput = {
  text: string;
  username: string;
  /** The account's own handle, without the @. */
  own_username: string;
  /** Set when the comment answers another comment (a thread). */
  parent_ig_id: string | null;
  commented_at: string;
  now: Date;
  window_days: number;
  /** Stable per comment (its Instagram id): picks the emoji reply, so a re-run picks the same one. */
  seed: string;
};

const LINK = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|ly|co|me|link|shop|store|xyz)\b)/i;
const PROMO = /\b(promo(te|tion)?|collab(oration)?s?|ambassador|brand deal|check (out )?my (page|profile|bio|account)|follow (me|back|for follow)|f4f|l4l|s4s|sub4sub|giveaway|forex|onlyfans|only fans|sugar ?(daddy|mommy|baby)|cheap followers|buy followers|boost your)\b/i;
const REAL = /\b(are|r)\s+(you|u)\s+(even\s+)?(real|human|a\s+bot|ai|an\s+ai|fake|a\s+robot|a\s+real\s+person)\b|\b(ai|a\.i\.|bot|robot|fake|catfish|generated|midjourney|chatgpt|deepfake|cgi|not\s+real|is\s+this\s+real|real\s+person|photoshop(ped)?)\b/i;
const SEXUAL = /\b(sex|sexy|nudes?|naked|horny|boobs?|tits|titties|ass|booty|thicc|nsfw|feet\s+pics?|lingerie|bikini\s+pics?|send\s+pics|spicy\s+pics|hot\s+body|daddy|f+u+c+k\s+me|wanna\s+(smash|bang))\b|[🍑🍆💦👅]/iu;
const MINORS = /\b(underage|under\s*18|minors?|middle\s+school|high\s+school(er)?|(i'?m|i\s+am|im)\s+(1[0-7]|[1-9])\b|(1[0-7]|[1-9])\s*(yo|y\/o|years?\s+old))\b/i;
const HOSTILE = /\b(ugly|stupid|idiot|dumb|bitch|slut|whore|hoe|kys|kill\s+(yo)?urself|die|hate\s+you|loser|trash|gross|disgusting|shut\s+up|clown|fat|retard(ed)?|cringe|pathetic|scam(mer)?)\b/i;
const MEET = /\b(meet(\s*up)?|hang\s*out|grab\s+(a\s+)?(coffee|drink|dinner|lunch)|date\s+me|go\s+out\s+with|take\s+you\s+out|where\s+(exactly\s+)?(do\s+)?(you|u)\s+live|your\s+address|come\s+over|in\s+person|irl)\b/i;
const CONTACT = /\b(phone|number|whats\s*app|telegram|snap(chat)?|e-?mail|kik|discord|wechat|line\s+id|your\s+(socials|contact)|add\s+me\s+on)\b/i;
const MONEY = /\b(money|venmo|paypal|cash\s*app|cashapp|zelle|invest(ing|ment|or)?s?|stocks?|crypto|bitcoin|btc|loan|gift\s*cards?|sponsor(ship)?|pay\s+(you|u|me)|salary|how\s+much\s+(do\s+)?(you|u)\s+(make|earn))\b|\$\s?\d/i;
const DM = /\b(dms?|pm|inbox|message\s+me|text\s+me|check\s+(your\s+)?(dms?|requests|inbox)|slide\s+into|private\s+message)\b/i;

/** Letters or digits in any script: a comment without them is emoji, punctuation or nothing. */
const WORDISH = /[\p{L}\p{N}]/u;
const MENTION = /@[A-Za-z0-9._]+/g;

const EMOJI_REPLIES = ["🤍", "🥹🤍", "☺️🤍", "🫶", "🤍🤍"] as const;
function pick<T>(list: readonly T[], seed: string): T {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return list[h % list.length];
}

/** The rule's answer for one comment. Pure. */
export function preFilter(input: PolicyInput): PolicyResult {
  const text = input.text.trim();
  const own = input.own_username.replace(/^@/, "").toLowerCase();
  if (input.username.replace(/^@/, "").toLowerCase() === own) return { decision: "skip", reason: "the account's own comment" };
  if (!text) return { decision: "skip", reason: "empty comment" };
  const age = input.now.getTime() - Date.parse(input.commented_at);
  if (Number.isFinite(age) && age > input.window_days * 86_400_000) return { decision: "skip", reason: `older than the ${input.window_days}-day reply window` };
  if (input.parent_ig_id) return { decision: "skip", reason: "a reply inside a thread; Studio answers top-level comments only" };
  if (LINK.test(text)) return { decision: "skip", reason: "contains a link" };
  if (PROMO.test(text)) return { decision: "skip", reason: "promotion or spam" };

  // The flags: a person reads these and Studio never answers them.
  if (REAL.test(text)) return { decision: "flag", reason: "asks whether she is real, AI or a bot" };
  if (MINORS.test(text)) return { decision: "flag", reason: "involves a minor" };
  if (SEXUAL.test(text)) return { decision: "flag", reason: "sexual" };
  if (HOSTILE.test(text)) return { decision: "flag", reason: "hostile or harassing" };
  if (MEET.test(text)) return { decision: "flag", reason: "asks to meet" };
  if (CONTACT.test(text)) return { decision: "flag", reason: "asks for contact details" };
  if (DM.test(text)) return { decision: "flag", reason: "asks to DM" };
  if (MONEY.test(text)) return { decision: "flag", reason: "about money" };

  // A tag with nothing but emoji beside it is two friends talking to each other.
  const withoutTags = text.replace(MENTION, "").trim();
  if (!WORDISH.test(withoutTags)) {
    if (/@[A-Za-z0-9._]+/.test(text)) return { decision: "skip", reason: "tags a friend" };
    return { decision: "reply", reason: "emoji-only comment: a short emoji back", reply_text: pick(EMOJI_REPLIES, input.seed) };
  }
  return { decision: "llm", reason: "ordinary comment" };
}

const REPLY_MAX = 150;
const SENTENCE_ENDS = /[.!?。！？]+(?=\s|$)/g;
const CLAIMS_NATURE = /\b(i'?m|i\s+am|im)\s+(a\s+)?(real|human|not\s+(a\s+|an\s+)?(bot|ai|robot|fake)|an?\s+(ai|bot|robot|real\s+person))\b|\b(ai|a\.i\.|bot|robot|chatgpt|language\s+model|generated)\b/i;
const EMPLOYER = /\b(i\s+work\s+(at|for)|my\s+(job|company|employer|firm|boss)\s+(is|at)|cfa|cpa|cfp|financial\s+advis[oe]r|(analyst|banker|associate|trader)\s+at|goldman|morgan\s+stanley|jp\s*morgan|blackrock|wells\s+fargo|citi(bank|group)?|deloitte|kpmg|pwc|mckinsey)\b/i;
const OFFERS = /\b(dm\s+me|message\s+me|text\s+me|meet\s+(up|you)|my\s+(number|snap|email))\b/i;

/** Why a reply must not be sent, or null when it may. Pure. */
export function replyProblem(reply: string): string | null {
  const text = reply.trim();
  if (!text) return "the reply is empty";
  if (text.length > REPLY_MAX) return `the reply is longer than ${REPLY_MAX} characters`;
  if ((text.match(SENTENCE_ENDS) ?? []).length > 2) return "the reply is more than one short sentence";
  if (LINK.test(text)) return "the reply contains a link";
  if (/#[\p{L}\p{N}_]/u.test(text)) return "the reply contains a hashtag";
  if (/@[A-Za-z0-9._]/.test(text)) return "the reply mentions an account";
  if (/crazy\s*dramas?/i.test(text)) return "the reply mentions CrazyDramas";
  if (CLAIMS_NATURE.test(text)) return "the reply says what she is (human, real or AI)";
  if (EMPLOYER.test(text)) return "the reply names an employer or a credential";
  if (OFFERS.test(text)) return "the reply offers contact, DMs or a meeting";
  return null;
}

/**
 * When the reply goes out: a random delay in the account's window after the
 * later of the comment and now, so a reply never lands seconds after the
 * comment and never before it. `random` is injectable for tests.
 */
export function replyDueAt(commentedAt: string, now: Date, minMinutes: number, maxMinutes: number, random: () => number = Math.random): string {
  const lo = Math.max(0, Math.min(minMinutes, maxMinutes)), hi = Math.max(lo, maxMinutes);
  const minutes = lo + (hi - lo) * random();
  const base = Math.max(now.getTime(), Date.parse(commentedAt) || now.getTime());
  return new Date(base + Math.round(minutes * 60_000)).toISOString();
}
