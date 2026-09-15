// Ad angles (decision 2026-09-14, "angles, clips and a budget-gated pick"):
// every ad a producer can run belongs to an angle. An angle says how its
// material is produced, what it needs from the title, and the minimum
// budget one ad of that angle needs to learn anything. Direct clips are the
// first angle with an engine (lib/clips/*); narration is registered so the
// campaign page can show where the product is going, but it has no engine
// yet and nothing can pick it.
//
// The budget rule is deliberately simple and pure: a campaign's approved
// ads each reserve their angle's minimum, and the approver cannot freeze a
// manifest whose reservations exceed the experiment budget. Nothing here
// spends money; the launch engine still sets the ad group budget to the
// approved experiment budget exactly (lib/tiktok/launch.ts).

import type { PromoCreative, PromoCreativeKind } from "@/lib/types";

export type AngleId = "direct_clip" | "narration";
export type AngleStatus = "active" | "coming_soon";

export type Angle = {
  id: AngleId;
  status: AngleStatus;
  /** USD one ad of this angle needs at minimum to be worth running. */
  min_budget_usd: number;
  /** What the title must have before this angle can produce anything. */
  needs: Array<"video" | "approved_english">;
};

export const ANGLES: Record<AngleId, Angle> = {
  direct_clip: { id: "direct_clip", status: "active", min_budget_usd: 50, needs: ["video"] },
  narration: { id: "narration", status: "coming_soon", min_budget_usd: 50, needs: ["video", "approved_english"] },
};

export const ANGLE_ORDER: AngleId[] = ["direct_clip", "narration"];

/** The one budget floor everywhere (create, edit, pick): one ad of the cheapest active angle. */
export const MIN_BUDGET_USD = Math.min(...ANGLE_ORDER.filter((a) => ANGLES[a].status === "active").map((a) => ANGLES[a].min_budget_usd));

/**
 * The angle a creative row belongs to. The legacy concept kinds (ugc_*)
 * are placeholders the fixed-offset fallback still produces; they are cut
 * from the episode like a direct clip and reserve the same minimum.
 */
export function angleOf(kind: PromoCreativeKind): AngleId {
  switch (kind) {
    case "direct_clip":
    case "ugc_story":
    case "ugc_reaction":
      return "direct_clip";
  }
}

export type BudgetCheck = {
  /** USD the chosen ads reserve together. */
  reserved_usd: number;
  /** How many ads of the cheapest active angle the budget covers. */
  covers: number;
  chosen: number;
  ok: boolean;
};

/** Pure: do the chosen (approved) creatives fit the experiment budget? */
export function budgetCheck(creatives: Pick<PromoCreative, "kind" | "status">[], budgetUsd: number | null | undefined): BudgetCheck {
  const chosen = creatives.filter((c) => c.status === "approved");
  const reserved_usd = chosen.reduce((sum, c) => sum + ANGLES[angleOf(c.kind)].min_budget_usd, 0);
  const cheapest = Math.min(...ANGLE_ORDER.filter((a) => ANGLES[a].status === "active").map((a) => ANGLES[a].min_budget_usd));
  const budget = budgetUsd ?? 0;
  return { reserved_usd, covers: Math.max(0, Math.floor(budget / cheapest)), chosen: chosen.length, ok: reserved_usd <= budget };
}

/** The sentence the data layer throws when the pick is over budget. */
export function overBudgetMessage(check: BudgetCheck, budgetUsd: number): string {
  return `the budget of $${budgetUsd} covers ${check.covers} ad(s) at $${ANGLES.direct_clip.min_budget_usd} each; ${check.chosen} are chosen — unselect ${check.chosen - check.covers} or raise the budget`;
}
