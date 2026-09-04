// One row per scene inside a lines column: number, time range, the staff
// status pill and, when the partner sent this version back, the
// needs_alternative reason — the one piece of partner text staff act on.
// Built on .line-tools because it is the only toolbar-shaped row in the
// design system (a dedicated .scene-head would be cleaner; noted).

"use client";

import type { Scene, SceneDecision } from "@/lib/types";
import { useT } from "@/components/locale";
import { fmtTc } from "./util";

export function SceneHeader({
  scene,
  decision,
}: {
  scene: Scene;
  decision?: SceneDecision | null;
}) {
  const { tt } = useT();
  const timed = scene.start_ms !== null;
  return (
    <div className="line-tools" role="heading" aria-level={3}>
      <span className="kicker">{tt("wb.scene.n", { n: scene.number })}</span>
      {timed && (
        <span className="line-tc">
          {fmtTc(scene.start_ms)} – {fmtTc(scene.end_ms)}
        </span>
      )}
      <span className="line-tools-count">
        {decision?.decision === "needs_alternative" && (
          <span className="pill status-changes" title={decision.note ?? undefined}>
            {tt("wb.decision.needs_alternative")}
          </span>
        )}{" "}
        <span className={scene.status === "approved" ? "pill status-approved" : "pill pill-neutral"}>
          {scene.status === "approved" ? tt("wb.scene.approved") : tt("wb.scene.draft")}
        </span>
      </span>
    </div>
  );
}
