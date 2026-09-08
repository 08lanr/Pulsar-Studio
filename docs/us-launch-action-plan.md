# US launch workspace — action plan

## Product contract
Help Chinese platforms select existing inventory for US launch, prepare marketing experiments, and learn from results. Keep market intelligence intact. Do not offer script-development advice or imply that English catalog observations establish US audience demand.

## Implementation sequence
1. Move the existing market overview to /producer/insights with filters and return navigation intact. Make /producer a catalog-first launch dashboard with candidate evidence and campaign decisions.
2. Add an explainable per-title US assessment: inferred shared story tags and linked comparables; observed source date; explicitly unmeasured US appeal; readiness tracked separately. Do not reuse market_score as an American audience probability.
3. Add a concept-test planning flow that works without video. Save through existing tenant-scoped campaign storage. Capture a $100 proposed total, one hypothesis, one audience, a small initial batch, objective, destination, and interpretation limits. Budget is a brief, not an enforced spending control.
4. Retain video creative generation/review and campaign handoff. Allow users to prepare a brief before uploading footage. Clearly disclose that current submission is a mock and does not buy ads.
5. Add customer-owned account setup guidance using TikTok documentation. Distinguish business ownership, ad-account access and identity authorization. No password collection, fabricated connection state or account creation on behalf of the customer.
6. Verify bilingual navigation, tenant isolation, assessment edge cases, no-video brief creation, existing tests, typecheck, production build, and browser flows.

## Live integration delivery gates — not satisfied by UI
- Approved advertising developer application, authorized advertiser account, appropriate scopes and encrypted token storage; revocation and expiry handling.
- Structured immutable approved test/budget records, currency, dates, account and destination; enforce cap through provider budget settings and reconciliation, not creative_direction text.
- Idempotent launch jobs, provider IDs, retry-safe submission, remote-status reconciliation, pause controls, spend monitoring and audit records. Demo handoffs must never be reported as live tests.
- Provider minimum budget and objective eligibility validation at launch time. $100 is a proposed small experiment, not a guarantee of delivery or sufficient evidence.
- Title/creative/test lineage and permissioned outcome ingestion: spend, impressions, clicks, landing actions, attribution window and audience geography. Null is unknown; do not manufacture winners.
- Calibrate ranking only after enough comparable outcomes; separately disclose observational ranking versus measured response. Obtain permission before pooled cross-company benchmarking.

## Acceptance and limitations
Catalog import here uses the existing title intake. Bulk import, verified account connections, autonomous paid launches and outcome-driven ranking require the integration work above. Existing fixture campaign persistence is process-local; Supabase uses the existing production data layer. No migration or credentials are invented for unconnected services.

## Official references checked 2026-09-08
https://business.tiktok.com/agency/
https://ads.tiktok.com/help/article/how-to-remove-a-partners-access-to-an-ad-account?lang=en
https://ads.tiktok.com/resources/help/article/manage-tiktok-accounts-business-center?redirected=2
https://ads.tiktok.com/resources/help/article/budget?lang=en&q=budget&redirected=1

## Current delivery verification
- Implemented catalog-first overview, preserved /producer/insights, title assessment, backend-backed no-video test brief, customer-owned account guidance and explicit mock handoff notices.
- Added 3 tests: missing synopsis does not infer audience response; market return scope survives; no-video campaign brief persists but video generation remains blocked.
- 133 tests passed; typecheck passed. Browser verified saving a no-video $100 planning brief in the existing fixture account. This QA campaign remains a draft and spends nothing.
- No new database migration, deployment, account authorization or paid campaign execution performed. Proposed budgets are explicitly brief text until structured provider-enforced launch records exist.
