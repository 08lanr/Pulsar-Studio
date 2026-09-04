// Create editable rows without calling an AI provider. This keeps a newly
// ingested script usable when the provider is not configured: staff can type
// the English adaptation line by line, and the normal readiness gate still
// prevents blank rows from being submitted.

import { NextResponse, type NextRequest } from "next/server";
import { requireMember } from "@/lib/auth";
import { DataError, getData } from "@/lib/data";
import { episodeNumber, handle, isResponse } from "../../../../_lib/handler";

export async function POST(_req: NextRequest, { params }: { params: { id: string; n: string } }) {
  return handle(_req, async () => {
    const guard = await requireMember();
    if (guard.response) return guard.response;
    const number = episodeNumber(params.n);
    if (isResponse(number)) return number;

    const data = getData();
    const workbench = await data.getWorkbench(guard.session, params.id, number);
    if (!workbench.version) throw new DataError("not_found", "no draft version for this episode");
    if (workbench.version.status !== "draft") {
      throw new DataError("frozen", "this version is frozen; create a revision before editing");
    }

    const existing = new Set(workbench.adapted_lines.map((line) => line.line_id).filter(Boolean));
    let created = 0;
    for (const scene of workbench.scenes) {
      const missing = workbench.lines.filter((line) => line.scene_id === scene.id && !existing.has(line.id));
      if (!missing.length) continue;
      const rows = await data.writeFirstPass(
        guard.session,
        workbench.version.id,
        scene.id,
        missing.map((line) => ({
          line_id: line.id,
          literal_en: null,
          text_en: "",
          back_translation_zh: null,
          change_type: "keep" as const,
          is_major: false,
          rationale_en: null,
          rationale_zh: null,
          tags: [],
          model: "manual",
          prompt_version: "manual-v1",
        }))
      );
      for (const row of rows.filter((row) => missing.some((line) => line.id === row.line_id))) {
        await data.updateAdaptedLine(
          guard.session,
          row.id,
          { text_en: row.text_en },
          { authored_by: "editor", model: null, prompt_version: null }
        );
        created += 1;
      }
    }

    return NextResponse.json({ version: workbench.version, created }, { status: 201 });
  });
}
