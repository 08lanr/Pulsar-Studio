"use client";

// The producer's Clips page. Since plan §5.1 it is the same `ClipsTable` the
// staff Clips tab renders, so the two can never drift; the Suspense boundary is
// what `useSearchParams` needs for the URL-persisted filters.

import { Suspense } from "react";
import ClipsTable from "@/components/launch/ClipsTable";
import type { MontageStatus } from "@/lib/clips/montage-run";

export default function ClipsLibrary({ titleId, montage }: { titleId?: string; montage?: { canBuild: boolean; initial: MontageStatus | null } }) {
  return <Suspense fallback={null}><ClipsTable titleId={titleId} montage={montage} /></Suspense>;
}
