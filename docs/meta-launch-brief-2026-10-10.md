# Meta ads from Studio: status brief

As of 2026-10-10, 05:30 Pacific. Author: Ruobin. The living copy is a Claude doc shared with the team; this file is its snapshot for the repo.

## Where we stand

Studio can launch Meta ads as of tonight. A paused test campaign on Crazy Drama US was created from Studio end to end: video upload, creative, campaign, two ad sets, two ads. Three real campaigns followed and are live.

The blocker since September was Meta's development-mode rule: an unpublished app cannot create ad creatives (error 1885183). Publishing our app Pulsar Entertainment required business verification, and that verification was rejected three times. The root causes were found today: the submissions pointed Meta at itspulsar.com, whose footer names Pulsar Marketing LLC rather than Pulsar Entertainment, Co., and the document was the self-filed SS-4, which Meta's rules exclude.

Two moves cleared it. The verification was resubmitted correctly (crazydramas.com, domain verification, the Delaware certificate plus the IRS CP 575 letter; Meta quotes about two business days). In parallel a second app, CrazyDramas Ads, with only the Marketing API use case, turned out to need no verification at all and was published the same evening.

## What was built today

| Piece | What it is | State |
| --- | --- | --- |
| CrazyDramas Ads (Meta app 2351806582237831) | Second Meta app under the CrazyDramas portfolio, Marketing API use case only | Published, live |
| Studio token | Never-expiring System User token for that app, scopes for ads and Page reads | In Studio, verified against the ad account |
| Driver fix | Studio compared the creative Meta stored with what it sent, verbatim. Meta appends a date and hash to the name and re-hosts the thumbnail. The check now tolerates exactly those two things | Tests 1107/1107, typecheck and build green; Studio main 03380a9 |
| Rate-limit backoff | Meta's per-ad-account call limit (code 80004) is a wait that doubles per refusal, not a failure; Meta runs go out one at a time | Studio main b6e3ad2 |
| Command line | Draft a Meta launch from a spec file; retry a failed run on its checkpoints | Used for tonight's launches |
| Business verification | Resubmitted with crazydramas.com, domain verification, Delaware certificate and IRS CP 575 | Meta review, about two business days |

The old app, Pulsar Entertainment, stays in place for organic Page and Instagram posting from Studio. That path still waits on the verification.

## The $500 winners test

Three Meta campaigns, $500 lifetime in total, running seven days from Oct 10 to Oct 17, all optimizing for InitiateCheckout on the crazydramas pixel and sending viewers to each series' own Meta link. All three are live as of 05:20 on Oct 10: Cheer Queen (4 ads), Humiliated (6 ads) and Flirt (8 ads), 18 ads across six ad sets, every one ACTIVE or in Meta's review. Approving three runs at once tripped Meta's per-ad-account call limit, which cost about ninety minutes of retries; Studio now backs off on that limit and Meta runs go out one at a time.

| Campaign | Series | Ads | Budget | Why these |
| --- | --- | --- | --- | --- |
| Flirt winners | He Told Me to Flirt With His Rival | 4 clips, 8 ads | $250 | The proven TikTok workhorse: 715 clicks and 25 checkouts on $80 across eight launches, plus the clip Meta already accepted in the test |
| Humiliated winners | He Humiliated Me in Front of the Whole School | 3 clips, 6 ads | $125 | Highest click-through of the set, 5 to 14 percent, with checkouts on small spend |
| Cheer Queen winners | Dumped for the Cheer Queen | 2 clips, 4 ads | $125 | 7 checkouts on $22, the best cost per checkout after Flirt |

Each campaign carries two ad sets, one for Facebook and one for Instagram, splitting its budget evenly. One Meta campaign carries one destination link, which is why the three series are three campaigns rather than one.

The $20 paused smoke campaign was deleted on Oct 10 at 05:30; it never spent and is not part of the test.

## Open items

- [ ] Business verification result, expected by Oct 13. If approved, publish Pulsar Entertainment and organic posting from Studio switches on. If rejected again, the reason arrives by email only; forward it.
- [ ] First Meta read, Oct 12 or 13: spend, checkouts and purchases per campaign on the Studio stats Ads tab, against the TikTok groups running the same clips.
- [ ] Meta ad review: new ads sit in review for up to 24 hours before delivery. Rejections show in Ads Manager and in the Studio Monitor.
- [ ] Pixel event choice: Meta campaigns optimize for InitiateCheckout, the documented Meta default, because purchase volume is still too low for Meta's optimizer. TikTok moved to Purchase today. Revisit once Meta shows purchases.
- [ ] The manual Oct 7 Flirt campaign (campaign-level $50 daily budget, ends Oct 13) is still on beside the new $250 Flirt campaign; decide whether to pause it.
