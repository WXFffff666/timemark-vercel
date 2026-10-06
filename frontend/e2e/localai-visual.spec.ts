import { test } from '@playwright/test';

// v2.30 对话框滚动修复的视觉验证：登录 → /local-ai → 注入长对话 → 验证容器可滚 + 截图
test('local-ai chat scroll visual', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/login');
  await page.getByPlaceholder('用户名').fill('admin');
  await page.getByPlaceholder('密码').fill('dev-only-not-a-credential');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL(/dashboard|settings\?changePassword=1/, { timeout: 20_000 });
  await page.goto('/local-ai');
  await page.waitForTimeout(1500);

  // 注入 6 条长问答到 IndexedDB（timemark-local-ai / chat-history，整包数组单键）
  await page.evaluate(async () => {
    const longAnswer = '这是一条足够长的回答用于撑出滚动条。'.repeat(30);
    const entries = Array.from({ length: 6 }, (_, i) => ({
      question: `测试问题 ${i + 1}：请给我讲一段很长的话`,
      answer: longAnswer,
      sources: [{ id: 's1', title: '示例来源', snippet: 'snippet' }],
      mode: 'local-ai',
      at: Date.now() - (6 - i) * 60_000,
    }));
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('timemark-local-ai', 1);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('chat-history', 'readwrite');
        // 负载形状以 chat-history-db.ts 的实现为准：整包数组按固定键存
        tx.objectStore('chat-history').put(entries, 'entries');
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  });

  await page.reload();
  await page.waitForTimeout(1500);
  const container = page.locator('div[aria-live="polite"]');
  await container.waitFor({ state: 'visible', timeout: 10_000 });
  const styles = await container.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      maxHeight: cs.maxHeight,
      overflowY: cs.overflowY,
      overscrollBehaviorY: cs.overscrollBehaviorY,
      scrollable: el.scrollHeight > el.clientHeight,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
    };
  });
  console.log('CHAT_CONTAINER:', JSON.stringify(styles));
  await page.screenshot({ path: '../.screenshots/local-ai-chat.png', fullPage: false });
});
