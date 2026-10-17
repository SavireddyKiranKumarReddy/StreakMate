import 'dotenv/config';
import { chromium } from 'playwright';

const EMAIL = process.env.THM_EMAIL;
const PASS = process.env.THM_PASS;

if (!EMAIL || !PASS) {
  console.error('Missing THM_EMAIL/THM_PASS in .env');
  process.exit(1);
}

// Recon only: load login page, screenshot, dump inputs/buttons. No login submit yet.
const browser = await chromium.launch({
  headless: true,
  args: ['--disable-blink-features=AutomationControlled'],
});
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  viewport: { width: 1366, height: 900 },
  locale: 'en-US',
  timezoneId: 'Asia/Kolkata',
});
const page = await ctx.newPage();
page.setDefaultTimeout(30000);

try {
  console.log('Goto login...');
  const resp = await page.goto('https://tryhackme.com/login', { waitUntil: 'domcontentloaded' });
  console.log('status:', resp?.status());
  await page.waitForTimeout(5000);
  await page.screenshot({ path: 'recon-login.png', fullPage: true });
  console.log('saved recon-login.png, title:', await page.title());
  console.log('url:', page.url());

  const html = await page.content();
  console.log('html len:', html.length);
  // Dump candidate selectors
  const dump = await page.evaluate(() => {
    const els = [...document.querySelectorAll('input,button,a')].slice(0, 80).map(e => ({
      tag: e.tagName,
      type: e.getAttribute('type'),
      name: e.getAttribute('name'),
      id: e.id,
      placeholder: e.getAttribute('placeholder'),
      text: (e.innerText || e.value || '').slice(0, 80),
      href: e.getAttribute('href'),
    }));
    return { els, bodyText: document.body.innerText.slice(0, 2000) };
  });
  console.log(JSON.stringify(dump, null, 2).slice(0, 8000));
} catch (e) {
  console.error('recon failed:', e.message);
  try { await page.screenshot({ path: 'recon-fail.png' }); } catch {}
} finally {
  await browser.close();
}
