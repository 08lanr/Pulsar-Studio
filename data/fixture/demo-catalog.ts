// The demo catalog (decision 2026-09-08, "US launch workspace"): a studio
// with a broad, uneven catalog so every screen of the workspace has
// something real to show and the workflow can be stress-tested. Fourteen
// titles in different states of readiness, a company profile, watchlist,
// imported reports, four experiments at different stages (one with
// demo-labelled results) and the customer's account inventory.
//
// Everything here is invented and deterministic (stable ids, one timeline).
// It seeds fixture mode by default; FIXTURE_SEED=empty restores the bare
// seed the localization demo and the workflow tests expect.
//
// The demo journey (one coherent path, decision 2026-09-09): the market
// board shows CEO/rebirth/revenge stories launching → title 1 carries them
// and is the best-scored owned title → campaign 1 on title 1 has chosen
// ads, immutable approvals, a demo handoff and demo-labelled results → the
// results page explains the winner and offers the next round. Every
// episode with video points at a real file (docs/demo/xiangyuan-ep1.mp4,
// linked into .uploads/ by the fixture store) so ad previews play. One
// campaign per title: nothing in the seed is a duplicate of anything else.

import type {
  AdaptedLine,
  Adaptation,
  CompanyAccount,
  CreativeResult,
  Episode,
  Line,
  PromoApproval,
  PromoCampaign,
  PromoCreative,
  PromoHandoff,
  PromoLaunch,
  Scene,
  Title,
  Version,
} from "@/lib/types";
import type { ReportBatch, ReportRow, ResearchProfile, WatchRow } from "@/lib/research/types";
import { PRODUCER_ID, PRODUCER_USER_ID, STAFF_USER_ID, ext, uuid } from "./ids";
import { buildVersionSnapshot, snapshotSha256 } from "./snapshot";

const B = { title: 0x30, episode: 0x31, scene: 0x32, line: 0x33, adapted: 0x34, version: 0x35, adaptation: 0x36, campaign: 0x37, creative: 0x38, result: 0x39, account: 0x3a, batch: 0x3b, row: 0x3c, approval: 0x3d, handoff: 0x3e, launch: 0x3f } as const;

/** The demo studio's TikTok ad account (assigned by staff from Pulsar's Business Center; a fake advertiser id, never a real one). */
export const DEMO_ADVERTISER_ID = "7000000000000000001";
export const DEMO_IDENTITY_ID = "7000000000000000101";

const AT0 = "2026-07-15T02:00:00.000Z";
const AT1 = "2026-08-20T06:00:00.000Z";
const AT2 = "2026-09-01T03:00:00.000Z";
const AT3 = "2026-09-06T09:00:00.000Z";

type Adapt = "none" | "draft" | "approved";

type Spec = {
  n: number;
  zh: string;
  en: string;
  genre: string;
  syn_zh: string;
  syn_en: string;
  episodes: number;
  license: [string | null, string | null];
  china: { views: number; completion_rate: number; paying_rate: number } | null;
  /** Episodes seeded: [ingested, with video]. */
  materials: [number, number];
  adapt: Adapt;
  logline: string;
};

export const DEMO_TITLES: Spec[] = [
  { n: 1, zh: "重生后我成了霸总的白月光", en: "Reborn as the CEO's First Love", genre: "都市 · 重生 · 爱情", syn_zh: "林晚重生回到离婚前夜。这一次她不再隐忍，要向背叛她的前夫复仇，也要在霸总沈亦辰面前藏起自己真实的身份。", syn_en: "Lin Wan wakes up on the night before her divorce. This time she will take revenge on the husband who betrayed her, and keep her true identity hidden from CEO Shen Yichen.", episodes: 80, license: ["2026-06-01", "2027-12-31"], china: { views: 62_000_000, completion_rate: 0.58, paying_rate: 0.041 }, materials: [6, 6], adapt: "approved", logline: "She died betrayed. She woke up with a plan." },
  { n: 2, zh: "战神归来", en: "The War God Returns", genre: "男频 · 战神 · 复仇", syn_zh: "五年前被家族抛弃的私生子，如今是北境战神。他带着军功回到都市，为母亲复仇，也让当年看不起他的人一一打脸。", syn_en: "Abandoned by his family five years ago, he returns from the northern front as the War God, out for revenge on those who wronged his mother.", episodes: 100, license: ["2024-01-01", "2025-06-30"], china: { views: 120_000_000, completion_rate: 0.63, paying_rate: 0.052 }, materials: [3, 3], adapt: "none", logline: "They threw him out. He came back with an army." },
  { n: 3, zh: "闪婚后总裁每天都在真香", en: "Flash Marriage with the Cold CEO", genre: "都市 · 甜宠 · 契约婚姻", syn_zh: "为了拿到爷爷的遗产，苏念和冷面总裁顾泽闪婚。契约婚姻说好互不干涉，谁知总裁每天都在真香，宠妻宠到停不下来。", syn_en: "To claim her grandfather's inheritance, Su Nian flash-marries the cold CEO Gu Ze. A contract marriage, no strings attached, until he cannot stop spoiling his wife.", episodes: 72, license: ["2026-09-01", "2028-08-31"], china: { views: 41_000_000, completion_rate: 0.55, paying_rate: 0.033 }, materials: [0, 0], adapt: "none", logline: "A fake marriage. A very real husband." },
  { n: 4, zh: "假千金的逆袭", en: "The Fake Heiress Strikes Back", genre: "都市 · 真假千金 · 大女主", syn_zh: "真千金回归，假千金被赶出家门。所有人都以为她会一蹶不振，没人知道她隐藏的身份是全球顶尖设计师。这是一场大女主的复仇与逆袭。", syn_en: "When the real heiress returns, the fake heiress is thrown out. Nobody knows her hidden identity: a world-class designer. A strong heroine's revenge and comeback.", episodes: 90, license: [null, null], china: { views: 33_000_000, completion_rate: 0.51, paying_rate: 0.029 }, materials: [4, 4], adapt: "draft", logline: "They called her fake. She built an empire." },
  { n: 5, zh: "带着萌宝去复仇", en: "Revenge with My Twins", genre: "都市 · 萌宝 · 复仇", syn_zh: "五年前被陷害的她带着一对天才双胞胎萌宝回国，孩子的爸爸是那个不知情的霸总。这一次，她要带着孩子复仇。", syn_en: "Framed five years ago, she returns with genius twins whose father is the unknowing billionaire. This time she brings the babies to her revenge.", episodes: 96, license: ["2026-01-01", "2027-06-30"], china: { views: 88_000_000, completion_rate: 0.6, paying_rate: 0.047 }, materials: [2, 0], adapt: "none", logline: "Two babies. One secret. Zero mercy." },
  { n: 6, zh: "狼王的替嫁新娘", en: "Bride of the Wolf King", genre: "奇幻 · 狼人 · 替嫁", syn_zh: "姐姐逃婚，妹妹替嫁给传说中残暴的狼王。契约成婚的新娘却发现狼王的温柔只给她一人。甜宠奇幻爱情。", syn_en: "Her sister ran from the wedding, so she took her place as the bride of the feared Wolf King. A contract bride who finds his gentleness is hers alone.", episodes: 60, license: ["2026-03-01", "2027-12-31"], china: { views: 27_000_000, completion_rate: 0.57, paying_rate: 0.038 }, materials: [5, 5], adapt: "approved", logline: "Sold to the wolf king. Claimed by his heart." },
  { n: 7, zh: "离婚后前夫跪求复合", en: "After the Divorce, He Begged", genre: "都市 · 破镜重圆 · 打脸", syn_zh: "离婚后她成了商界女王，前夫和白月光一起破产，如今前夫跪求复合。打脸、破镜重圆、大女主爽剧。", syn_en: "After the divorce she became a business queen; her ex-husband and his first love went bankrupt. Now he begs for a second chance.", episodes: 85, license: ["2026-05-01", "2027-10-31"], china: { views: 54_000_000, completion_rate: 0.59, paying_rate: 0.044 }, materials: [0, 0], adapt: "none", logline: "He chose wrong. Now he's on his knees." },
  { n: 8, zh: "赘婿崛起", en: "Rise of the Son-in-Law", genre: "男频 · 赘婿 · 逆袭", syn_zh: "入赘三年被全家看不起的赘婿，其实是隐藏身份的商业帝国继承人。一朝身份曝光，逆袭打脸。", syn_en: "Looked down on for three years as a live-in son-in-law, he is secretly the heir to a business empire. The reveal turns the tables.", episodes: 120, license: ["2025-10-01", "2026-10-31"], china: { views: 150_000_000, completion_rate: 0.65, paying_rate: 0.056 }, materials: [8, 8], adapt: "none", logline: "The husband they mocked owns the company." },
  { n: 9, zh: "穿越80年代当首富", en: "Back to the 80s: Richest Man", genre: "男频 · 穿越 · 家庭", syn_zh: "穿越回到80年代，带着记忆的他决定改变家庭命运，从小人物逆袭成首富。", syn_en: "Sent back to the 80s with his memories intact, he sets out to change his family's fate and rise from nobody to the richest man.", episodes: 70, license: ["2023-01-01", "2024-12-31"], china: { views: 19_000_000, completion_rate: 0.49, paying_rate: 0.02 }, materials: [0, 0], adapt: "none", logline: "Same town. Second life. First fortune." },
  { n: 10, zh: "隐婚总裁的替身情人", en: "The Substitute Lover", genre: "都市 · 替身 · 虐恋", syn_zh: "她是白月光的替身，是总裁隐婚的妻子。虐恋情深，背叛与真相交织，她终于决定离开。", syn_en: "She is the stand-in for his first love and his secret wife. A dark, painful romance of betrayal and truth, until she decides to leave.", episodes: 80, license: ["2026-02-01", "2027-08-31"], china: { views: 45_000_000, completion_rate: 0.53, paying_rate: 0.036 }, materials: [3, 3], adapt: "draft", logline: "He married her to forget someone else." },
  { n: 11, zh: "神医下山", en: "The Divine Doctor Descends", genre: "男频 · 玄幻 · 逆袭", syn_zh: "山中修炼十年的神医下山，凭借一手医术和隐藏身份，从小人物逆袭，打脸所有看不起他的人。", syn_en: "After ten years of training, the divine doctor comes down the mountain. With his skills and a hidden identity, the nobody rises.", episodes: 110, license: ["2026-04-01", "2028-03-31"], china: { views: 98_000_000, completion_rate: 0.62, paying_rate: 0.05 }, materials: [0, 0], adapt: "none", logline: "A nobody with a cure for everything, including arrogance." },
  { n: 12, zh: "宫墙柳", en: "Willows Behind the Palace Wall", genre: "古装 · 宫斗 · 大女主", syn_zh: "入宫为婢的女子一步步在宫斗中崛起，为家族复仇，成为掌权的皇后。古装大女主宫斗剧。", syn_en: "A palace maid rises through court intrigue to avenge her family and become the empress who holds power.", episodes: 60, license: ["2026-01-01", "2027-12-31"], china: { views: 22_000_000, completion_rate: 0.5, paying_rate: 0.027 }, materials: [2, 2], adapt: "none", logline: "Every wall in the palace has ears. She has a plan." },
  { n: 13, zh: "校园甜心", en: "Campus Sweetheart", genre: "校园 · 青春 · 甜宠", syn_zh: "校园里的学霸与体育生的甜宠青春故事，暗恋、心动与成长。", syn_en: "A sweet campus romance between the top student and the athlete: secret crushes, first heartbeats, growing up.", episodes: 40, license: ["2026-06-01", "2027-06-30"], china: { views: 12_000_000, completion_rate: 0.47, paying_rate: 0.015 }, materials: [0, 0], adapt: "none", logline: "First love, final exams." },
  { n: 14, zh: "末世求生：我有一座物资仓库", en: "Last Warehouse", genre: "男频 · 末世 · 逆袭", syn_zh: "末世降临，丧尸横行。普通人凭借一座隐藏的物资仓库在末日求生，从小人物逆袭成幸存者领袖。", syn_en: "The apocalypse comes and the dead walk. An ordinary man survives on a hidden warehouse of supplies and rises to lead the survivors.", episodes: 90, license: ["2026-07-01", "2028-06-30"], china: { views: 36_000_000, completion_rate: 0.56, paying_rate: 0.031 }, materials: [0, 0], adapt: "none", logline: "Everyone is starving. He has a warehouse." },
];

/** The real clip every demo episode video points at (62 s, never dubbed). */
export const DEMO_CLIP_SOURCE = "docs/demo/xiangyuan-ep1.mp4";
export const DEMO_CLIP_MS = 62_000;

export const demoTitleId = (n: number) => uuid(B.title, n);
export const demoEpisodeId = (n: number, ep: number) => uuid(B.episode, n * 100 + ep);
const sceneId = (n: number, ep: number, s: number) => uuid(B.scene, n * 10000 + ep * 100 + s);
const lineId = (n: number, ep: number, seq: number) => uuid(B.line, n * 10000 + ep * 100 + seq);
const adaptedId = (n: number, ep: number, seq: number) => uuid(B.adapted, n * 10000 + ep * 100 + seq);
const versionId = (n: number, ep: number) => uuid(B.version, n * 100 + ep);
const adaptationId = (n: number) => uuid(B.adaptation, n);
export const demoCampaignId = (n: number) => uuid(B.campaign, n);
const creativeId = (c: number, k: number) => uuid(B.creative, c * 100 + k);

const ZH_LINES = ["你以为我还会像从前一样忍气吞声吗？", "这一次，我不会再让任何人替我做决定。", "沈总，我们之间早就两清了。", "你到底是谁？", "我是你永远猜不到的那个人。", "别再靠近我。"];
const EN_LINES = ["You think I'll keep my head down like before?", "This time nobody decides for me.", "Mr. Shen, we settled up a long time ago.", "Who are you, really?", "The one person you'll never guess.", "Don't come any closer."];

export type DemoSeed = {
  titles: Title[];
  episodes: Episode[];
  adaptations: Adaptation[];
  scenes: Scene[];
  lines: Line[];
  adapted_lines: AdaptedLine[];
  versions: Version[];
  profile: ResearchProfile;
  watchlist: WatchRow[];
  report_batches: ReportBatch[];
  report_rows: ReportRow[];
  campaigns: PromoCampaign[];
  creatives: PromoCreative[];
  approvals: PromoApproval[];
  handoffs: PromoHandoff[];
  launches: PromoLaunch[];
  results: CreativeResult[];
  accounts: CompanyAccount[];
};

export function buildDemoSeed(): DemoSeed {
  const titles: Title[] = [];
  const episodes: Episode[] = [];
  const adaptations: Adaptation[] = [];
  const scenes: Scene[] = [];
  const lines: Line[] = [];
  const adapted_lines: AdaptedLine[] = [];
  const versions: Version[] = [];

  for (const s of DEMO_TITLES) {
    const id = demoTitleId(s.n);
    const title: Title = {
      id,
      external_id: ext("ttl", `demo:${s.n}`),
      producer_id: PRODUCER_ID,
      name_zh: s.zh,
      name_en: s.en,
      genre: s.genre,
      synopsis_zh: s.syn_zh,
      synopsis_en: s.syn_en,
      character_notes: null,
      logline_zh: null,
      logline_en: s.logline,
      episode_count: s.episodes,
      source_locale: "zh-CN",
      status: s.materials[0] > 0 ? "selected" : "candidate",
      china_metrics: s.china ?? {},
      localization_effort: null,
      deliverables: { clean_master: s.materials[1] > 0, dialogue_stem: false, script_or_srt: s.materials[0] > 0, music_note: "" },
      notes: null,
      license_start: s.license[0],
      license_end: s.license[1],
      created_at: AT0,
      updated_at: s.adapt !== "none" ? AT2 : AT1,
    };
    titles.push(title);
    const adaptation: Adaptation = { id: adaptationId(s.n), external_id: ext("ad", `demo:${s.n}:en-US`), title_id: id, target_locale: "en-US", label: "U.S. general", display_title_en: s.en, created_by: STAFF_USER_ID, created_at: AT1 };
    adaptations.push(adaptation); // every title has its en-US adaptation row, as createTitle would make
    for (let ep = 1; ep <= s.materials[0]; ep++) {
      const episode: Episode = {
        id: demoEpisodeId(s.n, ep),
        external_id: ext("ep", `demo:${s.n}:${ep}`),
        title_id: id,
        number: ep,
        name_zh: `第${ep}集`,
        name_en: `Episode ${ep}`,
        duration_ms: ep <= s.materials[1] ? DEMO_CLIP_MS : 95_000 + ep * 3_000,
        source_script_path: `${id}/episode-${ep}/source.srt`,
        script_format: "srt",
        has_timecodes: true,
        video_path: ep <= s.materials[1] ? `${id}/episode-${ep}/source.mp4` : null,
        created_at: AT1,
      };
      episodes.push(episode);
      // Two scenes of three lines each; enough for readiness math and a plausible sheet.
      const epScenes: Scene[] = [];
      const epLines: Line[] = [];
      for (let sc = 1; sc <= 2; sc++) {
        const scene: Scene = { id: sceneId(s.n, ep, sc), external_id: ext("sc", `demo:${s.n}:${ep}:${sc}`), title_id: id, episode_id: episode.id, number: sc, start_ms: (sc - 1) * 45_000, end_ms: sc * 45_000, context_zh: null, context_en: null, status: s.adapt === "approved" ? "approved" : "draft", status_by: null, status_at: null, created_at: AT1 };
        epScenes.push(scene);
        for (let k = 0; k < 3; k++) {
          const seq = (sc - 1) * 3 + k + 1;
          epLines.push({ id: lineId(s.n, ep, seq), external_id: ext("ln", `demo:${s.n}:${ep}:${seq}`), title_id: id, scene_id: scene.id, seq, speaker: k % 2 ? "男主" : "女主", character_id: null, start_ms: (seq - 1) * 15_000, end_ms: (seq - 1) * 15_000 + 4_000, duration_ms: 4_000, text_zh: ZH_LINES[(seq - 1) % ZH_LINES.length], literal_en: s.adapt === "none" ? null : EN_LINES[(seq - 1) % EN_LINES.length], merged_into_id: null, created_at: AT1 });
        }
      }
      scenes.push(...epScenes);
      lines.push(...epLines);
      if (s.adapt === "none") continue;
      const approvedEp = s.adapt === "approved" && ep <= 2; // the first two episodes are finalized
      const version: Version = {
        id: versionId(s.n, ep),
        external_id: ext("ver", `demo:${s.n}:${ep}:1`),
        title_id: id,
        adaptation_id: adaptation.id,
        episode_id: episode.id,
        number: 1,
        parent_version_id: null,
        status: approvedEp ? "approved" : "draft",
        submitted_at: approvedEp ? AT2 : null,
        submitted_by: approvedEp ? PRODUCER_USER_ID : null,
        approved_at: approvedEp ? AT2 : null,
        approved_by: approvedEp ? PRODUCER_USER_ID : null,
        approval_mode: approvedEp ? "in_app" : null,
        approval_evidence: null,
        approval_note: null,
        snapshot: null,
        snapshot_sha256: null,
        created_at: AT1,
        updated_at: AT2,
      };
      const adaptedCount = s.adapt === "approved" ? epLines.length : Math.ceil(epLines.length / 2);
      const epAdapted: AdaptedLine[] = epLines.slice(0, adaptedCount).map((l) => ({
        id: adaptedId(s.n, ep, l.seq),
        external_id: ext("al", `demo:${s.n}:${ep}:${l.seq}`),
        title_id: id,
        version_id: version.id,
        scene_id: l.scene_id,
        line_id: l.id,
        merges: [],
        seq: l.seq,
        start_ms: l.start_ms,
        end_ms: l.end_ms,
        text_en: l.literal_en,
        key_phrase_en: null,
        back_translation_zh: l.text_zh,
        change_type: "keep",
        is_major: false,
        rationale_en: null,
        rationale_zh: null,
        tone_note_en: null,
        tone_note_zh: null,
        tags: [],
        syllables_est: null,
        authored_by: "ai",
        model: "demo",
        prompt_version: "demo",
        ai_text_en: l.literal_en,
        ai_rationale_zh: null,
        edited_by: null,
        created_at: AT2,
        updated_at: AT2,
      }));
      if (approvedEp) {
        version.snapshot = buildVersionSnapshot({ title, adaptation, episode, version, characters: [], scenes: epScenes, lines: epLines, adapted_lines: epAdapted });
        version.snapshot_sha256 = snapshotSha256(version.snapshot);
      }
      versions.push(version);
      adapted_lines.push(...epAdapted);
    }
  }

  const profile: ResearchProfile = {
    tropes: ["ceo_billionaire", "revenge", "secret_identity", "rebirth", "contract_marriage", "pregnancy_babies"],
    audience: "female",
    titles_per_year: 24,
    distribution: ["licensed", "youtube"],
    target_markets: ["US"],
    goal: "Find two titles worth a paid US test this quarter, and learn which story types travel.",
    monthly_test_budget_usd: 500,
    updated_at: AT1,
  };

  const watchlist: WatchRow[] = ["dramabox-41000119953", "dramabox-41000100669", "reelshort-6a469b12d3f5c65f7f095b8a"].map((k) => ({ producer_id: PRODUCER_ID, listing_key: k, created_by: PRODUCER_USER_ID, created_at: AT2 }));

  const batchId = uuid(B.batch, 1);
  const report_batches: ReportBatch[] = [{ id: batchId, producer_id: PRODUCER_ID, filename: "reelshort-august-2026.csv", imported_at: AT3, imported_by: PRODUCER_USER_ID, row_count: 6, skipped_count: 0, column_map: { title: "剧名", platform: "平台", period_start: "开始", period_end: "结束", metric: "指标", value: "数值", currency: "币种" }, reverted_at: null }];
  const rowsSpec: [number, string, ReportRow["metric"], number, string | null][] = [
    [1, "ReelShort", "views", 412_000, null],
    [1, "ReelShort", "payers", 1_840, null],
    [1, "ReelShort", "revenue", 9_120.5, "USD"],
    [6, "YouTube", "views", 96_500, null],
    [8, "ReelShort", "views", 1_210_000, null],
    [8, "ReelShort", "revenue", 22_400, "USD"],
  ];
  const report_rows: ReportRow[] = rowsSpec.map(([n, platform, metric, value, currency], i) => ({
    id: uuid(B.row, i + 1),
    batch_id: batchId,
    producer_id: PRODUCER_ID,
    title_id: demoTitleId(n),
    title_name: DEMO_TITLES[n - 1].zh,
    platform,
    period_start: "2026-08-01",
    period_end: "2026-08-31",
    metric,
    value,
    currency,
    source_row: i + 2,
  }));

  // ---- experiments -------------------------------------------------------------------------
  const campaigns: PromoCampaign[] = [];
  const creatives: PromoCreative[] = [];
  const approvals: PromoApproval[] = [];
  const handoffs: PromoHandoff[] = [];
  const results: CreativeResult[] = [];
  const HYPOTHESES = [
    "Open on the reversal before revealing how the characters got there.",
    "Frame the central conflict like a viewer telling a friend what they just watched.",
    "Lead with the highest-stakes confrontation and stop before the answer.",
    "Use a disbelief reaction to make the plot twist feel socially shareable.",
    "Build escalating cuts around the relationship power shift.",
  ];
  const KINDS: PromoCreative["kind"][] = ["direct_clip", "ugc_story", "direct_clip", "ugc_reaction", "direct_clip"];
  function campaign(c: number, n: number, name: string, status: PromoCampaign["status"], exp: Partial<PromoCampaign["experiment"] & object> | null, approved: boolean, at: string): PromoCampaign {
    const row: PromoCampaign = {
      id: demoCampaignId(c),
      external_id: ext("pb", `demo:${c}`),
      title_id: demoTitleId(n),
      producer_id: PRODUCER_ID,
      name,
      target_market: "US",
      // Every demo campaign has somewhere to send viewers: TikTok requires a landing page (decision 2026-09-09).
      destination_url: "https://www.reelshort.com/",
      objective: "views",
      spoiler_level: "low",
      creative_direction: null,
      exclusions: null,
      experiment: exp ? { budget_usd: 100, currency: "USD", hypothesis: "", audience: "", first_batch: 2, signal: "views", approved_by: approved ? PRODUCER_USER_ID : null, approved_at: approved ? at : null, version: 1, updated_at: at, ...exp } : null,
      status,
      grow_campaign_id: null,
      advertiser_id: null,
      tiktok_adgroup_id: null,
      status_note: null,
      launched_at: null,
      created_by: PRODUCER_USER_ID,
      created_at: at,
      updated_at: at,
    };
    campaigns.push(row);
    return row;
  }
  function batch(c: number, n: number, statuses: PromoCreative["status"][], at: string) {
    const title = DEMO_TITLES[n - 1];
    statuses.forEach((status, k) => {
      const ep = demoEpisodeId(n, (k % Math.max(1, DEMO_TITLES[n - 1].materials[1])) + 1);
      creatives.push({
        id: creativeId(c, k + 1),
        external_id: ext("pc", `demo:${c}:${k + 1}`),
        campaign_id: demoCampaignId(c),
        title_id: demoTitleId(n),
        parent_creative_id: null,
        version: 1,
        kind: KINDS[k],
        status,
        hypothesis: HYPOTHESES[k],
        source_episode_id: ep,
        source_start_ms: k * 4_000,
        source_end_ms: k * 4_000 + (KINDS[k] === "direct_clip" ? 18_000 : 24_000),
        hook: KINDS[k] === "direct_clip" ? "Wait for the moment everything changes." : "I thought this was a love story—then this happened.",
        caption: `${title.en}: one choice changes everything.`,
        ad_description: `Watch ${title.en} and see what happens next.`,
        render_path: null,
        render_sha256: null,
        duration_ms: KINDS[k] === "direct_clip" ? 18_000 : 24_000,
        width: 1080,
        height: 1920,
        render_settings: { schema: 1, format: "9:16", source: "concept_preview", captions: true },
        rejection_note: null,
        revision_note: null,
        created_at: at,
        updated_at: at,
      });
    });
  }

  // C1: title 1, submitted (demo handoff) with demo results on the two selected creatives.
  // The manifest hash is a real sha256 shape (of the literal "demo-manifest-c1") so the launch record's check passes in both backends.
  const C1_SHA = "1e4f2b7d0a9c6e3f5b8a1d2c4e6f7a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f";
  const c1 = campaign(1, 1, "Rebirth vs romance opening — US test, round 1", "submitted", { hypothesis: "The rebirth-revenge opening outperforms the romance opening for US women 25-44.", audience: "US women 25-44 who watch romance and revenge dramas", first_batch: 2 }, true, AT2);
  // Launched through the fake TikTok transport: ids of the demo shape, never real ones.
  c1.grow_campaign_id = "1700000000000000001";
  c1.advertiser_id = DEMO_ADVERTISER_ID;
  c1.tiktok_adgroup_id = "1710000000000000001";
  c1.launched_at = AT2;
  batch(1, 1, ["approved", "approved", "not_selected", "not_selected", "not_selected"], AT2);
  approvals.push({ id: uuid(B.approval, 1), campaign_id: c1.id, producer_id: PRODUCER_ID, approved_by: PRODUCER_USER_ID, manifest: { demo: true, creatives: [creativeId(1, 1), creativeId(1, 2)], budget_usd: 100 }, manifest_sha256: C1_SHA, created_at: AT2 });
  handoffs.push({ id: uuid(B.handoff, 1), campaign_id: c1.id, idempotency_key: `studio:${c1.external_id}:${C1_SHA}`, request_sha256: C1_SHA, status: "accepted", grow_campaign_id: c1.grow_campaign_id, response: { mode: "fake", tiktok_campaign_id: c1.grow_campaign_id }, error: null, attempted_at: AT2 });
  const launches: PromoLaunch[] = [{
    id: uuid(B.launch, 1), campaign_id: c1.id, idempotency_key: `studio:${c1.external_id}:${C1_SHA}`, manifest_sha256: C1_SHA, status: "done", mode: "fake",
    advertiser_id: DEMO_ADVERTISER_ID, identity_id: DEMO_IDENTITY_ID, identity_type: "BC_AUTH_TT", budget_usd: 100, destination_url: "https://www.reelshort.com/",
    uploaded_videos: { [creativeId(1, 1)]: "v1700000000000000001", [creativeId(1, 2)]: "v1700000000000000002" },
    covers: { v1700000000000000001: "c1700000000000000001", v1700000000000000002: "c1700000000000000002" },
    tiktok_campaign_id: c1.grow_campaign_id, tiktok_adgroup_id: c1.tiktok_adgroup_id,
    ad_ids: { [creativeId(1, 1)]: "1720000000000000001", [creativeId(1, 2)]: "1720000000000000002" },
    error: null, attempts: 1, created_by: PRODUCER_USER_ID, created_at: AT2, started_at: AT2, heartbeat_at: AT2, finished_at: AT2,
  }];
  results.push(
    { id: uuid(B.result, 1), campaign_id: c1.id, creative_id: creativeId(1, 1), source: "demo", window_start: "2026-09-01", window_end: "2026-09-06", impressions: 38_400, video_views: 21_900, hook_hold_rate: 0.41, clicks: 612, spend_usd: 52.4, landing_actions: 88, observed_at: AT3 },
    { id: uuid(B.result, 2), campaign_id: c1.id, creative_id: creativeId(1, 2), source: "demo", window_start: "2026-09-01", window_end: "2026-09-06", impressions: 35_100, video_views: 16_200, hook_hold_rate: 0.27, clicks: 301, spend_usd: 47.6, landing_actions: 34, observed_at: AT3 }
  );
  // C2: title 6, five concepts in review, experiment drafted, budget not yet approved.
  campaign(2, 6, "Alpha bride hooks — US test, round 1", "review", { hypothesis: "The werewolf-contract-bride premise reads as fantasy romance to US viewers; test a 'sold to the alpha' hook against a 'contract bride' hook.", audience: "US women 18-34 who follow werewolf romance on ReelShort", first_batch: 2 }, false, AT3);
  batch(2, 6, ["ready", "ready", "ready", "ready", "ready"], AT3);
  // C3: title 4, a brief only (no creatives yet).
  campaign(3, 4, "Fake-heiress reveal — US test, round 1", "draft", { hypothesis: "The fake-heiress reveal is a stronger US hook than the designer comeback.", audience: "US women 25-44, revenge and family drama viewers", first_batch: 2 }, false, AT3);
  // C4: title 8, approved batch and budget, waiting for submission.
  campaign(4, 8, "Face-slap in 3 seconds — US test, round 1", "approved", { hypothesis: "Male-audience face-slap plays on US TikTok when the reveal comes in the first 3 seconds.", audience: "US men 25-44 who watch action and revenge shorts", first_batch: 2 }, true, AT3);
  batch(4, 8, ["approved", "approved", "rejected", "not_selected", "not_selected"], AT3);
  approvals.push({ id: uuid(B.approval, 4), campaign_id: demoCampaignId(4), producer_id: PRODUCER_ID, approved_by: PRODUCER_USER_ID, manifest: { demo: true, creatives: [creativeId(4, 1), creativeId(4, 2)], budget_usd: 100 }, manifest_sha256: "demo-manifest-c4", created_at: AT3 });

  const noIdentity = { identity_id: null, identity_type: null, assigned_by: null, assigned_at: null } as const;
  const accounts: CompanyAccount[] = [
    { id: uuid(B.account, 1), producer_id: PRODUCER_ID, provider: "tiktok", kind: "business_center", name: "Pulsar Business Center", external_ref: null, state: "connected", access: "partner", note: "The studio's ads run from an ad account inside Pulsar's Business Center (demo).", ...noIdentity, updated_at: AT2 },
    // The launch account: assigned by Pulsar staff, ready to launch (demo ids; the fake transport accepts them).
    { id: uuid(B.account, 2), producer_id: PRODUCER_ID, provider: "tiktok", kind: "ad_account", name: "Xinghai US Ads (Pulsar BC)", external_ref: DEMO_ADVERTISER_ID, state: "connected", access: "partner", note: "Assigned from Pulsar's Business Center. Demo account: nothing here reaches TikTok.", identity_id: DEMO_IDENTITY_ID, identity_type: "BC_AUTH_TT", assigned_by: STAFF_USER_ID, assigned_at: AT2, updated_at: AT2 },
    { id: uuid(B.account, 3), producer_id: PRODUCER_ID, provider: "youtube", kind: "channel", name: "Xinghai Drama (YouTube)", external_ref: "@xinghaidrama", state: "connected", access: "owner_operated", note: "Demo state: the customer uploads and reads analytics themselves.", ...noIdentity, updated_at: AT2 },
    { id: uuid(B.account, 4), producer_id: PRODUCER_ID, provider: "meta", kind: "ad_account", name: "Meta ad account", external_ref: null, state: "unconnected", access: "none", note: null, ...noIdentity, updated_at: AT3 },
  ];

  return { titles, episodes, adaptations, scenes, lines, adapted_lines, versions, profile, watchlist, report_batches, report_rows, campaigns, creatives, approvals, handoffs, launches, results, accounts };
}
