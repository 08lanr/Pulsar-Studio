# Audience evidence for selecting the first US titles

Reviewed 2026-09-10. This collection is independent of Studio's fixture campaigns.
No campaign was run, no account was created, and no paid data was purchased.

## Retrieved evidence

- Sensor Tower, *2024 Short Drama Overseas Market Insights*, pages 12–14, hosted copy at https://runwise.co/wp-content/uploads/2024/03/2024%E5%B9%B4%E7%9F%AD%E5%89%A7%E5%87%BA%E6%B5%B7%E5%B8%82%E5%9C%BA%E6%B4%9E%E5%AF%9F%E6%8A%A5%E5%91%8A_Sensor-Tower_2024.pdf . Page 13 reports 72% female among US ReelShort users. The gender chart does not specify its sampling window or sample size. Page 12 qualitatively connects werewolf, billionaire/wealthy-family and vampire stories with Western female audiences. Page 14 describes ReelShort audience overlap with DramaBox and Dreame for Dec 2023–Feb 2024; this is not a DramaBox demographic distribution. This is a historical publication, not a current feed.
- Pew Research Center, https://www.pewresearch.org/internet/fact-sheet/social-media/ . US adult survey, Feb 5–Jun 18, 2025, n=5,022. Transcribed YouTube, Facebook and TikTok age and gender tables. Each percentage is platform use **within** the named population. Age and gender are separate marginal tables. Do not infer intersectional percentages, short-drama consumption, ethnicity-specific genre preferences, or payer behavior.
- YouGov, https://yougov.com/reports/53014-yougov-behavioral-the-rise-of-vertical-shorts-september-2025 , published Sep 18, 2025. Public summary lists five leading US titles by online demand, including Claimed by the Alpha I Hate and Fated to the Alpha. Demand reflects search/social research, not paid viewing. Public summary does not provide exact observation dates, sample size or demographic cross-tabs. The app retains the five names as examples, without inventing rankings or scores.

## Access and missing evidence

- YouTube: https://support.google.com/youtube/answer/9314416?hl=en documents age/gender for the authorized channel's audience. Public competitor video counts do not expose those demographics.
- TikTok: https://ads.tiktok.com/resources/help/article/audience-insights?lang=en documents pre-campaign age/gender and hashtag audience filtering. The inspected browser reached a sign-in surface; no genre-specific audience results were retrieved. Existing campaign results are not required for that documented research feature. No API endpoint has been verified for automated retrieval.
- Facebook: potential-audience tooling is a candidate, but current interest coverage and account access were not verified. No Meta results are represented as obtained.
- No verified US age × gender × genre table, ethnicity × genre table, or DramaBox US age/gender split was obtained. These stay null. A 25–45 white-female audience is not a validated requirement.

## Product implementation

`lib/research/audience.ts` contains the dated, source-linked facts; the US Overview adds a bilingual research section with expandable demand examples, channel demographics, and gaps. It is outside the catalog-snapshot condition, so failed crawls cannot hide it. It does not depend on company profile preferences, demo analytics, or listing filters. No audience score or launch-priority weight is changed. Registered methodology entries preserve original denominators. Publications are available **as dated references**, not labelled as live measurements.

The next useful addition is an authenticated pre-campaign audience export with explicit geography, query, observation window, demographic denominator and baseline; only then can a genre-affinity index be calculated. Do not generate placeholder percentages to complete a matrix.
