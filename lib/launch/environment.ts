import { dataSource } from "@/lib/data-source";
import type { LaunchProvider, LaunchRun } from "./types";

export function launchEnvironment(provider: LaunchProvider): LaunchRun["mode"] {
  if (dataSource() === "fixture") return "fake";
  return provider === "tiktok" && (process.env.TIKTOK_MODE || "sandbox").toLowerCase() !== "production" ? "sandbox" : "production";
}
