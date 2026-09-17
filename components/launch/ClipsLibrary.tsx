"use client";

// The producer's Clips page. Since plan §5.1 it is the same `ClipsTable` the
// staff Clips tab renders, so the two can never drift; the Suspense boundary is
// what `useSearchParams` needs for the URL-persisted filters.

import { Suspense } from "react";
import ClipsTable from "@/components/launch/ClipsTable";

export default function ClipsLibrary({ titleId }: { titleId?: string }) {
  return <Suspense fallback={null}><ClipsTable titleId={titleId} /></Suspense>;
}
