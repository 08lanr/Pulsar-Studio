import test from 'node:test';
import assert from 'node:assert/strict';
import { AUDIENCE_GAPS, AUDIENCE_SOURCES, CHANNEL_DEMOGRAPHICS, REELSHORT_FEMALE_SHARE } from '../lib/research/audience';
import { metricByKey, sourceByKey } from '../lib/research/registry';

test('public audience research preserves denominators and has registered provenance', () => {
  assert.equal(REELSHORT_FEMALE_SHARE, 72);
  assert.match(metricByKey('reelshort_us_female_share')!.denominator!, /ReelShort US users/);
  assert.match(metricByKey('us_platform_use_by_demographic')!.denominator!, /within each/);
  for (const source of Object.values(AUDIENCE_SOURCES)) {
    assert.equal(sourceByKey(source.key)?.surface, source.url);
    assert.equal(sourceByKey(source.key)?.status_rule, 'publication');
  }
  // These are penetration rates, not a composition distribution. They must
  // not be normalized to sum to 100 or transformed into a genre affinity.
  const facebook = CHANNEL_DEMOGRAPHICS.find(row => row.platform === 'Facebook')!;
  assert.equal(facebook.women, 78);
  assert.equal(facebook.men, 63);
  assert.equal(facebook.ages[1], 80);
  assert.ok(facebook.women + facebook.men > 100);
});

test('unretrieved demographic cross-tabs remain unknown, including in demo mode', () => {
  for (const value of Object.values(AUDIENCE_GAPS)) assert.equal(value, null);
});
