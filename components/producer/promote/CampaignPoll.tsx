"use client";

// Keeps the campaign page refreshing while background work runs (renders,
// the launch, clip cutting). Mounted by the page itself, so the refresh
// survives whichever section is on screen (review 2026-09-14: the ad
// section used to own the interval and was unmounted while generating).

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function CampaignPoll({ active, everyMs = 5000 }: { active: boolean; everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(timer);
  }, [active, everyMs, router]);
  return null;
}
