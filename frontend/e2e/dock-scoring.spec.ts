import { test } from '@playwright/test';

// v2.35 R29：Dock 助手四维打分的视觉与行为验证
// （位置准确性 / 滚动可用性 / 自然语言显示 / 无重合）
test('dock assistant scoring probe', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/login');
  await page.getByPlaceholder('用户名').fill('admin');
  await page.getByPlaceholder('密码').fill('dev-only-not-a-credential');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL(/dashboard|settings\?changePassword=1/, { timeout: 20_000 });

  // 打开 Dock 助手
  await page.getByRole('button', { name: /智能助手|assistant/i }).first().click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: '../.screenshots/dock-assistant-1.png', fullPage: false });

  // 注入一条超长 mdx 格式的助手消息（模拟模型输出），验证滚动与清洗
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('assistant-debug-inject'));
  }).catch(() => undefined);

  // 直接通过 UI 快捷指令触发真实回答
  const input = page.getByPlaceholder(/例如：|说你想做什么/).first();
  if (await input.count()) {
    await input.fill('今天有什么');
    await input.press('Enter');
    await page.waitForTimeout(2500);
  }
  await page.screenshot({ path: '../.screenshots/dock-assistant-2.png', fullPage: false });

  // 滚动到底部再回到顶部（验证 dock 内滚动独立于页面）
  const list = page.getByTestId('assistant-message-list');
  if (await list.count()) {
    await list.evaluate((el) => { el.scrollTop = 0; });
    await page.waitForTimeout(300);
    const atTop = await list.evaluate((el) => el.scrollTop === 0);
    console.log('DOCK_SCROLL_TOP_OK:', atTop);
    await list.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await page.waitForTimeout(300);
  }
  await page.screenshot({ path: '../.screenshots/dock-assistant-3.png', fullPage: false });

  // 检查面板与底栏/页面内容是否重合（面板底边应高于底栏顶边）
  const panelBox = await page.getByTestId('assistant-panel').boundingBox();
  const navBox = await page.getByRole('navigation', { name: '主导航' }).boundingBox().catch(() => null);
  if (panelBox && navBox) {
    const overlap = panelBox.y + panelBox.height > navBox.y;
    console.log('DOCK_NAV_OVERLAP:', overlap, `panel.bottom=${Math.round(panelBox.y + panelBox.height)} nav.top=${Math.round(navBox.y)}`);
  }
});
