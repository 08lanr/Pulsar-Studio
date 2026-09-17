"use client";

import { useState } from "react";

export default function PasswordForm() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    setError("");
    if (password.length < 12) return setError("Use at least 12 characters.");
    if (password !== confirm) return setError("The passwords do not match.");
    setBusy(true);
    try {
      const response = await fetch("/api/producer/settings/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, confirm }),
      });
      const result = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(result.error || "Could not update password. Please try again.");
      setPassword("");
      setConfirm("");
      setMessage("Password saved. You can use it the next time you sign in.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update password. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <p className="hint">Choose a password with at least 12 characters.</p>
      <div className="field">
        <label className="label" htmlFor="new-password">New password</label>
        <input className="input" id="new-password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} />
      </div>
      <div className="field">
        <label className="label" htmlFor="confirm-password">Confirm new password</label>
        <input className="input" id="confirm-password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={confirm} onChange={(event) => setConfirm(event.target.value)} />
      </div>
      {error && <p className="err" role="alert">{error}</p>}
      {message && <p className="note note-success" role="status">{message}</p>}
      <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Save password"}</button>
    </form>
  );
}
