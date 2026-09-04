// The Adaptation workbench (the hero screen): state, selection and every
// API call live here; the three regions are dumb. The server page hands
// over the WorkbenchPayload once; afterwards line edits patch the local
// copy from the route's response, and the gate actions (first pass,
// submit, fork) re-fetch the whole payload because they change the
// version the screen is looking at.
//
// Selection is by SOURCE line id: the Chinese line is the anchor, its
// adapted counterpart is looked up. The player time follows the selected
// line (a click seeks), and while the video plays the selection follows
// the time, so either column can lead.

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AdaptedLine,
  EpisodeSummary,
  FeedbackDisposition,
  Line,
  LineAlternative,
  Scene,
  SceneStatus,
  Version,
  WorkbenchPayload,
} from "@/lib/types";
import type { AdaptedLinePatch } from "@/lib/data";
import { getJson, postJson } from "@/lib/api-client";
import { useT } from "@/components/locale";
import { AdaptedColumn, type AdaptedBusy } from "./AdaptedColumn";
import { IconAlert, IconCheck, IconChevron, IconEdit, IconSparkle } from "./icons";
import { Player } from "./Player";
import { SourceColumn } from "./SourceColumn";
import type { SaveState } from "./useAutosave";
import { indexByLine, isFrozen, patchJson, shortSha, unwrap } from "./util";

type Busy = {
  firstPass: boolean;
  manual: boolean;
  submit: boolean;
  fork: boolean;
  scene: boolean;
  alternatives: boolean;
  rewrite: boolean;
  choosing: string | null;
  feedback: string | null;
};

const IDLE: Busy = {
  firstPass: false,
  manual: false,
  submit: false,
  fork: false,
  scene: false,
  alternatives: false,
  rewrite: false,
  choosing: null,
  feedback: null,
};

function reviewTime(ms: number | null, seq?: number) {
  if (ms == null) return seq ? `Line ${seq}` : "Untimed";
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function Workbench({
  titleId,
  episodeNumber,
  initial,
  episodes,
}: {
  titleId: string;
  episodeNumber: number;
  initial: WorkbenchPayload;
  episodes: EpisodeSummary[];
}) {
  const { tt } = useT();
  const router = useRouter();
  const base = `/api/titles/${titleId}/episodes/${episodeNumber}`;

  const [data, setData] = useState<WorkbenchPayload>(initial);
  const [selectedId, setSelectedId] = useState<string | null>(initial.lines[0]?.id ?? null);
  const [currentMs, setCurrentMs] = useState<number>(initial.lines[0]?.start_ms ?? 0);
  const [videoDurationMs, setVideoDurationMs] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(IDLE);
  const [responseDrafts, setResponseDrafts] = useState<
    Record<string, { disposition: FeedbackDisposition; note: string }>
  >({});
  const videoRef = useRef<HTMLVideoElement>(null);

  // ---- derived -------------------------------------------------------------------

  const { scenes, lines, adapted_lines: adaptedLines, alternatives, decisions, version } = data;
  const adaptedByLine = useMemo(() => indexByLine(adaptedLines), [adaptedLines]);
  const frozen = isFrozen(version?.status);
  const selectedLine = useMemo(() => lines.find((l) => l.id === selectedId) ?? null, [lines, selectedId]);
  const selectedScene = useMemo(
    () => (selectedLine ? scenes.find((s) => s.id === selectedLine.scene_id) ?? null : scenes[0] ?? null),
    [scenes, selectedLine]
  );
  const sceneIndex = selectedScene ? scenes.findIndex((s) => s.id === selectedScene.id) : -1;
  const sceneLines = useMemo(
    () => (selectedScene ? lines.filter((l) => l.scene_id === selectedScene.id) : []),
    [lines, selectedScene]
  );
  const selectedAdapted = selectedLine ? adaptedByLine.get(selectedLine.id) ?? null : null;
  const selectedAlternatives = useMemo(
    () => (selectedAdapted ? alternatives.filter((a) => a.adapted_line_id === selectedAdapted.id) : []),
    [alternatives, selectedAdapted]
  );
  const selectedDecision = selectedLine
    ? decisions.find((decision) => decision.decision === "needs_alternative" && decision.line_id === selectedLine.id) ?? null
    : null;
  const lineReady = useCallback(
    (line: Line) => {
      const adapted = adaptedByLine.get(line.id);
      if (!adapted) return false;
      if (adapted.change_type !== "cut" && !adapted.text_en?.trim()) return false;
      if (adapted.change_type !== "keep" && !adapted.rationale_zh?.trim()) return false;
      if (adapted.change_type !== "keep" && adapted.change_type !== "cut" && !adapted.back_translation_zh?.trim()) return false;
      return true;
    },
    [adaptedByLine]
  );
  const adaptedCount = lines.filter((line) => adaptedByLine.has(line.id)).length;
  const readyLineCount = lines.filter(lineReady).length;
  const allLinesReady = lines.length > 0 && readyLineCount === lines.length;
  const selectedSceneReady = sceneLines.length > 0 && sceneLines.every(lineReady);
  const selectedSceneMissing = sceneLines.filter((line) => !lineReady(line)).length;
  const scenesApproved = scenes.filter((s) => s.status === "approved").length;
  const allScenesApproved = scenes.length > 0 && scenesApproved === scenes.length;
  const lastEnd = lines.reduce((m, l) => Math.max(m, l.end_ms ?? 0), 0);
  const durationMs = data.episode.duration_ms ?? videoDurationMs ?? (lastEnd || null);
  const sceneMarks = scenes.map((s) => s.start_ms).filter((ms): ms is number => ms !== null && ms > 0);
  const hasVideo = !!data.video_url;
  const alternativeRequests = decisions.filter((decision) => decision.decision === "needs_alternative");
  const producerReviewRemaining = Math.max(0, scenes.length - decisions.length);
  const producerReviewComplete = scenes.length > 0 && producerReviewRemaining === 0;
  const requestedScenes = alternativeRequests.flatMap((decision) => {
    const requestScene = scenes.find((scene) => scene.id === decision.scene_id);
    const anchorLine = lines.find((line) => line.id === decision.line_id) ?? lines.find((line) => line.scene_id === decision.scene_id);
    const revised = anchorLine ? adaptedByLine.get(anchorLine.id) ?? null : null;
    return requestScene ? [{ decision, scene: requestScene, anchorLine, revised }] : [];
  });
  const unresolvedResponses = alternativeRequests.filter((decision) => !decision.resolution_disposition).length;

  // ---- selection and the player ------------------------------------------------------

  const seek = useCallback((ms: number) => {
    setCurrentMs(ms);
    const v = videoRef.current;
    if (v && Number.isFinite(ms)) v.currentTime = ms / 1000;
  }, []);

  const selectLine = useCallback(
    (line: Line) => {
      setSelectedId(line.id);
      if (line.start_ms !== null) seek(line.start_ms);
    },
    [seek]
  );

  const playLine = useCallback(
    (line: Line) => {
      selectLine(line);
      void videoRef.current?.play();
    },
    [selectLine]
  );

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  }, []);

  // Video events: time, play state, duration. Selection follows playback so
  // the source column scrolls with the footage.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => {
      const ms = Math.round(v.currentTime * 1000);
      setCurrentMs(ms);
      if (!v.paused) {
        const hit = lines.find((l) => l.start_ms !== null && l.end_ms !== null && ms >= l.start_ms && ms < l.end_ms);
        if (hit) setSelectedId(hit.id);
      }
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onMeta = () => {
      if (Number.isFinite(v.duration)) setVideoDurationMs(Math.round(v.duration * 1000));
    };
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("ended", onPause);
    v.addEventListener("loadedmetadata", onMeta);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("ended", onPause);
      v.removeEventListener("loadedmetadata", onMeta);
    };
  }, [lines, data.video_url]);

  // j / k move the selection, space toggles play when a video exists.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        const i = lines.findIndex((l) => l.id === selectedId);
        const next = lines[e.key === "j" ? i + 1 : i - 1];
        if (next) selectLine(next);
      } else if (e.key === " " && hasVideo) {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lines, selectedId, hasVideo, selectLine, togglePlay]);

  // ---- writes ----------------------------------------------------------------------------

  const replaceLine = useCallback((line: AdaptedLine) => {
    setData((d) => ({ ...d, adapted_lines: d.adapted_lines.map((a) => (a.id === line.id ? line : a)) }));
  }, []);

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  async function reload() {
    try {
      const next = await getJson<WorkbenchPayload>(base);
      setData(next);
    } catch (e) {
      fail(e);
    }
  }

  const saveText = useCallback(
    async (adaptedLineId: string, text: string) => {
      const res = unwrap(await patchJson<{ line: AdaptedLine; error?: string }>(`${base}/lines/${adaptedLineId}`, { text_en: text }));
      replaceLine(res.line);
    },
    [base, replaceLine]
  );

  async function patchLine(adaptedLineId: string, patch: AdaptedLinePatch) {
    setSaveState("saving");
    try {
      const res = unwrap(await patchJson<{ line: AdaptedLine; error?: string }>(`${base}/lines/${adaptedLineId}`, patch));
      replaceLine(res.line);
      setSaveState("saved");
    } catch (e) {
      setSaveState("error");
      fail(e);
    }
  }

  async function respondToRequest(decision: WorkbenchPayload["decisions"][number]) {
    const draft = responseDrafts[decision.scene_id];
    if (!draft?.note.trim()) return;
    setBusy((value) => ({ ...value, feedback: decision.scene_id }));
    setError(null);
    try {
      const result = unwrap(
        await postJson<{ decision: WorkbenchPayload["decisions"][number]; error?: string }>(`${base}/feedback`, {
          version_id: decision.version_id,
          scene_id: decision.scene_id,
          disposition: draft.disposition,
          note: draft.note.trim(),
        })
      );
      setData((value) => ({
        ...value,
        decisions: value.decisions.map((item) =>
          item.version_id === result.decision.version_id && item.scene_id === result.decision.scene_id
            ? result.decision
            : item
        ),
      }));
    } catch (requestError) {
      fail(requestError);
    } finally {
      setBusy((value) => ({ ...value, feedback: null }));
    }
  }

  async function setSceneStatus(sceneId: string, status: SceneStatus) {
    setBusy((b) => ({ ...b, scene: true }));
    setError(null);
    try {
      const res = unwrap(await postJson<{ scene: Scene; error?: string }>(`${base}/scenes/${sceneId}/status`, { status }));
      setData((d) => ({ ...d, scenes: d.scenes.map((s) => (s.id === res.scene.id ? res.scene : s)) }));
    } catch (e) {
      fail(e);
    } finally {
      setBusy((b) => ({ ...b, scene: false }));
    }
  }

  async function chooseAlternative(adaptedLineId: string, alternativeId: string) {
    setBusy((b) => ({ ...b, choosing: alternativeId }));
    setError(null);
    try {
      const res = unwrap(
        await postJson<{ line: AdaptedLine; error?: string }>(`${base}/lines/${adaptedLineId}/choose`, { alternative_id: alternativeId })
      );
      replaceLine(res.line);
      setData((d) => ({
        ...d,
        alternatives: d.alternatives.map((a) =>
          a.adapted_line_id === adaptedLineId ? { ...a, chosen: a.id === alternativeId } : a
        ),
      }));
    } catch (e) {
      fail(e);
    } finally {
      setBusy((b) => ({ ...b, choosing: null }));
    }
  }

  async function moreAlternatives(adaptedLineId: string) {
    setBusy((b) => ({ ...b, alternatives: true }));
    setError(null);
    try {
      const res = unwrap(
        await postJson<{ alternatives: LineAlternative[]; error?: string }>(`${base}/lines/${adaptedLineId}/alternatives`, {})
      );
      // The route returns the line's full list; merge by id so a partial
      // answer never drops what was already there.
      setData((d) => {
        const seen = new Set(res.alternatives.map((a) => a.id));
        const kept = d.alternatives.filter((a) => a.adapted_line_id !== adaptedLineId || !seen.has(a.id));
        return { ...d, alternatives: [...kept, ...res.alternatives] };
      });
    } catch (e) {
      fail(e);
    } finally {
      setBusy((b) => ({ ...b, alternatives: false }));
    }
  }

  async function rewrite(adaptedLineId: string, instruction: string) {
    setBusy((b) => ({ ...b, rewrite: true }));
    setError(null);
    try {
      const res = unwrap(await postJson<{ line: AdaptedLine; error?: string }>(`${base}/lines/${adaptedLineId}/rewrite`, { instruction }));
      replaceLine(res.line);
    } catch (e) {
      fail(e);
    } finally {
      setBusy((b) => ({ ...b, rewrite: false }));
    }
  }

  async function gate(kind: "firstPass" | "manual" | "submit" | "fork") {
    const path = kind === "firstPass" ? "first-pass" : kind === "manual" ? "manual-draft" : kind;
    setBusy((b) => ({ ...b, [kind]: true }));
    setError(null);
    try {
      unwrap(await postJson<{ version: Version; error?: string }>(`${base}/${path}`, {}));
      await reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy((b) => ({ ...b, [kind]: false }));
    }
  }

  // ---- header state --------------------------------------------------------------------

  const hasFirstPass = adaptedLines.length > 0;
  const firstPassWhy = lines.length === 0
    ? tt("wb.firstPass.noLines")
    : frozen
      ? tt("wb.frozen.hint")
      : hasFirstPass
        ? tt("wb.firstPass.exists")
        : null;

  const submitWhy = !version
    ? tt("wb.submit.noVersion")
    : frozen
      ? tt("wb.submit.frozen")
      : !allLinesReady
        ? tt("wb.submit.lines", { n: readyLineCount, total: lines.length })
      : unresolvedResponses > 0
        ? tt("wb.submit.responses", { n: unresolvedResponses })
      : !allScenesApproved
        ? tt("wb.submit.scenes", { n: scenesApproved, total: scenes.length })
        : null;
  const forkWhy = version?.status === "in_review" && !producerReviewComplete
    ? tt("wb.fork.reviewPending", { n: producerReviewRemaining })
    : null;

  const statusKey = !version || !hasFirstPass ? "ingested" : version.status === "draft" ? "adapting" : version.status;
  const statusPill: Record<string, string> = {
    ingested: "pill status-ingested",
    adapting: "pill status-adapting",
    in_review: "pill status-review",
    approved: "pill status-approved",
    superseded: "pill pill-neutral",
  };

  const adaptedBusy: AdaptedBusy = { alternatives: busy.alternatives, rewrite: busy.rewrite, choosing: busy.choosing };
  const pct = lines.length ? Math.round((readyLineCount / lines.length) * 100) : 0;
  const episodeName = data.episode.name_en ?? data.episode.name_zh;
  const workflow = !version || !hasFirstPass
    ? {
        tone: "next",
        owner: tt("wb.workflow.owner.staff"),
        title: data.ai_available ? tt("wb.workflow.start.title") : tt("wb.workflow.manual.title"),
        body: data.ai_available ? tt("wb.workflow.start.body") : tt("wb.workflow.manual.body"),
      }
    : version.status === "approved"
      ? {
          tone: "done",
          owner: tt("wb.workflow.owner.done"),
          title: tt("wb.workflow.approved.title"),
          body: tt("wb.workflow.approved.body"),
        }
      : version.status === "in_review" && alternativeRequests.length > 0 && !producerReviewComplete
        ? {
            tone: "waiting",
            owner: tt("wb.workflow.owner.producer"),
            title: tt("wb.workflow.feedbackPending.title"),
            body: tt("wb.workflow.feedbackPending.body", { n: producerReviewRemaining }),
          }
        : version.status === "in_review" && alternativeRequests.length > 0
        ? {
            tone: "blocked",
            owner: tt("wb.workflow.owner.staff"),
            title: tt("wb.workflow.returned.title", { n: alternativeRequests.length }),
            body: tt("wb.workflow.returned.body"),
          }
        : version.status === "in_review"
          ? {
              tone: "waiting",
              owner: tt("wb.workflow.owner.producer"),
              title: tt("wb.workflow.waiting.title"),
              body: tt("wb.workflow.waiting.body"),
            }
          : !allLinesReady
            ? {
                tone: "next",
                owner: tt("wb.workflow.owner.staff"),
                title: tt("wb.workflow.edit.title"),
                body: tt("wb.workflow.edit.body", { n: lines.length - readyLineCount }),
              }
            : !allScenesApproved
              ? {
                  tone: "next",
                  owner: tt("wb.workflow.owner.staff"),
                  title: tt("wb.workflow.readyScenes.title"),
                  body: tt("wb.workflow.readyScenes.body", { n: scenes.length - scenesApproved }),
                }
              : {
                  tone: "ready",
                  owner: tt("wb.workflow.owner.staff"),
                  title: tt("wb.workflow.send.title"),
                  body: tt("wb.workflow.send.body"),
                };

  return (
    <>
      <div className="title-head">
        <Link href={`/titles/${titleId}`} className="title-back">
          <IconChevron className="rotate" />
          {tt("wb.back")}
        </Link>
        <div className="title-main">
          <div className="title-row">
            <h1>
              {data.title.name_en ?? data.title.name_zh}
              {episodeName ? ` — ${episodeName}` : ""}
            </h1>
            {episodes.length <= 8 ? (
              <div className="seg" role="tablist" aria-label={tt("wb.episode.picker")}>
                {episodes.map((ep) => (
                  <Link
                    key={ep.id}
                    href={`/titles/${titleId}/episodes/${ep.number}`}
                    className={ep.number === episodeNumber ? "seg-btn on" : "seg-btn"}
                    role="tab"
                    aria-selected={ep.number === episodeNumber}
                  >
                    {tt("wb.episode.short", { n: ep.number })}
                  </Link>
                ))}
              </div>
            ) : (
              <select
                className="select select-inline"
                value={episodeNumber}
                aria-label={tt("wb.episode.picker")}
                onChange={(e) => router.push(`/titles/${titleId}/episodes/${e.target.value}`)}
              >
                {episodes.map((ep) => (
                  <option key={ep.id} value={ep.number}>
                    {tt("wb.episode.short", { n: ep.number })}
                  </option>
                ))}
              </select>
            )}
            <span className={statusPill[statusKey] ?? "pill pill-neutral"}>{tt(`wb.status.${statusKey}`)}</span>
          </div>
          <div className="title-meta">
            <span>{tt("wb.meta.scenes", { n: scenes.length })}</span>
            <span>{tt("wb.meta.lines", { n: lines.length })}</span>
            {version && <span>{version.external_id}</span>}
            {!data.episode.has_timecodes && <span>{tt("wb.meta.untimed")}</span>}
          </div>
          <div className="def-row">
            <span className="k">{tt("wb.progress.label")}</span>
            <span className="v">{tt("wb.progress.value", { n: readyLineCount, total: lines.length, pct })}</span>
          </div>
          <div className="track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <span style={{ width: `${pct}%` }} />
          </div>
        </div>
        <div className="title-actions">
          <span className="title-save" aria-live="polite">
            {saveState === "saving" ? (
              <>
                <span className="spinner" /> {tt("wb.save.saving")}
              </>
            ) : saveState === "error" ? (
              <>
                <IconAlert /> {tt("wb.save.error")}
              </>
            ) : (
              <>
                <IconCheck /> {tt("wb.save.saved")}
              </>
            )}
          </span>
          <button
            type="button"
            className="btn btn-outline"
            disabled={!!firstPassWhy || busy.firstPass || busy.manual}
            title={firstPassWhy ?? undefined}
            onClick={() => gate(data.ai_available ? "firstPass" : "manual")}
          >
            {busy.firstPass || busy.manual ? <span className="spinner" /> : data.ai_available ? <IconSparkle /> : <IconEdit />}
            {data.ai_available ? tt("wb.firstPass") : tt("wb.manualDraft")}
          </button>
          {frozen ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy.fork || !!forkWhy}
              title={forkWhy ?? undefined}
              onClick={() => gate("fork")}
            >
              {busy.fork ? <span className="spinner" /> : <IconEdit />}
              {tt("wb.fork")}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-approve"
              disabled={!!submitWhy || busy.submit}
              title={submitWhy ?? undefined}
              onClick={() => gate("submit")}
            >
              {busy.submit ? <span className="spinner" /> : <IconCheck />}
              {tt("wb.submit")}
            </button>
          )}
        </div>
      </div>

      <section className={`workflow-callout workflow-${workflow.tone}`} aria-live="polite">
        <div>
          <span className="workflow-label">{tt("wb.workflow.next")}</span>
          <h2>{workflow.title}</h2>
          <p>{workflow.body}</p>
        </div>
        <div className="workflow-owner">
          <span>{tt("wb.workflow.owner")}</span>
          <strong>{workflow.owner}</strong>
        </div>
        <div className="workflow-checks">
          <span className={allLinesReady ? "done" : ""}>{tt("wb.workflow.lines", { n: readyLineCount, total: lines.length })}</span>
          <span className={allScenesApproved ? "done" : ""}>{tt("wb.workflow.scenes", { n: scenesApproved, total: scenes.length })}</span>
        </div>
      </section>

      {requestedScenes.length > 0 && (
        <section className="producer-requests" role="alert">
          <div className="producer-requests-head">
            <div>
              <span className="workflow-label">{tt("wb.requests.label")}</span>
              <h2>{tt("wb.requests.title", { n: requestedScenes.length })}</h2>
              <p>
                {frozen
                  ? producerReviewComplete
                    ? tt("wb.requests.frozenHelp")
                    : tt("wb.requests.pendingHelp", { n: producerReviewRemaining })
                  : tt("wb.requests.draftHelp")}
              </p>
            </div>
            <span className={`pill ${frozen && !producerReviewComplete ? "status-review" : "status-changes"}`}>
              {frozen && !producerReviewComplete ? tt("wb.requests.reviewInProgress") : tt("wb.requests.actionRequired")}
            </span>
          </div>
          <div className="producer-request-list">
            {requestedScenes.map(({ decision, scene: requestScene, anchorLine, revised }) => {
              const draft = responseDrafts[decision.scene_id] ?? { disposition: "agreed" as const, note: "" };
              const moment = reviewTime(decision.timestamp_ms ?? anchorLine?.start_ms ?? null, anchorLine?.seq);
              return (
                <article className="producer-request producer-request-thread" key={`${decision.version_id}:${decision.scene_id}`}>
                  <div className="feedback-thread-head">
                    <div>
                      <span className="feedback-moment">{moment}</span>
                      <strong>{tt("wb.requests.sceneMoment", { n: requestScene.number })}</strong>
                    </div>
                    <button
                      type="button"
                      className="btn btn-sm btn-outline"
                      disabled={!anchorLine}
                      onClick={() => anchorLine && selectLine(anchorLine)}
                    >
                      {tt("wb.requests.openMoment", { time: moment })}
                    </button>
                  </div>
                  <div className="feedback-message producer-message">
                    <span>{tt("wb.requests.producerSaid")}</span>
                    <blockquote className="producer-request-note">{decision.note}</blockquote>
                  </div>
                  {revised && (
                    <div className="feedback-revision-preview">
                      <span>{tt("wb.requests.currentRevision")}</span>
                      <strong>{revised.text_en || tt("review.lineCut")}</strong>
                      {revised.rationale_zh && <p lang="zh-CN">{revised.rationale_zh}</p>}
                    </div>
                  )}
                  {decision.resolution_disposition ? (
                    <div className="feedback-response-saved">
                      <span className="pill status-approved">
                        {tt(`wb.requests.disposition.${decision.resolution_disposition}`)}
                      </span>
                      <p>{decision.resolution_note}</p>
                    </div>
                  ) : !frozen ? (
                    <div className="feedback-response-form">
                      <div>
                        <span className="field-label">{tt("wb.requests.responseDecision")}</span>
                        <div className="seg feedback-disposition" role="group" aria-label={tt("wb.requests.responseDecision")}>
                          {(["agreed", "partially_agreed", "disagreed"] as FeedbackDisposition[]).map((value) => (
                            <button
                              type="button"
                              className={draft.disposition === value ? "seg-btn on" : "seg-btn"}
                              key={value}
                              onClick={() => setResponseDrafts((current) => ({
                                ...current,
                                [decision.scene_id]: { ...draft, disposition: value },
                              }))}
                            >
                              {tt(`wb.requests.disposition.${value}`)}
                            </button>
                          ))}
                        </div>
                      </div>
                      <label className="field">
                        <span className="field-label">{tt("wb.requests.responseReason")}</span>
                        <textarea
                          className="textarea"
                          rows={3}
                          value={draft.note}
                          placeholder={tt("wb.requests.responsePlaceholder")}
                          onChange={(event) => setResponseDrafts((current) => ({
                            ...current,
                            [decision.scene_id]: { ...draft, note: event.target.value },
                          }))}
                        />
                      </label>
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={!draft.note.trim() || busy.feedback === decision.scene_id}
                        onClick={() => void respondToRequest(decision)}
                      >
                        {busy.feedback === decision.scene_id ? <span className="spinner" /> : null}
                        {tt("wb.requests.saveResponse")}
                      </button>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        </section>
      )}

      {forkWhy && <p className="hint action-hint">{forkWhy}</p>}
      {submitWhy && version && !frozen && <p className="hint">{submitWhy}</p>}

      {frozen && version && (
        <div className="note note-info" role="status">
          {version.status === "approved"
            ? tt("wb.frozen.approved", { sha: shortSha(version.snapshot_sha256) })
            : tt("wb.frozen.inReview", { sha: shortSha(version.snapshot_sha256) })}
        </div>
      )}

      {error && (
        <div className="note note-warn" role="alert">
          {error}{" "}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setError(null)}>
            {tt("wb.error.dismiss")}
          </button>
        </div>
      )}

      <div className="workspace">
        <div className="ws-player">
          <Player
            videoRef={videoRef}
            videoUrl={data.video_url}
            currentMs={currentMs}
            durationMs={durationMs}
            playing={playing}
            onTogglePlay={togglePlay}
            onSeek={seek}
            sceneMarks={sceneMarks}
            scene={selectedScene}
            sceneIndex={sceneIndex}
            sceneTotal={scenes.length}
            frozen={frozen}
            busy={busy.scene}
            canMarkReady={selectedSceneReady}
            readyWhy={
              selectedScene && !selectedSceneReady
                ? tt("wb.scene.notReady", { n: selectedSceneMissing })
                : null
            }
            onSceneStatus={setSceneStatus}
          />
        </div>
        <div className="ws-source">
          <SourceColumn
            scenes={scenes}
            lines={lines}
            adaptedByLine={adaptedByLine}
            decisions={decisions}
            selectedScene={selectedScene}
            selectedId={selectedId}
            onSelect={selectLine}
            onPlayLine={playLine}
          />
        </div>
        <div className="ws-adapted">
          <AdaptedColumn
            scene={selectedScene}
            line={selectedLine}
            adapted={selectedAdapted}
            sceneLines={sceneLines}
            adaptedByLine={adaptedByLine}
            alternatives={selectedAlternatives}
            decision={selectedDecision}
            hasVersion={!!version && hasFirstPass}
            frozen={frozen}
            aiAvailable={data.ai_available}
            busy={adaptedBusy}
            adaptedCount={readyLineCount}
            totalLines={lines.length}
            onSelect={selectLine}
            onSaveText={saveText}
            onPatch={patchLine}
            onChoose={chooseAlternative}
            onMoreAlternatives={moreAlternatives}
            onRewrite={rewrite}
            onSaveState={setSaveState}
          />
        </div>
      </div>
    </>
  );
}
