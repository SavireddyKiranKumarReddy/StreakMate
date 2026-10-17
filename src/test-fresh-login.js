// Phase 0 risk test: can a BRAND-NEW real-Chrome profile log in to TryHackMe
// from this Mac (residential IP)? This validates the multi-user onboarding path.
//
// Usage: TEST_EMAIL=... TEST_PASS=... node src/test-fresh-login.js
// Optional: TEST_PROFILE=/path/to/profile-dir (default ~/StreakMate-test-profile)
// Exit codes: 0 success · 2 invalid creds · 3 Vercel challenge · 4 unknown
//             5 2FA required · 6 session did not persist · 7 captcha served
import { chromium } from 'playwright';
import os from 'os';
import fs from 'fs';

const EMAIL = process.env.TEST_EMAIL;
const PASS = process.env.TEST_PASS;
const UD = process.env.TEST_PROFILE || `${os.homedir()}/StreakMate-test-profile`;
const CHROME = `${os.homedir()}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`;
const stamp = new Date().toISOString().slice(0, 10);
fs.mkdirSync('logs', { recursive: true });

if (!EMAIL || !PASS) { console.error('Set TEST_EMAIL and TEST_PASS'); process.exit(1); }

const log = (...a) => console.log('[phase0]', ...a);
const WARMUP = process.env.WARMUP === '1';
const HEADLESS = process.env.HEADLESS === '1';
const tag = process.env.TAG || 'fresh';
const launch = () => chromium.launchPersistentContext(UD, {
  executablePath: CHROME,
  headless: HEADLESS,
  viewport: { width: 1366, height: 900 },
  locale: 'en-US',
  timezoneId: 'Asia/Kolkata',
  ignoreDefaultArgs: ['--use-mock-keychain', '--password-store=basic'],
  args: ['--no-first-run', '--no-default-browser-check'],
});
const shot = (p, name) => p.screenshot({ path: `logs/${stamp}-${tag}-${name}.png` }).catch(() => {});
const bodyText = (p) => p.evaluate(() => document.body?.innerText || '').catch(() => '');

let ctx = await launch();
let page = ctx.pages()[0] || await ctx.newPage();
page.setDefaultTimeout(30000);
let verdict = 'UNKNOWN';
let exitCode = 4;

try {
  if (WARMUP) {
    log('warm-up: browsing THM before login…');
    await page.goto('https://tryhackme.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(4000);
    try { await page.getByRole('button', { name: /allow all/i }).click({ timeout: 2500 }); } catch {}
    for (let i = 0; i < 4; i++) {
      await page.mouse.move(200 + Math.random() * 900, 150 + Math.random() * 600);
      await page.mouse.wheel(0, 250 + Math.random() * 400).catch(() => {});
      await page.waitForTimeout(4000 + Math.random() * 4000);
    }
    await page.goto('https://tryhackme.com/learn', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(6000 + Math.random() * 4000);
    await page.mouse.move(400 + Math.random() * 400, 300 + Math.random() * 200);
    await shot(page, 'fresh-00-warmup');
  }

  const resp = await page.goto('https://tryhackme.com/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
  log('login page HTTP', resp?.status(), '| url', page.url());
  await page.waitForTimeout(4000);
  try { await page.getByRole('button', { name: /allow all/i }).click({ timeout: 2500 }); } catch {}
  await shot(page, 'fresh-01-login');

  const visibleFirst = async (sels) => {
    for (const s of sels) {
      const el = page.locator(s).first();
      try { if ((await el.count()) > 0 && await el.isVisible()) return el; } catch {}
    }
    return null;
  };
  const mail = await visibleFirst(['#username-or-email-field', 'input[type="email"]', 'input[name="email"]', 'input[autocomplete="username"]']);
  const pass = await visibleFirst(['#password-field', 'input[type="password"]']);
  log('found email field:', !!mail, '| found password field:', !!pass);
  if (!mail || !pass) {
    const t = await bodyText(page);
    verdict = /just a moment|captcha|verify you are human/i.test(t) ? 'CHALLENGE' : 'UNKNOWN';
    throw new Error('login form fields not found (challenge or unexpected layout) — no credentials used');
  }
  await mail.fill(EMAIL);
  await page.waitForTimeout(400);
  await pass.fill(PASS);
  await page.waitForTimeout(800);

  const preText = await bodyText(page);
  if (/just a moment/i.test(preText)) {
    verdict = 'CHALLENGE';
  } else {
    await page.mouse.move(600 + Math.random() * 200, 500 + Math.random() * 100);
    await page.waitForTimeout(2000 + Math.random() * 2000);
    await page.getByRole('button', { name: /^log in$/i }).last().click({ timeout: 10000 });
    log('login submitted, waiting for outcome...');
    await page.waitForFunction(() => {
      const t = document.body?.innerText || '';
      return /my learning/i.test(t) ||
        /incorrect|invalid|wrong|unable to sign|too many/i.test(t) ||
        /captcha|verify you are human/i.test(t) ||
        !location.pathname.startsWith('/login');
    }, { timeout: 60000 }).catch(() => log('no explicit signal within 60s — classifying state anyway'));
    await page.waitForTimeout(6000);
    await shot(page, 'fresh-02-after-submit');

    const t = await bodyText(page);
    const url = page.url();
    const totp = await page.evaluate(() =>
      !!document.querySelector('input[autocomplete="one-time-code"]') ||
      [...document.querySelectorAll('input')].some(e => /otp|totp|code/i.test((e.name || '') + (e.id || '') + (e.placeholder || ''))) ||
      /two-factor|authenticator app/i.test(document.body?.innerText || ''));
    // Precise captcha detection: the rc-imageselect UI or "complete the security
    // check" text — NOT the static "protected by reCAPTCHA" footer note.
    const captcha = await page.evaluate(() => {
      const grid = document.querySelector('.rc-imageselect, #rc-imageselect, .rc-imageselect-desc-wrapper, iframe[src*="recaptcha/api2/bframe"]');
      const txt = document.body?.innerText || '';
      return !!grid || /select all images|complete the security check|verify you are human/i.test(txt);
    });
    log('after-submit url:', url);
    log('captcha UI present:', captcha, '| text:', t.replace(/\s+/g, ' ').slice(0, 200));

    if (/my learning/i.test(t) || (!/\/login/.test(url) && !/incorrect|invalid|wrong/i.test(t))) {
      verdict = 'SUCCESS';
    } else if (captcha) {
      verdict = 'CAPTCHA_PRESENT';
    } else if (/incorrect|invalid|wrong|unable to sign|too many/i.test(t)) {
      verdict = 'INVALID_CREDS';
    } else if (/just a moment/i.test(t)) {
      verdict = 'CHALLENGE_VERCEL';
    } else if (totp) {
      verdict = 'NEEDS_2FA';
    }
  }

  if (verdict === 'SUCCESS') {
    log('login SUCCESS — checking dashboard…');
    await page.goto('https://tryhackme.com/dashboard', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(9000);
    await shot(page, 'fresh-03-dashboard');
    const dash = await bodyText(page);
    const streak = await page.evaluate(async () => {
      try {
        const r = await fetch('/api/v2/users/statistics', { credentials: 'include' });
        const j = await r.json();
        return j?.data?.streak ?? null;
      } catch { return null; }
    });
    log('dashboard shows My Learning:', /my learning/i.test(dash), '| streak:', streak);

    // Session persistence: relaunch the SAME profile — expect still logged in.
    await ctx.close();
    ctx = await launch();
    page = ctx.pages()[0] || await ctx.newPage();
    page.setDefaultTimeout(30000);
    await page.goto('https://tryhackme.com/dashboard', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(9000);
    await shot(page, 'fresh-04-relaunch');
    const t2 = await bodyText(page);
    const stillIn = /my learning/i.test(t2);
    log('session persistence after relaunch:', stillIn ? 'PASS' : 'FAIL');
    exitCode = stillIn ? 0 : 6;
  } else {
    exitCode = verdict === 'INVALID_CREDS' ? 2
      : verdict === 'CHALLENGE' ? 3
      : verdict === 'NEEDS_2FA' ? 5
      : verdict === 'CAPTCHA_PRESENT' ? 7
      : verdict === 'CHALLENGE_VERCEL' ? 3 : 4;
  }
} catch (e) {
  log('ERROR:', e.message.slice(0, 300));
  await shot(page, 'fresh-99-error');
  exitCode = verdict === 'CHALLENGE' ? 3 : 4;
} finally {
  log('VERDICT:', verdict, '| exit', exitCode);
  await ctx.close().catch(() => {});
  setTimeout(() => process.exit(exitCode), 300);
}
