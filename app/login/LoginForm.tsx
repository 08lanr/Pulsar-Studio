"use client";

import { useState } from "react";
import { postJson } from "@/lib/api-client";
import { useT } from "@/components/locale";
import LangToggle from "@/components/LangToggle";
import type { DataSource } from "@/lib/data-source";

// Deliberately plain: brand row, one card. Sign-in is a door, not a pitch —
// partners arrive through a deal, never a landing page. Two shapes of the
// same card: email + password (plus a magic link for producers who never
// set a password) against Supabase, or two persona buttons in fixture mode
// so the UI demos with no database.

type Props = {
  mode: DataSource;
  next: string | null;
  initialError: "callback" | null;
};

type LoginReply = { ok?: boolean; home?: string; sent?: boolean; error?: string };

export default function LoginForm({ mode, next, initialError }: Props) {
  const { tt } = useT();
  return (
    <main className="page">
      {/* .brand is styled only inside the sidebar; out here the wordmark is a
          quiet ghost link, which is all a door needs. */}
      <div className="page-head">
        <a href="/" className="btn btn-ghost">
          <span className="brand-mark" aria-hidden />
          Pulsar Studio
        </a>
        <LangToggle />
      </div>

      <div className="card">
        <h2>{tt("auth.login.title")}</h2>
        <p className="hint">{tt("auth.login.sub")}</p>
        {mode === "fixture" ? (
          <DevPersonas next={next} />
        ) : (
          <SupabaseForm next={next} initialError={initialError} />
        )}
      </div>
    </main>
  );
}

function SupabaseForm({ next, initialError }: Omit<Props, "mode">) {
  const { tt } = useT();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"password" | "magic" | null>(null);
  const [error, setError] = useState(initialError === "callback" ? tt("auth.err.callback") : "");
  const [sent, setSent] = useState(false);

  // The server answers with a status, not a sentence: 401 wrong credentials,
  // 403 signed in but no core.profiles row, anything else is generic.
  function describe(status: number): string {
    if (status === 401) return tt("auth.err.badLogin");
    if (status === 403) return tt("auth.err.noProfile");
    return tt("auth.err.generic");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy("password");
    setError("");
    setSent(false);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "password", email, password, next }),
      });
      const body = (await res.json().catch(() => ({}))) as LoginReply;
      if (res.ok && body.ok) {
        window.location.href = body.home ?? "/";
        return;
      }
      setError(describe(res.status));
    } catch {
      setError(tt("auth.err.generic"));
    } finally {
      setBusy(null);
    }
  }

  async function magic() {
    setBusy("magic");
    setError("");
    setSent(false);
    try {
      const body = await postJson<LoginReply>("/api/auth/login", {
        mode: "magic",
        email,
        next,
      });
      if (body.sent) setSent(true);
      else setError(tt("auth.err.generic"));
    } catch {
      setError(tt("auth.err.generic"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <form onSubmit={submit}>
      <div className="field">
        <label className="label" htmlFor="li-email">
          {tt("auth.email")}
        </label>
        <input
          id="li-email"
          className="input"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoFocus
          autoComplete="username"
          required
        />
      </div>
      <div className="field">
        <label className="label" htmlFor="li-password">
          {tt("auth.password")}
        </label>
        <input
          id="li-password"
          className="input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />
        <p className="hint">{tt("auth.password.hint")}</p>
      </div>

      {error && <p className="err">{error}</p>}
      {sent && <p className="note note-info">{tt("auth.magic.sent")}</p>}

      <div className="field">
        <button
          type="submit"
          className="btn btn-primary btn-block"
          disabled={busy !== null || !email || !password}
        >
          {busy === "password" ? <span className="spinner" /> : tt("auth.login.cta")}
        </button>
      </div>
      <div className="field">
        <button
          type="button"
          className="btn btn-outline btn-block"
          onClick={magic}
          disabled={busy !== null || !email}
        >
          {busy === "magic" ? <span className="spinner" /> : tt("auth.magic.cta")}
        </button>
      </div>
    </form>
  );
}

// Fixture mode: plain HTML forms, no JavaScript needed. The route sets the
// persona cookie and redirects, so the buttons work before hydration.
function DevPersonas({ next }: { next: string | null }) {
  const { tt } = useT();
  return (
    <div>
      <p className="note note-info">{tt("auth.dev.sub")}</p>
      <form method="post" action="/api/auth/dev" className="field">
        <input type="hidden" name="kind" value="staff" />
        {next && <input type="hidden" name="next" value={next} />}
        <button type="submit" className="btn btn-primary btn-block">
          {tt("auth.dev.staff")}
        </button>
      </form>
      <form method="post" action="/api/auth/dev" className="field">
        <input type="hidden" name="kind" value="producer" />
        {next && <input type="hidden" name="next" value={next} />}
        <button type="submit" className="btn btn-outline btn-block">
          {tt("auth.dev.producer")}
        </button>
      </form>
    </div>
  );
}
