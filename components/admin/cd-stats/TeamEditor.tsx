"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/components/locale";

/**
 * The team's own accounts, left out of the CrazyDramas stats: one email per
 * line. A staff administrator saves it (POST /api/admin/crazydramas/stats-team);
 * other staff read it. Saving re-reads the stats with the new list.
 */
export default function TeamEditor({ emails, canEdit, updatedAt, updatedBy }: { emails: string[]; canEdit: boolean; updatedAt: string | null; updatedBy: string | null }) {
  const { tt } = useT();
  const router = useRouter();
  const [text, setText] = useState(emails.join("\n"));
  const [state, setState] = useState<{ busy: boolean; error: string | null; saved: boolean }>({ busy: false, error: null, saved: false });

  const save = async () => {
    setState({ busy: true, error: null, saved: false });
    try {
      const res = await fetch("/api/admin/crazydramas/stats-team", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ emails: text.split(/[\s,;]+/).filter(Boolean) }),
      });
      const body = (await res.json().catch(() => ({}))) as { emails?: string[]; error?: string };
      if (!res.ok) {
        setState({ busy: false, error: body.error ?? tt("cds.team.failed"), saved: false });
        return;
      }
      setText((body.emails ?? []).join("\n"));
      setState({ busy: false, error: null, saved: true });
      router.refresh();
    } catch {
      setState({ busy: false, error: tt("cds.team.failed"), saved: false });
    }
  };

  return (
    <div className="cds-team">
      {canEdit ? (
        <>
          <label className="cds-team-label" htmlFor="cds-team-emails">{tt("cds.team.label")}</label>
          <textarea id="cds-team-emails" className="input cds-team-input" rows={Math.min(8, Math.max(3, text.split("\n").length + 1))} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} placeholder="name@example.com" />
          <div className="cds-team-actions">
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void save()} disabled={state.busy}>
              {state.busy ? tt("cds.team.saving") : tt("cds.team.save")}
            </button>
            {state.saved && <span className="cds-team-ok" role="status">{tt("cds.team.saved")}</span>}
            {state.error && <span className="cds-team-error" role="alert">{state.error}</span>}
          </div>
        </>
      ) : emails.length ? (
        <ul className="cds-team-list">{emails.map((e) => <li key={e}>{e}</li>)}</ul>
      ) : (
        <p className="cds-sub-line">{tt("cds.team.empty")}</p>
      )}
      {updatedAt && <p className="cds-sub-line">{tt("cds.team.updated", { at: new Date(updatedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }), by: updatedBy ?? "–" })}</p>}
    </div>
  );
}
