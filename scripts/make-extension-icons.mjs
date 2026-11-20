// Renders the Chrome extension icons from build/icon.png (needs Playwright's Chromium).
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const b64 = readFileSync('build/icon.png').toString('base64');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent"><img id="i" src="data:image/png;base64,${b64}" style="width:${size}px;height:${size}px;display:block"></body></html>`);
  await page.locator('#i').screenshot({ path: `extension/public/icons/icon-${size}.png`, omitBackground: true });
}
await browser.close();
