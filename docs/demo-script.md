# Demo script — the producer's five minutes

Fixture mode (`npm run dev`, no key, no database; state resets on restart).
The canned translations make every step deterministic — nothing is
generated live (docs/decisions.md: replay, never translate new material).

1. **Login** — `/login` → 「以制片方身份进入」. You are 陈总, approver at
   星海影视.
2. **作品管理** — the poster wall. 爱在旅途: 4 集, progress bar, status tag.
   (The dashed card is 新建剧集 — used in step 6.)
3. **The console** — open the title: step strip 上传剧本 → AI 改编 → 逐场确认 →
   定稿; per-episode rows with one action each. Open 第 3 集 (待改编 →
   开始改编).
4. **The button** — 「一键生成美式改编」. The staged readout plays (~4s), then
   the whole episode appears as bilingual cards: original on top, editable
   English below, 回译 + 为什么这样改编 under every changed line. Talking
   points: 沈总 → Sir (cultural), 撤单 → killed the deal (idiom), and the
   flagged 重大改动 on the last line (added "I never did" — the producer
   control story).
5. **Edit → confirm → finalize** — the studio screen: viewer on the left
   (shows the current line when no video is attached), timeline markers,
   scene strip, bilingual script sheet. Click 「董事会想让我消失……」 in the
   sheet — the 审阅与修改 panel shows the explanation, the tag chips, the
   editable English (autosaves), the 回译, and two suggested alternatives —
   tap one to take it; 确认第 1/2/3 场 in the panel; the gold 确认定稿 arms,
   confirm — the command strip shows
   已定稿并存档 plus the snapshot hash, and the bar flips to exports
   (双语对照 / SRT / CSV). Download the 双语对照 — the document a boss can be
   sent on WeChat.
6. **Upload flow (optional)** — 新建剧集 → name it anything → upload
   `docs/demo/aizailvtu-demo-ep1.srt` → 开始改编 → the same script replays
   end to end on a fresh title (22 lines, 3 scenes, 0 unmatched).
7. **The other side (optional)** — 第 1 集 is 待审核: Pulsar submitted this
   version. One bar: 确认定稿 as is, or 自己修改 — which opens an editable
   draft immediately. No requests, no notes, no waiting.

Reset: restart the dev server; the fixture store reseeds itself.


## The founder's own footage (added 2026-09-04)

Minute one of "Video Project 2.mp4" is wired in as a second demo title. The
video's own burned-in English is the LITERAL baseline; Studio's adaptation
is our rewrite — including two lines the original subs translate wrongly
(肯定是上次会议的时候 / 给您留下了深刻印象), which the rationale calls out.

Repeat it any time (state resets on server restart):

1. Producer portal → 新建剧集 → name it (e.g. 向园) → upload
   `docs/demo/xiangyuan-ep1.srt` as 第 1 集 with
   `docs/demo/xiangyuan-ep1.mp4` as the video.
2. Open the episode → 一键生成美式改编 → the bank replays 24 authored lines
   (key phrases highlighted: "brutal", "the famous", "Maybe", "briefing"…).
3. 生成英文配音（演示） → ~30s → the real footage plays with six distinct
   English voices over the ducked original audio.

Talking points: 路上有点堵车 literal "It's the traffic jam" vs ours "Traffic
was brutal"; 你就是向园 flagged 重大改动 (adds "the famous"); 久仰 杨总 with
three alternatives; the two mistranslated lines the pipeline catches.

Extending to episodes 2–5: cut each minute with ffmpeg, extract subs the
same way (tiled frame sheets), author entries into
`data/fixture/canned-user.ts` — or set ANTHROPIC_API_KEY and let the live
model do it instead of the bank.
