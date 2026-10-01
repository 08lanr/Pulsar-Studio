import { attributionOf, defaultSalesLaunchSettings, defaultWebsitePurchaseSettings, launchShape, type LaunchSettings } from "@/lib/tiktok/settings";

export type BuiltInPreset = "__default_website__" | "__default_sales__" | "";

/**
 * Which built-in preset the launch editor's settings are, so the preset menu shows it as chosen: the Website
 * purchases default (the TikTok default since 2026-09-23) or the 1 Geo Sales Instant Page default, recognised by the
 * fields each default sets, read from the default itself. Start paused is the launch's own switch and not part of a
 * preset. 2026-10-01: both defaults turned comments on (8746737) while this still asked for comments off, so choosing
 * either one snapped the menu back to "Custom". Custom audiences (2026-10-01) are the launch's own, like start
 * paused: never in a preset, and not read here.
 */
export function builtInPresetOf(value: LaunchSettings): BuiltInPreset {
  const websiteDefault = defaultWebsitePurchaseSettings();
  const isWebsiteDefault = launchShape(value) === "website_purchases" && value.location_ids.join(",") === websiteDefault.location_ids.join(",") && value.age_groups.join(",") === websiteDefault.age_groups.join(",") && value.gender === websiteDefault.gender && !value.languages.length && value.operating_systems.join(",") === websiteDefault.operating_systems.join(",") && value.placement === websiteDefault.placement && value.budget_mode === websiteDefault.budget_mode && value.daily_budget_usd === websiteDefault.daily_budget_usd && value.schedule_start === null && value.schedule_end === null && value.duration_days === null && value.duplicate_copies === 0 && value.optimization_event === websiteDefault.optimization_event && value.bid_strategy === websiteDefault.bid_strategy && value.pacing === websiteDefault.pacing && value.comments_disabled === websiteDefault.comments_disabled && value.call_to_action === websiteDefault.call_to_action && JSON.stringify(attributionOf(value)) === JSON.stringify(attributionOf(websiteDefault));
  if (isWebsiteDefault) return "__default_website__";
  const salesDefault = defaultSalesLaunchSettings();
  const isSalesDefault = launchShape(value) === "instant_page" && value.location_ids.join(",") === salesDefault.location_ids.join(",") && !value.age_groups.length && value.gender === salesDefault.gender && !value.languages.length && !value.operating_systems.length && value.placement === "tiktok" && value.budget_mode === "BUDGET_MODE_DAY" && value.schedule_start === null && value.schedule_end === null && value.duration_days === null && value.duplicate_copies === 0 && value.optimization_goal === "CONVERT" && value.bid_strategy === "COST_CAP" && value.bid_usd === 0.20 && value.pacing === salesDefault.pacing && value.comments_disabled === salesDefault.comments_disabled && value.call_to_action === salesDefault.call_to_action;
  return isSalesDefault ? "__default_sales__" : "";
}
