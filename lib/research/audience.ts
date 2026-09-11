// Curated public research, independent of fixture campaigns and catalog crawls.
// Percentages retain their original denominator; never join marginal age and
// gender shares into an invented demographic-by-genre estimate.
import { z } from 'zod';

export const AUDIENCE_REVIEWED_AT = '2026-09-10';
export const AUDIENCE_VERSION = '1.0';
export const AUDIENCE_SOURCES = {
  sensor: {
    key: 'sensor_audience_2024', name: 'Sensor Tower · 2024',
    url: 'https://runwise.co/wp-content/uploads/2024/03/2024%E5%B9%B4%E7%9F%AD%E5%89%A7%E5%87%BA%E6%B5%B7%E5%B8%82%E5%9C%BA%E6%B4%9E%E5%AF%9F%E6%8A%A5%E5%91%8A_Sensor-Tower_2024.pdf',
    period: '2024 report; gender chart measurement window not specified',
    geography: 'US',
  },
  pew: {
    key: 'pew_social_2025', name: 'Pew Research Center · 2025',
    url: 'https://www.pewresearch.org/internet/fact-sheet/social-media/',
    period: '2025-02-05 / 2025-06-18', geography: 'US',
  },
  yougov: {
    key: 'yougov_shorts_2025', name: 'YouGov · September 2025',
    url: 'https://yougov.com/reports/53014-yougov-behavioral-the-rise-of-vertical-shorts-september-2025',
    period: '2025, published 2025-09-18; exact demand window not specified', geography: 'US',
  },
} as const;

const percent = z.number().min(0).max(100);
const ChannelSchema = z.object({
  platform: z.enum(['YouTube', 'Facebook', 'TikTok']),
  ages: z.tuple([percent, percent, percent, percent]),
  women: percent, men: percent,
});
export const CHANNEL_DEMOGRAPHICS = z.array(ChannelSchema).parse([
  { platform: 'YouTube', ages: [95, 92, 85, 64], women: 83, men: 86 },
  { platform: 'Facebook', ages: [68, 80, 74, 57], women: 78, men: 63 },
  { platform: 'TikTok', ages: [63, 44, 30, 12], women: 42, men: 30 },
]);
export const REELSHORT_FEMALE_SHARE = percent.parse(72);
export const AUDIENCE_GAPS = {
  genreAgeGenderCrossTab: null,
  dramaBoxUSAgeGender: null,
  tiktokHashtagDemographics: null,
} as const;
// This is the publisher's listed top five, not a Studio ranking or a current chart.
export const US_DEMAND_TITLES = [
  'Claimed by the Alpha I Hate', 'The Divorced Billionaire Heiress',
  'Surrender to My Professor', 'Maid for My Nemesis', 'Fated to the Alpha',
] as const;
