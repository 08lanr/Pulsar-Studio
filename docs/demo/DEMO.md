# The demo dataset and the rehearsal journey

Fixture mode (`DATA_SOURCE` unset) seeds one coherent journey so a rehearsal
can be repeated from the same rows every time. Everything below is invented
and labelled as such in the UI ("Demo dataset" chip in the top bar, "Demo
results (simulated)" on every result, `source: "demo"` on the rows).

## The journey

1. **Market signal.** Overview → *What to make next*: the story types the US
   platforms are launching now (ReelShort and DramaBox public catalogs, two
   published days), with views added per platform since the last collection
   and the owned titles that carry each story type.
2. **Matching title.** "Reborn as the CEO's First Love" (title 1) carries
   CEO/rebirth/revenge, has six episodes with video, two finalized subtitle
   episodes, imported August reports and the highest US-potential score.
3. **Ads.** Campaign 1 on title 1 ("Rebirth vs romance opening — US test,
   round 1") has five generated ads; two were chosen and approved with an
   immutable manifest, the budget was approved, and the launch is a demo
   handoff (no provider, no spend).
4. **Demo results.** Two demo-labelled result rows for the chosen ads. The
   results page reads them against the Studio-wide benchmarks (hook hold ≥
   30 %, CTR ≥ 1.2 %), names the ad that met both, shows the underlying
   metrics with CPM/CPC/cost per action and provenance, and offers the next
   round (scale the best ad / test more ads / stop).
5. **A second campaign to run live in the rehearsal.** Campaign 2 on "Bride of
   the Wolf King" has five ads in review: choose → approve ads → approve
   budget → launch → simulate demo results → decide, all on the fixture.

Every episode with video points at `docs/demo/xiangyuan-ep1.mp4` (hard
linked into `.uploads/` by the fixture store), so ad previews and the
subtitle studio play. One campaign per title; nothing in the seed duplicates
anything else.

## Reset

- In the UI: the **Reset demo** button in the top bar (fixture mode only).
- From a shell, against the running dev server:

```bash
npm run demo:reset
```

`--seed empty` gives the bare seed; `--url` points at another port. The
route behind both is `POST /api/demo/reset`; it answers 404 in Supabase mode,
so production data can never be reseeded from the fixture.

## End-to-end smoke test

```bash
npm run test:e2e
```

Playwright (`tests/e2e/demo-journey.spec.ts`, `playwright.config.ts`) reuses a
running `npm run dev` or starts one, resets the demo, and exercises: overview
→ what to make next → Explore with filters (and filter persistence across a
reload) → catalog search/band filter/zero-result recovery → title potential →
campaign 2 through choose, change request, approve, budget, launch, demo
results, reload persistence and the next round → API error feedback (409 out
of order, 400 invalid, 404 foreign) and form validation → a check that no
request leaves localhost while demo actions run. Two projects: `desktop`
(1440×900) and `presentation` (1920×1080). Screenshots land in
`docs/demo/e2e/<project>/`.

The unit side (`npm test`) covers the seed's shape, media linking, the reset,
the results reading and round naming (`tests/results-decision.test.ts`).
