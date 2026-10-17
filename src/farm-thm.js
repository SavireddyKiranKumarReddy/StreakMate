import dotenv from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);
dotenv.config({ path: join(ROOT, '.env') });
import { chromium } from 'playwright';
import fs from 'fs';
import { tg, tgPhoto } from './notify.js';

const EMAIL = process.env.THM_EMAIL;
const PASS = process.env.THM_PASS;
const ROOM = process.env.THM_ROOM || 'torforbeginners';
const DRY_RUN = process.env.DRY_RUN === '1';
const HEADFUL = process.env.HEADFUL === '1';
const STATE = 'storage/thm-state.json';
fs.mkdirSync('storage', { recursive: true });
fs.mkdirSync('logs', { recursive: true });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => sleep(a + Math.random() * (b - a));
const stamp = new Date().toISOString().slice(0, 10);
const nowIST = () => new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

const browser = await chromium.launch({
  headless: !HEADFUL,
  args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
});
const ctxOpts = {
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  viewport: { width: 1366, height: 900 },
  locale: 'en-US',
  timezoneId: 'Asia/Kolkata',
};
async function newCtx(withState) {
  const c = await browser.newContext(withState && fs.existsSync(STATE)
    ? { ...ctxOpts, storageState: STATE } : ctxOpts);
  await c.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  });
  return c;
}
const isLogged = (p) => p.evaluate(() => /My Learning/i.test(document.body.innerText));

let completed = 0, status = 'FAIL';
let ctx = await newCtx(true);
let page = await ctx.newPage();
page.setDefaultTimeout(20000);

try {
  // 0. Session reuse first (saves password attempts against 429 limits)
  let loggedIn = false;
  if (fs.existsSync(STATE)) {
    try {
      await page.goto('https://tryhackme.com/dashboard', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(8000);
      loggedIn = await isLogged(page);
      console.log(loggedIn ? 'session reuse OK' : 'session expired');
    } catch { loggedIn = false; }
  }
  if (!loggedIn) {
    // 1. Password login only when needed
    console.log('password login...');
    await ctx.close();
    ctx = await newCtx(false);
    page = await ctx.newPage();
    page.setDefaultTimeout(20000);
    let resp;
    try {
      resp = await page.goto('https://tryhackme.com/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch (e) {
      throw new Error('login page unreachable (network/429-challenge): ' + e.message.slice(0, 120));
    }
    if (resp && resp.status() === 429) throw new Error('login-rate-limited (HTTP 429) — cooling down, no credential attempt made');
    await page.waitForSelector('#username-or-email-field', { timeout: 30000 });
    await page.waitForTimeout(6000);
    try { await page.getByRole('button', { name: /allow all/i }).click({ timeout: 2500 }); } catch {}
    await page.locator('#username-or-email-field').fill(EMAIL);
    await rand(300, 700);
    await page.locator('#password-field').fill(PASS);
    await rand(2000, 3000);
    await page.getByRole('button', { name: /^log in$/i }).last().click();
    try {
      await page.waitForFunction(() => /My Learning/i.test(document.body.innerText), { timeout: 30000 });
    } catch {
      const t = await page.evaluate(() => document.body.innerText);
      if (/incorrect|locked|too many|blocked/i.test(t)) throw new Error('login-rejected by THM');
      throw new Error('login-no-redirect (rate-limit/recaptcha suspected) — NOT retrying today');
    }
    console.log('logged in:', page.url());
    await ctx.storageState({ path: STATE });
  }

  await page.goto('https://tryhackme.com/dashboard', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(7000);
  await page.screenshot({ path: `logs/${stamp}-dashboard-before.png` });

  if (DRY_RUN) {
    console.log('DONE DRY_RUN (login OK, room untouched)');
    await tg(`StreakMate check: <b>LOGIN OK</b> (dry run, room untouched)\nTime: ${nowIST()} IST`);
  } else {
    // 2. Room: click up to 3 unanswered Check buttons
    console.log('room...', ROOM);
    await page.goto(`https://tryhackme.com/room/${ROOM}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => /Task 1|No answer needed/i.test(document.body.innerText), { timeout: 25000 });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `logs/${stamp}-room-before.png`, fullPage: false });
    // report reset UI for fuel planning
    const resetUI = await page.evaluate(() =>
      [...document.querySelectorAll('button,a')].map(e => (e.innerText || '').trim()).filter(x => /reset|restart|start over/i.test(x)));
    console.log('reset UI:', JSON.stringify(resetUI));

    for (let round = 0; round < 3; round++) {
      const checks = page.getByRole('button', { name: /^check$/i });
      const n = await checks.count();
      console.log(`round ${round}: check buttons=${n}`);
      if (n === 0) break;
      let clicked = false;
      for (let i = 0; i < n; i++) {
        try {
          const b = checks.nth(i);
          if (!(await b.isVisible()) || !(await b.isEnabled())) continue;
          if (!/^check$/i.test(((await b.innerText()) || '').trim())) continue;
          await b.scrollIntoViewIfNeeded();
          await rand(800, 1500);
          await b.click({ timeout: 5000 });
          await page.waitForTimeout(2500);
          completed++;
          clicked = true;
          console.log(`clicked check (total ${completed})`);
          break;
        } catch (e) { console.log('click skip:', e.message.slice(0, 100)); }
      }
      if (!clicked || completed >= 3) break;
    }

    await page.waitForTimeout(3000);
    await page.screenshot({ path: `logs/${stamp}-room-after.png`, fullPage: false });
    await page.goto('https://tryhackme.com/dashboard', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(7000);
    await page.screenshot({ path: `logs/${stamp}-dashboard-after.png` });

    status = completed > 0 ? 'COMPLETED' : 'ALREADY-DONE';
    await tg(`StreakMate daily run: <b>${status}</b>\nRoom: ${ROOM}\nQuestions completed: ${completed}\nTime: ${nowIST()} IST`);
    await tgPhoto(`logs/${stamp}-room-after.png`, `Room after — ${status} (${completed})`);
    console.log('DONE', status, completed);
  }
} catch (e) {
  console.error('RUN FAIL:', e.message.slice(0, 300));
  try { await page.screenshot({ path: `logs/${stamp}-fail.png`, fullPage: true }); } catch {}
  await tg(`StreakMate daily run: <b>FAILED</b>\nRoom: ${ROOM}\nError: ${e.message.slice(0, 250)}\nTime: ${nowIST()} IST`);
  process.exitCode = 1;
} finally {
  await browser.close();
  setTimeout(() => process.exit(process.exitCode || 0), 500);
}
