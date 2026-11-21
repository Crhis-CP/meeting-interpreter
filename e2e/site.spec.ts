import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, expect, test } from '@playwright/test';

/** The download page offers the right thing to each of our users' devices. */
const CASES: { who: string; ua: string; button: RegExp; phoneNote?: RegExp }[] = [
  {
    who: 'HarmonyOS NEXT (ArkWeb, no "Android")',
    ua: 'Mozilla/5.0 (Phone; OpenHarmony 5.0; HarmonyOS 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 ArkWeb/4.1.6.1 Mobile',
    button: /华为手机怎么用/,
    phoneNote: /华为手机：/,
  },
  {
    who: 'HarmonyOS NEXT, API 15+ (only OpenHarmony left)',
    ua: 'Mozilla/5.0 (Phone; OpenHarmony 5.1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 ArkWeb/5.1.0.1 Mobile',
    button: /华为手机怎么用/,
  },
  { who: 'HarmonyOS 4 (runs Android apps)', ua: 'Mozilla/5.0 (Linux; Android 12; HarmonyOS; NOH-AN00) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0 Mobile Safari/537.36', button: /下载安卓版/ },
  { who: 'iPhone', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', button: /苹果手机怎么用/, phoneNote: /苹果手机：/ },
  { who: 'Android', ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36', button: /下载安卓版/ },
  { who: 'Windows', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36', button: /下载 Windows 版/ },
  { who: 'Mac', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36', button: /下载 Mac 版/ },
];

test('官网: each device gets the right download or "scan to join" note', async () => {
  const html = readFileSync(resolve('site/index.html'), 'utf8');
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-proxy-server'] });
  try {
    for (const c of CASES) {
      const ctx = await browser.newContext({ userAgent: c.ua });
      const page = await ctx.newPage();
      // No network: the page and a fake latest release.
      await page.route('**/*', (route) => {
        const url = route.request().url();
        if (url.startsWith('https://site.test/')) return route.fulfill({ contentType: 'text/html', body: html });
        if (url.includes('api.github.com')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ tag_name: 'v0.9.0', published_at: '2026-12-01T00:00:00Z', assets: [] }) });
        return route.fulfill({ status: 404, body: '' });
      });
      await page.goto('https://site.test/');
      await expect(page.locator('#primary'), c.who).toHaveText(c.button);
      if (c.phoneNote) await expect(page.locator('#phone'), c.who).toContainText(c.phoneNote);
      else if (!/怎么用/.test(c.button.source)) await expect(page.locator('#phone'), c.who).toBeHidden();
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
});
