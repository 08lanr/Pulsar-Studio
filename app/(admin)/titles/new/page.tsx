import CreateTitleForm from "@/components/admin/CreateTitleForm";
import { staffSession } from "@/components/admin/server";
import { getData } from "@/lib/data";

export const dynamic = "force-dynamic";
export default async function NewTitlePage() {
  const session=await staffSession(); const producers=await getData().listProducers(session);
  return <><div className="page-head"><div><a className="title-back" href="/titles">← Back to titles</a><h2>New title</h2><p className="page-sub">Create the title bible, then add subtitle or script files from its title page.</p></div></div><CreateTitleForm producers={producers} /></>;
}
