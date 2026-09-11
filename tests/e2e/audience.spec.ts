import { test, expect } from '@playwright/test';

test('public audience research stays sourced across listing filters and locales', async ({ page }) => {
  const base = test.info().project.use.baseURL ?? 'http://localhost:3200';
  const login = await page.request.post('/api/auth/dev', { form: { kind: 'producer' }, maxRedirects: 0 });
  expect([200, 302, 303]).toContain(login.status());
  await page.context().addCookies([{ name: 'pulsar_studio_locale', value: 'en', url: base }]);
  await page.goto('/producer/insights?mode=all&audience=male');
  const research = page.getByRole('region', { name: 'Who to make the first titles for', exact: true });
  await expect(research).toContainText('72%');
  await expect(research).toContainText('2024');
  await research.getByText('Where US age groups and women use social media', { exact: true }).click();
  await expect(research.getByRole('table')).toContainText('Share of each US demographic group');
  await expect(research.getByRole('row', { name: 'Facebook 68% 80% 74% 57% 78% 63%', exact: true })).toBeVisible();
  await research.getByText('What remains unverified', { exact: true }).click();
  await expect(research).toContainText('hypothesis, not an established selection requirement');
  await page.setViewportSize({ width: 390, height: 844 });
  await research.screenshot({ path: 'tmp/audience-mobile.png' });
  await expect(page.locator('body')).toHaveJSProperty('scrollWidth', await page.evaluate(() => window.innerWidth));
  await page.context().addCookies([{ name: 'pulsar_studio_locale', value: 'zh', url: base }]);
  await page.reload();
  await expect(page.getByRole('heading', { name: '首批剧集面向哪些观众' })).toBeVisible();
  await expect(page.locator('.audience-research')).toContainText('女性占 72%');
  await page.goto('/producer/sources/reelshort_us_female_share');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('2024');
});
