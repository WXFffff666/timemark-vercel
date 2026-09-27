import { expect, test, type Page } from '@playwright/test';

/**
 * todo 88 — the public share page renders the event and injects event-specific OG/Twitter tags.
 * The API is fulfilled in-page (no backend needed). The static fallback in index.html keeps the
 * tags generic; the page upgrades them client-side once the token resolves.
 */

const EVENT = {
  name: '妈妈的生日',
  type: 'birthday',
  date: '2099-08-15',
  calendar_type: 'gregorian',
  person_name: '妈妈',
};

async function mockShare(page: Page, body: unknown) {
  await page.route('**/api/features/share/**', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

test('share page shows the event and injects OG/Twitter tags with the event name', async ({ page }) => {
  await mockShare(page, { success: true, data: EVENT });

  await page.goto('/share/e2e-share-token-1234');

  await expect(page.getByRole('heading', { name: '妈妈的生日' })).toBeVisible();
  await expect(page.getByTestId('share-countdown')).toContainText('还有');
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
    'content',
    '妈妈的生日 · TimeMark',
  );
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute(
    'content',
    'summary_large_image',
  );
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    'content',
    /\/api\/og\/image\/e2e-share-token-1234$/,
  );
});

test('invalid share token keeps a GENERIC OG title and never leaks an event name', async ({ page }) => {
  await mockShare(page, { success: false, error: 'Not found' });

  await page.goto('/share/bad-token');

  await expect(page.getByTestId('share-event-error')).toContainText('Not found');
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', 'TimeMark');
  await expect(page.locator('meta[property="og:image"]')).toHaveCount(0);
});
