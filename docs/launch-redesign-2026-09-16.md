# Launch and Monitor acceptance — 2026-09-16

## Delivered behavior

- Launch selects the producer's assigned TikTok Business Center or Meta business portfolio before individual accounts. Search, usage filters, quick selection, and per-account names remain available inside an expandable picker.
- TikTok quantity controls sit above the Spark-code field: campaigns per account, Spark codes per campaign, and unique/shared allocation. The counter turns green only when supplied content exactly matches the required amount. The accompanying calculation explains per-account and total requirements. TikTok uploading and Spark-code generation remain manual.
- TikTok presets have a dedicated staff page at `/tiktok/templates`. Launch keeps the preset selector and a settings drawer; custom changes clear the selected preset label when settings differ.
- Validation and launch errors appear beside the bottom preview/launch actions. Submitting a run opens Monitor focused on that run, including the staff journey.
- Monitor lists newest launches first, shows created/approved/checked dates, groups campaigns by account, and offers search, platform and status filters. Campaign and ad-group pause/resume controls have explicit labels. Budget, bid and schedule changes use labeled dialogs; secondary actions live in a menu.
- Launch history reads persisted runs independently of account discovery and clip loading. A provider outage cannot by itself hide existing launch records. Existing tenant boundaries and signed budget ceilings remain enforced.

## Live Xinghai account verification

The user selected Xinghai Pictures and Azenda Germany RB_2. The following bindings were saved through the existing data layer and read back from Supabase and the provider APIs:

| Asset | Verified assignment |
| --- | --- |
| Producer | Xinghai Pictures (`00000000-0000-4000-8000-000000000001`) |
| TikTok Business Center | Azenda Germany RB_2 (`7660802168609538055`) |
| TikTok accounts | 30 discovered; 13 enabled and exposed by the live Launch workspace |
| Meta ad account | Crazy Drama US (`act_4565068993810003`) |
| Meta portfolio | CrazyDramas (`1713297459750982`) |
| Facebook Page | CrazyDramasUS (`1298189526712840`) |
| Instagram identity | @crazydramasus (`17841434498347152`) |

The live workspace returned no account warnings. A requested magic-link email signed the user into the live browser as Ruobin, Administrator. The browser showed the assigned Business Center, its 13 eligible account choices, and the assigned Meta account. Existing provider campaign counts were read, not created by this test.

Meta returned the Instagram identity for the ad account and the Page among accessible Pages, but omitted the Page linkage and ad-account promotion-page fields. Final Page/ad-account/creative compatibility still requires Meta's validation of an actual creative. No real ads were created or activated during this acceptance pass.

## Verification

- 333 unit tests passed, including account-authority, immutable-budget, retry, tenant-scoped history, and live/fixture Meta cache separation coverage.
- TypeScript and ESLint passed.
- Production build passed in a separate output directory.
- All 34 browser cases passed across desktop and presentation viewports. The broad run had 30 passes, one interrupted catalog navigation and three dependent skips; the full presentation demo group then passed 5/5 without code changes. The final Launch/Monitor rerun passed 10/10 together, including staff run focus after the last UI refinements. Logs: `tmp/redesign-all-e2e.log`, `tmp/redesign-demo-recheck.log`, `tmp/redesign-final-e2e.log`.
- Screenshots reviewed: Launch preview and Monitor at desktop size; account-card and provider-copy corrections followed visual review.
- Browser tests own port 3202 with fixture persistence disabled. They do not reset the interactive demo on port 3200. The existing saved Demo Launch remains present there.

## Entry points and next real pilot

- Demo, existing persona buttons: `http://localhost:3200/login`.
- Demo producer Launch: `http://localhost:3200/producer/launch`.
- Demo producer Monitor: `http://localhost:3200/producer/monitor`.
- Live staff Launch/Monitor: `http://localhost:3203/promote/launches`. Select Xinghai Pictures. Start with `npm run dev:live` if this separate server is stopped.

The next real pilot needs a chosen ad account, real manually generated Spark code(s) or Meta creative(s), and a reviewed budget and schedule. The supplied destination is `https://crazydramas.com`. Keep the first launch paused, preview the exact allocation, and approve that concrete plan. The default form budget is not evidence of user approval. Revenue, Pixel, and Conversions API remain deferred to the later phase requested by the user.
