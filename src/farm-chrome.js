import dotenv from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);
dotenv.config({ path: join(ROOT, '.env') });
import { chromium } from 'playwright';
import fs from 'fs';
import { tg, tgPhoto } from './notify.js';
import os from 'os';
fs.mkdirSync('storage', { recursive: true });
fs.mkdirSync('logs', { recursive: true });

const ROOM = process.env.THM_ROOM || 'torforbeginners';
const UD = `${os.homedir()}/StreakMate-profile`;
const stamp = new Date().toISOString().slice(0, 10);
const nowIST = () => new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
const RUN_STARTED_IST = nowIST();
console.log('RUN START:', RUN_STARTED_IST);
const istDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => sleep(a + Math.random() * (b - a));

// Known text answers: normalized-question-substring -> answer (exact casing as accepted by THM)
const ANSWERS = { 'duckduckgogg': 'duckduckgo' };

async function readStreak(p) {
  try {
    const s = await p.evaluate(async () => {
      try {
        const r = await fetch('/api/v2/users/statistics', { credentials: 'include' });
        const j = await r.json();
        if (typeof j?.data?.streak === 'number') return j.data.streak;
      } catch {}
      const b = document.querySelector('button[data-testid="streak-trigger"]');
      const m = (b?.getAttribute('aria-label') || '').match(/(\d+)\s*day/i);
      return m ? parseInt(m[1], 10) : null;
    });
    return typeof s === 'number' ? s : null;
  } catch { return null; }
}
async function readProgress(p) {
  try {
    const t = await p.evaluate(() => document.body.innerText);
    return (t.match(/Room (?:progress|completed): *\d+%/) || ['?'])[0];
  } catch { return '?'; }
}
async function countChecks(p) {
  const btns = p.getByRole('button', { name: /^check$/i });
  const n = await btns.count();
  let live = 0;
  for (let i = 0; i < n; i++) {
    try {
      const b = btns.nth(i);
      if (await b.isVisible() && await b.isEnabled() &&
        /^check$/i.test(((await b.innerText()) || '').trim())) live++;
    } catch {}
  }
  return live;
}
// click up to `max` Check buttons; returns clicks done
async function clickChecks(p, max) {
  let done = 0;
  for (let round = 0; round < max; round++) {
    const btns = p.getByRole('button', { name: /^check$/i });
    const n = await btns.count();
    let clicked = false;
    for (let i = 0; i < n; i++) {
      try {
        const b = btns.nth(i);
        if (!(await b.isVisible()) || !(await b.isEnabled())) continue;
        if (!/^check$/i.test(((await b.innerText()) || '').trim())) continue;
        // skip Checks paired with a real-answer text field (answerTexts owns those);
        // freebie "No answer needed" inputs never block the click
        const hasRealQuestion = await b.evaluate((btn) => {
          let node = btn;
          for (let d = 0; d < 6 && node; d++) {
            node = node.parentElement;
            if (!node) break;
            const inp = node.querySelector('input[type="text"], input:not([type])');
            if (!inp || inp.disabled || inp.readOnly || inp.offsetParent === null) continue;
            if (/no answer needed/i.test(inp.placeholder || '')) return false;
            const v = (inp.value || '').trim();
            if (v === '' || /^_+$/.test(v)) return true;
            return false;
          }
          return false;
        }).catch(() => false);
        if (hasRealQuestion) continue;
        await b.scrollIntoViewIfNeeded();
        await rand(800, 1500);
        await b.click({ timeout: 5000 });
        await p.waitForTimeout(2500);
        done++;
        clicked = true;
        console.log(`check click (total ${done})`);
        break;
      } catch (e) { console.log('click skip:', e.message.slice(0, 100)); }
    }
    if (!clicked) break;
  }
  return done;
}
// answer up to `max` known text questions; returns answers done.
// Matches the room page text against known-question keys, then fills the
// single unanswered free-text input (excludes "No answer needed" boxes).
async function answerTexts(p, max) {
  let done = 0;
  const pageText = (await p.evaluate(() => document.body.innerText).catch(() => '')).toLowerCase();
  const key = Object.keys(ANSWERS).find(k => pageText.includes(k));
  if (!key) return 0;
  const inputs = p.locator('input[type="text"], input:not([type])');
  const n = await inputs.count();
  for (let i = 0; i < n && done < max; i++) {
    try {
      const inp = inputs.nth(i);
      if (!(await inp.isVisible()) || !(await inp.isEnabled())) continue;
      if (/no answer needed/i.test((await inp.getAttribute('placeholder')) || '')) continue;
      const cur = (await inp.inputValue()).trim();
      if (cur !== '' && !/^_+$/.test(cur)) continue; // already answered
      await inp.scrollIntoViewIfNeeded();
      await inp.fill('');
      await inp.fill(ANSWERS[key]);
      await rand(600, 1200);
      try { await inp.press('Enter'); await p.waitForTimeout(2000); } catch {}
      const check = p.getByRole('button', { name: /^check$/i });
      const cn = await check.count();
      for (let j = 0; j < cn; j++) {
        try {
          const b = check.nth(j);
          if (await b.isVisible() && await b.isEnabled()) { await b.click({ timeout: 5000 }); break; }
        } catch {}
      }
      await p.waitForTimeout(2500);
      done++;
      console.log(`text answer: ${key} (total ${done})`);
    } catch (e) { console.log('text skip:', e.message.slice(0, 100)); }
  }
  return done;
}
// open Options -> Reset -> confirm; returns true if progress returns to 0%.
// NOTE: after the final answer THM shows a celebration page without room
// controls, so always reload the room tasks view first.
async function doReset(p) {
  console.log('resetting room...');
  await p.goto(`https://tryhackme.com/room/${ROOM}`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => /Task 1|No answer needed/i.test(document.body.innerText), { timeout: 30000 });
  await p.waitForTimeout(3000);
  // NOTE: the Options button carries aria-label="dropdown" which overrides its
  // text for accessible-name computation — match on that + visible text.
  const opts = p.getByRole('button', { name: 'dropdown' }).filter({ hasText: 'Options' });
  await opts.first().click({ timeout: 8000, force: true });
  await p.waitForTimeout(1500);
  await p.screenshot({ path: `logs/${stamp}-options-menu.png` });
  const item = p.getByRole('menuitem', { name: /reset|restart|start over/i });
  if ((await item.count()) === 0) {
    const btn = p.getByRole('button', { name: /reset|restart|start over/i });
    if ((await btn.count()) === 0) throw new Error('reset item not found in Options');
    await btn.first().click({ timeout: 5000 });
  } else {
    await item.first().click({ timeout: 5000 });
  }
  await p.waitForTimeout(2000);
  // confirm dialog if any
  for (const name of [/^reset$/i, /^confirm$/i, /^yes/i]) {
    try {
      const c = p.getByRole('button', { name });
      if (await c.count() > 0 && await c.first().isVisible()) {
        await c.first().click({ timeout: 4000 });
        break;
      }
    } catch {}
  }
  await p.waitForTimeout(5000);
  const prog = await readProgress(p);
  console.log('progress after reset:', prog);
  return /0%/.test(prog);
}

console.log('Launching persistent context:', UD);
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

let clicked = 0, resets = 0, resetNote = '';
try {
  // Robust initial load: THM is intermittently slow; retry the first
  // navigation instead of dying on one 25s timeout.
  let dashOK = false;
  for (let a = 0; a < 3 && !dashOK; a++) {
    try {
      await page.goto('https://tryhackme.com/dashboard', { waitUntil: 'domcontentloaded', timeout: 60000 });
      dashOK = true;
    } catch (e) {
      console.log(`dashboard load attempt ${a + 1}/3 failed, retrying...`);
      await page.waitForTimeout(5000);
    }
  }
  if (!dashOK) throw new Error('dashboard unreachable after 3 attempts');
  // NOTE: "Just a moment…" is also THM's normal loader — only a *stuck*
  // loader means challenge. Wait for login state first, judge after.
  let logged = false;
  try {
    await page.waitForFunction(() => /My Learning/i.test(document.body.innerText), { timeout: 45000 });
    logged = true;
  } catch {
    const t = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (/Just a moment/i.test(t)) throw new Error('Vercel challenge on dashboard (stuck loader) — cooling down, will retry later');
    // Self-recovery: the copied profile keeps autofilled creds — one submit attempt.
    if (/Welcome back/i.test(t)) {
      console.log('session expired, trying prefilled login...');
      try { await page.getByRole('button', { name: /allow all/i }).click({ timeout: 2500 }); } catch {}
      await page.waitForTimeout(2000);
      await page.getByRole('button', { name: /^log in$/i }).last().click({ timeout: 10000 });
      await page.waitForFunction(() => /My Learning/i.test(document.body.innerText), { timeout: 30000 });
      logged = true;
      console.log('prefilled login OK');
    } else {
      throw new Error('dashboard in unknown state: ' + t.slice(0, 150));
    }
  }
  if (!logged) {
    await page.screenshot({ path: `logs/${stamp}-fail.png` });
    throw new Error('login recovery failed');
  }
  const streakBefore = await readStreak(page);
  console.log('streak before:', streakBefore);

  await page.goto(`https://tryhackme.com/room/${ROOM}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => /Task 1|No answer needed/i.test(document.body.innerText), { timeout: 30000 });
  await page.waitForTimeout(3000);
  const progBefore = await readProgress(page);
  console.log('progress before:', progBefore);
  await page.screenshot({ path: `logs/${stamp}-room-before.png`, fullPage: false });

  // Guarantee loop: keep answering until 3 done. A stall (no new answers
  // in an iteration) must repeat twice before reset, to survive slow renders.
  // Reset (max 2/run) fires on stalls at any progress — that is the fuel loop.
  let prog = await readProgress(page);
  let guard = 0, stalled = 0;
  while (clicked < 3 && guard < 8) {
    guard++;
    const before = clicked;
    clicked += await clickChecks(page, 3 - clicked);
    if (clicked < 3) clicked += await answerTexts(page, 3 - clicked);
    prog = await readProgress(page);
    if (clicked > before) { stalled = 0; continue; } // making progress
    if (++stalled < 2) { await page.waitForTimeout(4000); continue; }
    if (resets >= 2) { resetNote = '\nRoom exhausted — needs manual reset.'; break; }
    try {
      if (await doReset(page)) {
        resets++;
        resetNote = `\nAuto-reset x${resets} to free more questions.`;
        await page.waitForTimeout(3000);
        continue;
      }
      resetNote = '\nRoom exhausted and reset failed — needs manual reset.';
      break;
    } catch (e) {
      console.log('reset fail:', e.message.slice(0, 120));
      resetNote = '\nRoom exhausted and reset failed — needs manual reset.';
      break;
    }
  }
  prog = await readProgress(page);

  await page.waitForTimeout(3000);
  await page.screenshot({ path: `logs/${stamp}-room-after.png`, fullPage: false });
  await page.goto('https://tryhackme.com/dashboard', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);
  const streakAfter = await readStreak(page);

  const sLine = (streakBefore != null && streakAfter != null)
    ? `\nStreak: ${streakBefore} → ${streakAfter}${streakAfter > streakBefore ? ` (Δ+${streakAfter - streakBefore})` : ' (no change yet)'}` 
    : (streakAfter != null ? `\nStreak: ${streakAfter} (before unread)` : `\nStreak: unread`);
  const status = clicked >= 3 ? 'COMPLETED' : (clicked > 0 ? `SHORT (${clicked}/3)` : 'ALREADY-DONE');
  // Marker always written on non-failed runs: the guarantee loop already tried
  // everything (including resets), so an hourly retry would face identical
  // room state. SHORT days still alert loudly (see status above).
  try { fs.writeFileSync('logs/last-success', istDate() + '\n'); } catch {}
  await tg(`StreakMate daily run: <b>${status}</b>\nRoom: ${ROOM}${sLine}\nProgress: ${progBefore} → ${prog}\nAnswered: ${clicked}${resetNote}\nStarted: ${RUN_STARTED_IST} IST\nTime: ${nowIST()} IST`);
  await tgPhoto(`logs/${stamp}-room-after.png`, `Streak ${streakBefore}→${streakAfter} | ${progBefore}→${prog}${resets ? ' | reset loop' : ''}`);
  console.log('DONE', status, `streak ${streakBefore}->${streakAfter}`, progBefore, '->', prog, `resets=${resets}`);
} catch (e) {
  console.error('RUN FAIL:', e.message.slice(0, 300));
  try { await page.screenshot({ path: `logs/${stamp}-fail.png`, fullPage: true }); } catch {}
  await tg(`StreakMate daily run: <b>FAILED</b>\nRoom: ${ROOM}\nError: ${e.message.slice(0, 250)}\nStarted: ${RUN_STARTED_IST} IST\nTime: ${nowIST()} IST`);
  process.exitCode = 1;
} finally {
  await ctx.close();
  setTimeout(() => process.exit(process.exitCode || 0), 500);
}
