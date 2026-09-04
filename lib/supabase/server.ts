// Supabase clients for server code (route handlers, server components, jobs).
//
// Three products share one Supabase project (Studio, Reach, Stage), so the
// URL and keys are the same across repos; only the schema each product owns
// differs (see docs/data-model.md). Two clients:
//
//   createServerSupabase()  — per-request, carries the caller's session cookie,
//                             subject to RLS. Use this for everything a user does.
//   createServiceSupabase() — service role, BYPASSES RLS. Only for ingest jobs
//                             and admin routes that have already checked the
//                             caller is Pulsar staff. Never import it into a
//                             client component.

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} — copy .env.example to .env.local`);
  return v;
}

export function createServerSupabase() {
  const cookieStore = cookies();
  return createServerClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value;
        },
        set(name: string, value: string, options: CookieOptions) {
          try {
            cookieStore.set({ name, value, ...options });
          } catch {
            // Server components cannot set cookies; middleware refreshes the
            // session instead. Swallowing here is the documented @supabase/ssr
            // pattern.
          }
        },
        remove(name: string, options: CookieOptions) {
          try {
            cookieStore.set({ name, value: "", ...options });
          } catch {
            // see above
          }
        },
      },
    }
  );
}

export function createServiceSupabase() {
  return createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}
