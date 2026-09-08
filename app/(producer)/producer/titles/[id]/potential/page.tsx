import { redirect } from "next/navigation";

// The assessment moved into the title workspace as its Preparation section
// (decision 2026-09-09). Old deep links keep working.
export default function PotentialRedirect({ params }: { params: { id: string } }) {
  redirect(`/producer/titles/${params.id}/preparation`);
}
