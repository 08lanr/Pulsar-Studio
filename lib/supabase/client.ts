"use client";

// Browser Supabase client. Anon key only; every query runs under RLS as the
// signed-in user. Prefer server components + route handlers for reads; use
// this for realtime subscriptions and the auth UI.

import { createBrowserClient } from "@supabase/ssr";

let cached: ReturnType<typeof createBrowserClient> | null = null;

export function getBrowserSupabase() {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error("Supabase env is not configured — see .env.example");
  }
  cached = createBrowserClient(url, key);
  return cached;
}
