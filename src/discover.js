import { chromium } from 'playwright';
import os from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
process.chdir(join(dirname(fileURLToPath(import.meta.url)), '..'));
import fs from 'fs';
fs.mkdirSync('logs', { recursive: true });

const UD = `${os.homedir()}/StreakMate-profile`;
const ctx = await chromium.launchPersistentContext(UD, {
  executablePath: `${os.homedir()}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
  headless: false,
  viewport: { width: 1366, height: 900 },
  locale: 'en-US',
  timezoneId: 'Asia/Kolkata',
  ignoreDefaultArgs: ['--use-mock-keychain', '--password-store=basic'],
  args: ['--no-first-run', '--no-default-browser-check'],
});
const page = ctx.pages()[0] || await ctx.newPage();
page.setDefaultTimeout(25000);
const apis = [];
page.on('response', async (r) => {
  const u = r.url();
  if (/api/i.test(u) && r.status() === 200) {
    try {
      const j = await r.json();
      const s = JSON.stringify(j);
      if (/streak/i.test(s)) { apis.push({ url: u, sample: s.slice(0, 600) }); }
    } catch {}
  }
});

try {
  await page.goto('https://tryhackme.com/dashboard', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(10000);
  console.log('=== API responses mentioning streak ===');
  console.log(JSON.stringify(apis, null, 1).slice(0, 3000));
  // DOM hunt for streak badge
  const badge = await page.evaluate(() => {
    const html = document.documentElement.innerHTML;
    const i = html.search(/streak/i);
    const all = [...document.querySelectorAll('*')].filter(e =>
      /streak/i.test(e.getAttribute?.('aria-label') || '') ||
      (/^\d{1,5}$/.test((e.innerText || '').trim()) && /streak|flame|day/i.test(e.parentElement?.innerText || '')));
    return {
      firstHit: html.slice(Math.max(0, i - 300), i + 300),
      cands: all.slice(0, 6).map(e => e.outerHTML.slice(0, 300)),
    };
  });
  console.log('=== streak DOM ===');
  console.log(JSON.stringify(badge, null, 1).slice(0, 3000));

  // Room reset hunt (no answer clicks; menu opens only)
  await page.goto('https://tryhackme.com/room/torforbeginners', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);
  const r1 = await page.evaluate(() => ({
    btns: [...document.querySelectorAll('button')].map(e => ({
      text: (e.innerText || '').trim().slice(0, 40),
      aria: e.getAttribute('aria-label') || '',
      title: e.getAttribute('title') || '',
    })),
    svgBtns: [...document.querySelectorAll('button')].filter(e => !(e.innerText || '').trim()).length,
  }));
  console.log('=== room buttons ===');
  console.log(JSON.stringify(r1, null, 1).slice(0, 4000));
  await page.screenshot({ path: 'logs/discover-room-top.png' });
} catch (e) {
  console.error('DISCOVER FAIL:', e.message.slice(0, 200));
} finally {
  await ctx.close();
  setTimeout(() => process.exit(0), 500);
}
