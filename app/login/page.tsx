import { redirect } from "next/navigation";
import { dataSource } from "@/lib/data-source";
import { getSession, homeFor, safeNextPath } from "@/lib/auth";
import LoginForm from "./LoginForm";

// The door. No app shell — nobody here is signed in. A server component so
// an already-signed-in visitor is sent home before any form renders, and so
// the data-source switch is read on the server (the client never learns
// whether Supabase exists, only which form to draw).

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: { next?: string; error?: string };
}) {
  const session = await getSession();
  const next = safeNextPath(searchParams.next);
  if (session) redirect(next ?? homeFor(session.kind));

  return (
    <LoginForm
      mode={dataSource()}
      next={next}
      initialError={searchParams.error === "callback" ? "callback" : null}
    />
  );
}
