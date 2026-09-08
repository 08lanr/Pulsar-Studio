# Producer UI and wording review
Date: 2026-09-08

This review follows two simulated users: a producer arriving for the first time, and the same producer returning after one or two days. These are heuristic walkthroughs, not interviews with real customers. The focus is comprehension, clear next actions, and whether wording matches the code.

The central problem was inconsistent language for the same object or action. A producer had to learn that “US potential,” “launch priority,” and “Preparation” described the same assessment; that selecting an ad and approving a campaign were separate operations; and that “Launch” currently records a demo handoff.

The implemented changes preserve the existing design and workflows. Both English and Chinese copy were updated. Approval rules, scoring weights, real provider integrations, and the subtitle-generation pipeline were not redesigned.

## First visit: “I have a drama. What do I do here?”

Scenario: a Chinese mini-drama producer has a Chinese title, some footage, and a rough US advertising idea. They do not know Studio's internal product names.

| Priority | Where / producer's question | Finding | Resolution |
|---|---|---|---|
| P2 | Catalog: “Does title mean a show or an ad headline?” | The catalog did not establish the object being managed. | The introduction now says “drama series.” The campaign form identifies the “Drama to advertise,” and the campaign name is explicitly internal. |
| P2 | Score: “Does 68 mean a 68% chance of success?” | “US potential,” “launch priority index,” and “Preparation” competed. The score looked more predictive than its inputs warrant. | Use “US launch priority” consistently in the column, section navigation, assessment, and related copy. Explain the 0–100 scale and that it prioritizes tests rather than predicts success. |
| P2 | Add title: “Do I need every subtitle file before starting?” | The heading required scripts even though the form can create a title without files. “Create and upload” also implied an upload. | Explain that only the Chinese name is required; videos and subtitles can follow later. The action now says “Add title.” |
| P2 | Episode upload: “What are Adapt and Promote?” | The instructions used internal tool names before explaining the job. | Explain the prerequisites directly: ads need video; English subtitle adaptation needs script/subtitle text. Keep the filename-matching example. |
| P2 | Campaign picker: “Ready for what?” | A “Ready” badge only checked whether footage existed. | It now says “Video uploaded.” An empty picker explains how to add a drama and return. |
| P2 | New campaign: “Am I making an ad, running a test, or buying media?” | The form did not define a campaign or explain the next screen. | Define one campaign as one round for one drama. “Save campaign brief” creates a draft; the next step generates proposals to select. |
| P2 | Brief: “What do I write under Hypothesis?” | Marketing jargon and hidden minimum lengths made the disabled action difficult to interpret. | Use “What do you want to test?” and “Target audience,” with examples, visible minimums, and associated input descriptions. |
| P2 | Brief: “Which fields are optional?” | Optional creative-direction fields looked required; some labels were not associated with controls. | Mark optional direction/exclusions, associate labels with inputs, localize country options, and apply the API's length limits to text fields. |
| P2 | Accounts: “Did this connect my TikTok account?” | “Add account” and editable “Connected” status could be mistaken for OAuth or a live verification. | “Record an existing account,” “Reported status,” and explicit copy explain that saving sends no invitation and starts no sync. |
| P2 | Market: “Should I commission this because the site says make now?” | “Make-now briefs” and “clone brief” implied a stronger recommendation than recurring public listing tags support. | “Story ideas to explore” presents starting points. The page identifies English public catalogs and unverified viewer location/demand. |
| P2 | Research statistics: “Why do shares exceed 100%? What is lift?” | Several labels assumed statistical vocabulary. | Explain multiple story tags, the 1.2× example, the number of listings behind a median, and small-sample limitations. |
| P2 | Episodes: “Are these approval statuses about my ads?” | Materials mixed subtitle progress with the larger launch workflow. | Rename the section “Episodes & subtitles,” identify subtitle finalization, and explain that ads can use footage before subtitle adaptation is complete. |

Expected path after the changes: add a drama → optionally upload episodes → save a campaign brief → generate proposals → choose ads → approve ads → approve the saved budget → submit the demo → inspect results.

## Day two: “I know the areas. Can I trust what happens next?”

Scenario: the producer returns to compare campaigns, change a budget, request revisions, and understand whether the next test is worth planning.

| Priority | Where / producer's question | Finding | Resolution |
|---|---|---|---|
| P1 | Budget: “I changed it to $150. Why would approval use $100?” | The editable form could show unsaved changes while approving the stored experiment. | Disable budget approval while any brief field differs from the saved record. Show an explicit save-first message. The existing journey test now exercises the $100 → $150 → $100 case. |
| P2 | Ad selection: “I selected it. Why do I approve again?” | Selection and campaign approval were easy to conflate. | Explain that selection builds the batch, approval locks its content, and budget/submission follow separately. The planned ad count is identified as a plan rather than an enforced selection limit. |
| P2 | Ad preview: “Is this the finished video viewers will see?” | The player loads source episode footage; it does not represent the final rendered ad. | Explain the preview's scope and point users to the proposed time range. |
| P2 | Change request: “Has someone actually started working on this?” | A stored request immediately said “Pulsar is working on this change.” | It now says the request is awaiting Pulsar review. |
| P1 | Launch: “Did this just put an ad live?” | The submit handler uses the mock handoff in both data backends. “Launch” overstated the action. | The actual button says “Submit demo launch.” Budget and submission guidance explicitly describe this build's behavior. |
| P2 | Campaign list: “Is this spend for the whole title or this round?” | Each row reads its own campaign results, but the column said “all rounds to date.” | Change the label to “this round to date.” Show both benchmark definitions rather than an unexplained single percentage. |
| P2 | Waiting filter: “Why is an in-progress job in Waiting for results?” | The bucket includes generation, failures, and submitted campaigns. | Name it “In progress / waiting.” Existing row-specific explanations still identify the actual condition. |
| P2 | Results: “Does passing these numbers mean it is profitable?” | “Above both benchmarks = worth more spend” was stronger than the calculation supports. | Explain that meeting the benchmarks is a reason to consider another test, not evidence of profitability. Expand click-through rate and define it. |
| P2 | No impressions: “Why did the ad fail if nobody saw it?” | The finding sentence fell through to a missed-benchmark statement. | Add a no-impressions explanation and a no-performance-data message when all rows lack impressions. |
| P2 | Next round: “Did this increase the current campaign's budget?” | The action creates a separate campaign draft rather than editing the current spend. | Use “Draft a $… test” and “Draft another test.” Explain the new round and its creative direction. |
| P2 | Stop here: “Did I stop the running campaign?” | This option is only a link back to the list. | Rename it “Decide later” and explicitly state that it does not pause or stop a campaign. |
| P2 | TikTok comparison: “Are these numbers for identical dates?” | “One window” obscured that each title ends on its own latest reporting date. | Explain the varying dates and coverage. Expand the D30 column and describe mature viewer groups and gross revenue per starting viewer. |
| P2 | Profile save: “Did my edit work? Why am I back in my catalog?” | Saving navigated to an obsolete producer query route that redirects to the catalog. | Return to Company & accounts and display a saved confirmation. |
| P1 | Reset demo: “Did this reset the view or erase my work?” | The toolbar reset immediately replaces the fixture dataset. | Add a confirmation naming the local title, campaign, and sample-result changes being replaced. |
| P2 | Read-only campaign: “Why can I fill this out but not save it?” | The creation page only treated staff preview as read-only, despite viewer-role API restrictions. | Pass the viewer restriction into the form, disable fields and spoiler controls, and show the existing read-only explanation. |
| P3 | Catalog filters: “How do I get all my titles back?” | Clearing a band required clicking the active band again or resetting after zero results. | Add an explicit “All titles” option that preserves search/sort. |

## Remaining product gaps

These are recorded separately because they need behavior or product decisions beyond a copy correction. The current changes do not claim to solve them.

1. **P1 — Partial upload recovery can create duplicate titles.** In `components/producer/NewTitleForm.tsx`, creation happens before the episode upload loop. A failed upload returns to the same submit action; another attempt starts with another create request. Retain the created title identity, show which episodes succeeded, and resume only failed uploads. This was found in code; the failure was not injected into the user's running workspace.

2. **P2 — The preparation checklist lacks an obvious edit path for several inputs.** The preparation page explains points for synopsis, rights, and readiness, but its prominent routes lead to campaigns, market comparisons, and episode files. Add a title-details editor or direct actions beside the relevant missing facts. Review `app/(producer)/producer/titles/[id]/preparation/page.tsx` and `components/producer/TitleShell.tsx`.

3. **P2 — A selected ad has no simple deselect action.** In `PromoWorkspace.tsx`, the selected button disables itself. Requesting changes is a different intent. Add “Remove from this round” before campaign approval, with a valid backend transition; do not equate deselection with a revision request.

4. **P2 — Goals and result judgments are not fully aligned.** The brief accepts views, installs, and subscriptions, but the results verdict is based on opening retention and click-through thresholds. The wording now explains those actual thresholds; it does not make an install/subscription outcome appear where none exists. Define goal-specific success criteria and required reporting before presenting those choices as equivalent measurements.

5. **P2 — Some producer errors still expose generic or English API messages.** Form constraints prevent several avoidable failures, but `lib/api-client.ts` and callers still surface raw server errors. Introduce stable error codes with localized recovery guidance and field-specific messages.

6. **P2 — CSV imports need a producer-facing template.** `ReportImport.tsx` has preview and validation, but no template-download affordance. The surrounding page exposes metric/schema names. Add a sample file with a filled example row and explain how to match a title before the user uploads.

7. **P2 — The market growth summary needs tighter comparison scope.** `lib/research/next.ts` computes each listing's growth against its own platform baseline, then pools those percentage changes across platforms for a story-type median. The revised copy describes that actual calculation. A platform selector or separate medians would better support interpretation; a median based on one listing should not be treated as broad demand evidence.

8. **P2 — Company goals shown on the profile are not all editable in the profile form.** The company page shows a US goal and monthly budget, while `OnboardingForm.tsx` edits story interests, audience, distribution, volume, and markets. Give those displayed planning fields an explicit edit path.

9. **P2 — The primary live-service flow remains incomplete.** Account records are not connections, launch submission is a mock, and the ad review player previews source footage. The UI now states this truth. Actual publishing, provider synchronization, and finished creative review need their own implementation and acceptance criteria.

## Coverage and limits

- Browser walkthrough: Chinese sign-in/catalog; English catalog, add-title form, title overview, episode list, subtitle editor, campaign list and creation, market overview, “What to make next,” company/profile/accounts, TikTok comparison, and data sources. The revised campaign form was also inspected at phone width in English and Chinese.
- Code review: shared producer navigation, title shell, uploads, campaign creation/selection/approval/results, profile/accounts, research calculations and source definitions, CSV import, simulation, and the relevant handlers/data transitions.
- Existing automated journeys cover market → catalog → title → campaign; selection → content approval → budget approval → submission → results → next round; TikTok linking/conflicts, revenue, episode retention, attribution, date-range persistence, empty states, and responsive layouts.
- This is a producer-facing UI review, not a security audit or a full staff-portal review. Real paid media, real provider accounts, and live AI generation were not exercised. Static review findings are distinguished from browser-reproduced behavior above.
- Visual identity, scoring weights, and subtitle-generation behavior remain unchanged. Legacy unused copy was not treated as evidence that a producer actually sees that screen.

## Validation

- `npm test`: **173 passed**.
- `npm run typecheck`: **passed**.
- `npm run build`: **passed**, using a separate build directory.
- `npm run test:e2e`: **22 passed** across desktop and presentation configurations; includes the existing accessibility checks and 390/1024px analytics inspections.
- After the final results wording adjustment, the complete campaign journey was rerun in both configurations: **2 passed**.
- Manual phone-width inspection of the updated campaign form: no horizontal document overflow; English and Chinese labels and help text render.
- E2E fixture resets ran on a separate review server at port 3201, not the user's development server at 3200.

## Selected screenshots

- [Updated catalog](producer-ui-2026-09-08/catalog.jpg)
- [Campaign form and validation guidance](producer-ui-2026-09-08/campaign-form.jpg)
- [Campaign results](producer-ui-2026-09-08/results.jpg)
