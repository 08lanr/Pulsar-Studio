import { t, type Locale } from '@/lib/i18n';
import type { SourceEntry } from './registry';
const names: Record<string,string>={reelshort_web:'ReelShort 公开剧库',dramabox_web:'DramaBox 公开剧库',youtube_public:'YouTube 公开视频计数',youtube_owned:'YouTube 自有频道分析',google_trends:'Google Trends 美国搜索热度',meta_ad_library:'Meta 广告资料库',tiktok_top_ads:'TikTok 创意中心优秀广告',grow_results:'Pulsar Grow 测试结果',app_store_charts:'美国应用商店榜单与评分',storefront_pricing:'订阅与代币价格',producer_reports:'公司发行与平台报表',producer_input:'公司资料与剧集信息',engine:'题材分类与可比剧集分析',sensor_audience_2024:'Sensor Tower · 2024 年',pew_social_2025:'Pew Research Center · 2025 年',yougov_shorts_2025:'YouGov · 2025 年 9 月'};
const limits:Record<string,string[]>={
 reelshort_web:['英文公开剧库，无法确认观众地域。采集首页榜单和部分上架剧集，不代表整个市场。','观看和收藏是平台自有计数，完整统计口径未公开。平台自制标记不等于独立制作公司。'],
 dramabox_web:['英文公开剧库，无法确认观众地域。首页推荐与详情页覆盖有限，不代表整个市场。','观看和追剧计数来自剧集详情页，不能与其他平台直接比较。出版方名称不等于制作公司。'],
 youtube_public:['公开播放、点赞和评论不是付费转化或完播率。视频与剧目的关联需要核实。'],
 youtube_owned:['需要公司授权自有频道。指标只反映该频道及报表覆盖的观众。'],
 google_trends:['搜索热度是按查询范围归一化的相对值，不是搜索人数。不同导出窗口不能直接比较。'],
 meta_ad_library:['地区、广告类型与接口权限决定可用数据。不应从公开广告推断竞争对手的实际花费或转化。'],
 tiktok_top_ads:['优秀广告库是经过选择的样本，不是全部投放记录，也不代表市场总体效果。'],
 grow_results:['结果需要接入 Grow，保留实验分配、对照与转化窗口；相关性不等于因果。'],
 app_store_charts:['需要核实地区与来源。应用榜单不等于单部短剧的观看、收入或转化。'],
 storefront_pricing:['价格随地区、设备、时间与优惠变化，不代表用户实际付费。'],
 producer_reports:['仅本公司可见。报表由公司提供，受指标、期间和币种限制；不与公开计数合并。'],
 producer_input:['公司偏好代表发行意向。普通授权日期不能证明美国地区版权，部分素材获批不代表全剧就绪。'],
 engine:['题材可能由简介推断，存在误分类。显著度仅表示平台内的相对可见度，并非增长或成功概率。'],
 sensor_audience_2024:['2024 年报告；性别图未注明统计期间与样本量。','历史公开研究，保留原始人群与分母；没有年龄、性别与题材的联合统计。'],
 pew_social_2025:['2025 年 2 月 5 日至 6 月 18 日的美国成年人调查。','历史公开研究，保留原始人群与分母；没有年龄、性别与题材的联合统计。'],
 yougov_shorts_2025:['2025 年 9 月 18 日发布；需求统计期间未注明。','历史公开研究，保留原始人群与分母；没有年龄、性别与题材的联合统计。']
};
export function sourceCopy(s:SourceEntry,locale:Locale){
 if(s.status_rule==='publication') return {name:locale==='zh'?names[s.key]??s.name:s.name,description:t(locale,'audience.sources.note'),refresh:t(locale,'audience.sources.refresh'),limits:locale==='zh'?limits[s.key]??s.limitations:s.limitations};
 return {
 name:locale==='zh'?names[s.key]??s.name:s.name,
 description:t(locale,s.key==='engine'?'ux.sources.derived':s.status_rule==='catalog'?'ux.scope':s.status_rule==='producer'||s.key==='producer_reports'?'ux.sources.manual':'ux.sources.connection'),
 refresh:t(locale,s.key==='engine'?'ux.sources.derived':s.status_rule==='catalog'?'ux.sources.refresh':s.status_rule==='producer'||s.key==='producer_reports'?'ux.sources.manual':'ux.sources.connection'),
 limits:locale==='zh'?limits[s.key]??[t(locale,'ux.sourceLimits')]:s.limitations,
};}
