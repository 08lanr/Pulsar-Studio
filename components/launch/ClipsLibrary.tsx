"use client";

// The producer's Clips page. Since plan §5.1 it is the same `ClipsTable` the
// staff Clips tab renders, so the two can never drift; the Suspense boundary is
// what `useSearchParams` needs for the URL-persisted filters.

import { Suspense } from "react";
import ClipsTable from "@/components/launch/ClipsTable";
import type { MontageStatus } from "@/lib/clips/montage-run";
import type { QuickHookStatus } from "@/lib/clips/quick-hook-run";

type Props = { titleId?: string; montage?: { canBuild: boolean; initial: MontageStatus | null }; quickHooks?: { canBuild: boolean; initial: QuickHookStatus | null } };

export default function ClipsLibrary({ titleId, montage, quickHooks }: Props) {
  return <Suspense fallback={null}><ClipsTable titleId={titleId} montage={montage} quickHooks={quickHooks} /></Suspense>;
}
