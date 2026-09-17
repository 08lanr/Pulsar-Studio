"use client";

// The staff Titles filter. The chosen company lives in the URL (?producer=<id>)
// so the page stays a server component, the choice survives a reload and a
// filtered list can be linked to. Options come from the titles on the page, so
// a company with no titles never appears.

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useT } from "@/components/locale";

type Option = { id: string; name: string };

export default function TitleProducerFilter({ producers, value }: { producers: Option[]; value: string }) {
  const { tt } = useT();
  const router = useRouter();
  const pathname = usePathname() ?? "/titles";
  const params = useSearchParams();

  function choose(next: string) {
    const query = new URLSearchParams(params?.toString() ?? "");
    if (next) query.set("producer", next);
    else query.delete("producer");
    const search = query.toString();
    router.replace(search ? `${pathname}?${search}` : pathname);
  }

  return <label className="staff-titles-filter">
    <span>{tt("admin.titles.producer")}</span>
    <select className="select" value={value} onChange={(event) => choose(event.target.value)}>
      <option value="">{tt("clipsPosting.filter.all")}</option>
      {producers.map((producer) => <option key={producer.id} value={producer.id}>{producer.name}</option>)}
    </select>
  </label>;
}
