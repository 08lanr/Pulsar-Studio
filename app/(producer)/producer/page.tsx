import { redirect } from "next/navigation";

// /producer — the workspace opens on My catalog (decision 2026-09-08, "status
// board"). The former Overview duplicated the Ad campaigns task queue and the
// What-to-make-next board; both keep their own homes.

export default function ProducerHome({ searchParams }: { searchParams: { view?: string } }) {
  redirect(searchParams.view === "opportunities" ? "/producer/insights/next" : "/producer/titles");
}
