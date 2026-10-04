// The one caption rule for an organic post, pure and client-safe so the
// dialog that pre-fills the box and the server that fills it in when the
// client sends none cannot drift apart. They did: the dialog built
// `hook \n title` of its own while lib/meta/publish.ts had the real rule, so
// a fix to one never reached the posts people actually made.
//
// Hook on the first line, title (and episode) on the second — unless the title
// only says the hook again (decision 2026-10-04). A short-drama title IS a
// plot summary ("He Told Me to Flirt With His Rival. Then I Fell For Him"), so
// printing one under a hook that already told that story reads as the same
// sentence twice, which is what the first captions Studio posted did.

/** Words too common to tell two sentences apart. Anything under three letters is dropped by length. */
const STOPWORDS = new Set([
  "the", "and", "but", "for", "with", "from", "that", "this", "then", "than", "now", "not",
  "his", "her", "him", "she", "they", "them", "their", "its", "our", "your", "you", "who",
  "was", "were", "are", "has", "have", "had", "will", "would", "could", "did", "does",
  "all", "any", "one", "out", "off", "own", "too", "very", "just", "only", "into", "onto",
  "over", "after", "before", "when", "what", "why", "how", "another", "about",
]);

/** Crude suffix stripping, enough that "begged" and "begging" count as the same word. */
const stem = (word: string): string => word.replace(/(ings|ing|ed|es|s)$/, "");

const contentList = (text: string): string[] =>
  text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
    .filter(word => word.length > 2 && !STOPWORDS.has(word))
    .map(stem).filter(word => word.length > 2);

/**
 * Does the title only say the hook again? Two ways to be a restatement,
 * because one measure alone missed real cases:
 *
 *  - Most of the title's words are already in the hook. The test runs one way
 *    round on purpose: the question is whether the TITLE adds anything, so it
 *    is the title's words that must be new.
 *  - Both open on the same action. "He humiliated her for a laugh. Now he
 *    wants her back" under "He Humiliated Me in Front of the Whole School, Now
 *    He's Begging For Me Back" shares only two words of six — "wants" and
 *    "begging" are the same idea in different words — but both sentences start
 *    on the same verb, and that is enough to read as one story told twice.
 */
export function titleRestatesHook(hook: string, title: string): boolean {
  const titleWords = contentList(title);
  const hookWords = contentList(hook);
  if (!titleWords.length || !hookWords.length) return false;
  if (titleWords[0] === hookWords[0]) return true;
  const inHook = new Set(hookWords);
  const distinct = [...new Set(titleWords)];
  return distinct.filter(word => inHook.has(word)).length / distinct.length >= 0.5;
}

/** What a clip needs to carry for a caption. `hook` is already known not to be an internal reference. */
export type CaptionParts = { hook: string; title_name: string; episode_label?: string | null };

/**
 * The caption itself. A clip with no hook falls back to the title alone, and an
 * episode number always earns its line because the hook can never carry one.
 */
export function buildCaption({ hook, title_name, episode_label }: CaptionParts): string {
  const title = episode_label ? `${title_name} · Episode ${episode_label}` : title_name;
  const repeats = Boolean(hook) && !episode_label && titleRestatesHook(hook, title_name);
  return [hook, repeats ? "" : title].filter(Boolean).join("\n").trim();
}
