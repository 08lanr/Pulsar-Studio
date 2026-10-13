"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/components/locale";
import type { CreatorAccount } from "@/lib/creators/types";
import { call } from "./api";

// The Character tab (decision 2026-10-12): the character bible every caption
// and reply is written from, and the account's reply settings — the
// auto-reply switch first. Saved revision-checked; a staff administrator's.

const lines = (v: string) => v.split("\n").map(x => x.trim()).filter(Boolean);
const commas = (v: string) => v.split(",").map(x => x.trim()).filter(Boolean);

export default function Character({ account, canAdmin }: { account: CreatorAccount; canAdmin: boolean }) {
  const { tt } = useT();
  const router = useRouter();
  const p = account.persona, s = account.settings;
  const [f, setF] = useState({
    summary: p.summary, age: p.age === null ? "" : String(p.age), city: p.city, interests: p.interests.join(", "), voice: p.voice,
    do: p.do.join("\n"), dont: p.dont.join("\n"), banned: p.banned_topics.join("\n"),
    auto_reply: s.auto_reply, min: String(s.reply_delay_min), max: String(s.reply_delay_max), perHour: String(s.max_replies_per_hour),
    window: String(s.reply_window_days), timezone: s.timezone, status: account.status,
  });
  const [state, setState] = useState<"idle" | "busy" | "saved" | string>("idle");
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => { setF(x => ({ ...x, [k]: v })); setState("idle"); };

  const save = async () => {
    setState("busy");
    const r = await call(`/api/admin/creators/${account.id}`, "PATCH", {
      revision: account.revision, status: f.status,
      persona: { summary: f.summary, age: f.age.trim() ? Number(f.age) : null, city: f.city, interests: commas(f.interests), voice: f.voice, do: lines(f.do), dont: lines(f.dont), banned_topics: lines(f.banned) },
      settings: { auto_reply: f.auto_reply, reply_delay_min: Number(f.min), reply_delay_max: Number(f.max), max_replies_per_hour: Number(f.perHour), reply_window_days: Number(f.window), timezone: f.timezone },
    });
    setState(r.ok ? "saved" : r.error);
    if (r.ok) router.refresh();
  };

  const text = (key: "summary" | "voice" | "do" | "dont" | "banned", label: string, rows = 3) => (
    <div className="field">
      <label className="label" htmlFor={`cr-${key}`}>{label}</label>
      <textarea id={`cr-${key}`} className="textarea input" rows={rows} value={f[key]} disabled={!canAdmin} onChange={e => set(key, e.target.value)} />
    </div>
  );
  const input = (key: "age" | "city" | "interests" | "min" | "max" | "perHour" | "window" | "timezone", label: string, type = "text") => (
    <div className="field">
      <label className="label" htmlFor={`cr-${key}`}>{label}</label>
      <input id={`cr-${key}`} className="input" type={type} value={f[key]} disabled={!canAdmin} onChange={e => set(key, e.target.value)} />
    </div>
  );

  return (
    <div className="cr-character">
      {!canAdmin && <p className="note note-info">{tt("cr.char.adminOnly")}</p>}
      <section className="card">
        <h2 className="section-title">{tt("cr.char.settings")}</h2>
        <label className="cr-switch">
          <input type="checkbox" checked={f.auto_reply} disabled={!canAdmin} onChange={e => set("auto_reply", e.target.checked)} />
          <span>{tt("cr.char.autoReply")}</span>
        </label>
        <div className="cr-grid">
          {input("min", tt("cr.char.delayMin"), "number")}
          {input("max", tt("cr.char.delayMax"), "number")}
          {input("perHour", tt("cr.char.perHour"), "number")}
          {input("window", tt("cr.char.window"), "number")}
          {input("timezone", tt("cr.char.timezone"))}
          <div className="field">
            <label className="label" htmlFor="cr-status">{tt("cr.char.status")}</label>
            <select id="cr-status" className="select input" value={f.status} disabled={!canAdmin} onChange={e => set("status", e.target.value as "active" | "paused")}>
              <option value="active">{tt("cr.status.active")}</option>
              <option value="paused">{tt("cr.status.paused")}</option>
            </select>
          </div>
        </div>
      </section>
      <section className="card">
        <h2 className="section-title">{tt("cr.char.persona")}</h2>
        {text("summary", tt("cr.char.summary"), 4)}
        <div className="cr-grid">
          {input("age", tt("cr.char.age"), "number")}
          {input("city", tt("cr.char.city"))}
          {input("interests", tt("cr.char.interests"))}
        </div>
        {text("voice", tt("cr.char.voice"))}
        {text("do", tt("cr.char.do"), 4)}
        {text("dont", tt("cr.char.dont"), 4)}
        {text("banned", tt("cr.char.banned"), 3)}
      </section>
      {canAdmin && (
        <div className="form-actions cr-actions">
          <button type="button" className="btn btn-primary btn-sm" disabled={state === "busy"} onClick={() => void save()}>{state === "busy" ? tt("cr.busy") : tt("cr.char.save")}</button>
          {state === "saved" && <span className="hint" role="status">{tt("cr.char.saved")}</span>}
          {state !== "idle" && state !== "busy" && state !== "saved" && <span className="err" role="alert">{state}</span>}
        </div>
      )}
    </div>
  );
}
