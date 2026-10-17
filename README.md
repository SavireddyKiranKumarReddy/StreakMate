# StreakMate 🔥

**StreakMate** is an unattended automation bot that keeps a [TryHackMe](https://tryhackme.com) daily-learning streak alive — forever, with zero manual effort.

You give it your TryHackMe account. Every morning it logs in (reusing your real browser session), answers the required questions in a room, and reports the result — including the streak counter going from `x → y` — straight to your Telegram. When the room hits 100%, it automatically resets itself and starts farming it again, in a loop.

The goal: **never lose a daily streak because you forgot to answer three little questions.**

---

## Table of contents

- [Why this exists](#why-this-exists)
- [How TryHackMe streaks work](#how-tryhackme-streaks-work)
- [How StreakMate works](#how-streakmate-works)
- [The daily execution flow](#the-daily-execution-flow)
- [The three-questions guarantee](#the-three-questions-guarantee)
- [Text-answer questions](#text-answer-questions)
- [Auto-reset loop (100% → 0% → refarm)](#auto-reset-loop-100--0--refarm)
- [Scheduling on macOS](#scheduling-on-macos)
- [Telegram notifications](#telegram-notifications)
- [Repository layout](#repository-layout)
- [Setup](#setup)
- [Configuration](#configuration)
- [Running manually](#running-manually)
- [Reliability engineering](#reliability-engineering)
- [Troubleshooting](#troubleshooting)
- [Security notes](#security-notes)
- [FAQ](#faq)

---

## Why this exists

TryHackMe awards a "streak" for learning every day. To keep it, you must answer a minimum number of questions before local midnight — and the counter resets to zero if you miss a single day. Missing one day undoes months of progress.

StreakMate removes the human from that loop entirely. It runs once a day in the early morning, does the minimum required work to bank the day, and tells you what happened.

It is built for a **single user today** (one TryHackMe account, one room) but the design cleanly extends to multiple users.

---

## How TryHackMe streaks work

| Rule | Detail |
| --- | --- |
| Minimum work | **3 answered questions** in a day keeps the streak. |
| Reset time | Counts to **local midnight**, so the run must land well before it. |
| Danger window | `11 PM – 3 AM` local is avoided — late-night activity and timezone edges are where streaks break. |
| Streak value | Exposed by the API `/api/v2/users/statistics` as `data.streak`. |
| Room progress | Shown as `Room progress: N%` / `Room completed: 100%` on the room page. |

A **"Check"** is the button next to each room question. A question with the placeholder `No answer needed` is a freebie — one click answers it. A question with a real text input needs the actual answer typed first.

---

## How StreakMate works

StreakMate drives **your real Google Chrome profile** with Playwright — not a headless browser and not a freshly created one.

```js
const ctx = await chromium.launchPersistentContext(`${os.homedir()}/StreakMate-profile`, {
  executablePath: `${os.homedir()}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
  headless: false,
  // ...
});
```

Why this matters:

- **Real fingerprint.** A genuine Chrome profile with real cookies, fonts, and extensions looks like a human. Headless browsers and datacenter IPs get stopped by anti-bot challenges (TryHackMe sits behind a Vercel bot challenge), which is exactly why the browser runs on a home machine instead of a VPS.
- **Session reuse.** The copied profile keeps the logged-in TryHackMe session, so most days **no password is ever sent** — avoiding rate limits.
- **Self-recovery.** If the session ever expires, the profile's saved autofill lets the bot submit the login form once.

A dedicated profile directory (`~/StreakMate-profile`) is used so nothing else on your machine is disturbed.

---

## The daily execution flow

Every run (`src/farm-chrome.js`) follows the same steps:

1. **Launch** the persistent Chrome profile.
2. **Load the dashboard**, retrying up to 3× (mornings can be slow).
3. **Verify login.** If logged in → proceed. If expired → one autofill login attempt. If a bot challenge is detected → abort cleanly with an alert (no repeated hammering).
4. **Read the streak** before any work: `GET /api/v2/users/statistics` → `data.streak`.
5. **Open the room** and read progress (`Room progress: N%`).
6. **Screenshot** the room *before* changes (`logs/<date>-room-before.png`).
7. **Answer questions** via the guarantee loop (below) until 3 are done, auto-resetting if the room runs dry.
8. **Re-read the streak** after work.
9. **Screenshot** the room *after* changes and send both the text report and the photo to Telegram.
10. **Record success** by writing today's date to `logs/last-success`.
11. **Close** the browser.

The bot clicks **"Check"** buttons only — it does not read or modify anything else. On a freebie question (`No answer needed`), a single click answers it.

---

## The three-questions guarantee

The core requirement is: **exactly at least 3 answered questions per day, no matter the room state.**

A naive bot that just clicks three Check buttons breaks when the room has fewer than 3 remaining questions. StreakMate instead runs a loop:

```
while (answered < 3 and attempts < 8):
    answered += click freebie Checks
    if answered < 3:
        answered += answer known text questions
    if answered made progress: continue
    else (stalled twice):
        if resets used < 2:
            reset the room      # frees all questions back to 0%
            continue
        else:
            stop, alert "needs manual reset"
```

Two properties make this robust:

- **Stall detection needs two consecutive empty attempts.** A single slow render can't trick the bot into resetting a healthy room.
- **It resets *early* rather than waiting for 100%.** If the room has only 1 question left, the bot resets immediately to guarantee a fresh supply — it never gambles the streak on a nearly-empty room.

The status is reported as one of:

| Status | Meaning |
| --- | --- |
| `COMPLETED` | 3+ questions answered — day banked. |
| `SHORT (n/3)` | Fewer than 3 answered and no reset remained — alerts loudly. |
| `ALREADY-DONE` | Room had nothing left to answer and could not be reset. |
| `FAILED` | An error (network, challenge, login) — reported with the error message. |

---

## Text-answer questions

Some questions require typing an answer. StreakMate keeps a small, explicit answer map:

```js
// normalized-question-substring -> answer
const ANSWERS = { 'duckduckgogg': 'duckduckgo' };
```

`answerTexts()` scans the page text for a known question key, finds the single unanswered free-text input (skipping the `No answer needed` boxes), types the answer, and clicks its Check button.

Adding a new text question is a one-line change: add `'<question-substring>': '<answer>'` to `ANSWERS`.

**Interaction with Check-clicks:** the bot will not blindly click a Check button that has a real text field next to it — otherwise it would submit an empty answer and waste the attempt. `clickChecks()` detects the paired input (`hasRealQuestion`) and leaves it for `answerTexts()` to handle.

---

## Auto-reset loop (100% → 0% → refarm)

When the room is complete or nearly complete, the bot resets it through the room's own UI:

**Room → `Options` (dropdown) → `Reset` → confirm**

Two non-obvious implementation details, both learned the hard way:

1. **The Options button is matched by `aria-label="dropdown"`, not by its text.** Its accessible name is overridden by the `aria-label`, so text-based selectors fail even though "Options" is clearly visible. The selector is:
   ```js
   p.getByRole('button', { name: 'dropdown' }).filter({ hasText: 'Options' })
   ```
2. **After the final answer, TryHackMe shows a celebration page with no room controls.** The bot reloads the room tasks view before attempting a reset.

The bot verifies the reset worked by re-reading progress — it must return to `Room progress: 0%`. Resets are capped at **2 per run** to prevent runaway loops.

This is what makes the system self-sustaining: `farm → 100% → reset → farm`, indefinitely, every day.

---

## Scheduling on macOS

Three [launchd](https://www.launchd.info/) agents run the show. They live in `~/Library/LaunchAgents/`:

| Agent | Schedule | Purpose |
| --- | --- | --- |
| `org.streakmate.farm` | Daily at **06:00 IST** | The main run. |
| `org.streakmate.catchup` | Every 30 min (`RunAtLoad`) | If today's run hasn't succeeded and it's past 06:10 IST, run now. Covers a missed/failed 6 AM run. |
| `org.streakmate.wakehold` | Daily at **05:55 IST** | Runs `caffeinate -t 420` to keep the Mac fully awake through 06:02, so the 6 AM job never fires on a sleeping machine. |

**Why the wake-hold exists:** macOS can drop into *maintenance sleep* right after a scheduled wake. Without the hold, the 6 AM job slides into a later DarkWake window and completes/alert late. `caffeinate` pins the machine awake across the window.

**Why there are two project copies:**

- `~/Desktop/StreakMate` — the real, editable project (where development happens).
- `~/StreakMate` — a **runtime copy**. macOS *forbids background launchd jobs from executing anything inside `~/Desktop`* (`Operation not permitted`), so the scheduler must run from the home directory. Code is synced from Desktop → runtime after each edit:

  ```bash
  rsync -a ~/Desktop/StreakMate/src/ ~/StreakMate/src/
  ```

Load/reload an agent after editing its plist:

```bash
launchctl unload ~/Library/LaunchAgents/org.streakmate.farm.plist
launchctl load   ~/Library/LaunchAgents/org.streakmate.farm.plist
launchctl list | grep streakmate
```

The machine is also configured never to idle-sleep (`sudo pmset sleep 0`) and to wake before the job; a full power-off is covered by the catch-up watcher (as long as the machine boots before ~11 PM).

---

## Telegram notifications

Every run sends two messages via the Telegram Bot API (`src/notify.js`):

**1. A text report**

```
StreakMate daily run: COMPLETED
Room: torforbeginners
Streak: 407 → 408 (Δ+1)
Progress: Room progress: 8% → Room progress: 33%
Answered: 3
Started: 17/10/2026, 6:00:00 am IST
Time: 17/10/2026, 6:01:12 am IST
```

**2. A screenshot** of the room after the run.

Two design details:

- **Credentials are read lazily.** In background jobs the `.env` file loaded *after* the notifier module had already read empty credentials — so alerts silently vanished while the work succeeded. `notify.js` now reads `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` at send time.
- **`Started:` vs `Time:`** lines let you verify the run was *on time*, not merely successful. A `Started:` before 06:05 proves the schedule held.

---

## Repository layout

```
StreakMate/
├── src/
│   ├── farm-chrome.js   # main runner — real Chrome profile (the one that runs daily)
│   ├── farm-thm.js      # headless variant (experimental / server-side attempt)
│   ├── notify.js        # Telegram helpers: tg() and tgPhoto()
│   ├── catchup.sh       # catch-up watcher: fires if today's run hasn't succeeded by 06:10 IST
│   ├── discover.js      # recon: dumps streak API + room buttons (dev tool)
│   └── recon.js         # recon: dumps login page DOM (dev tool)
├── logs/                # run screenshots, last-success marker, catchup.log (gitignored)
├── storage/             # browser storage state (gitignored)
├── .env                 # secrets — creds + Telegram (gitignored, never committed)
├── .env.example         # template for the above
├── package.json
└── README.md
```

---

## Setup

### Prerequisites

- macOS (the scheduler uses `launchd`)
- [Google Chrome](https://www.google.com/chrome/) installed
- Node.js 22+ (Homebrew `node` at `/opt/homebrew/bin/node` is assumed by the plists)

### Install

```bash
git clone https://github.com/SavireddyKiranKumarReddy/StreakMate.git
cd StreakMate
npm install
npx playwright install chromium   # if Playwright's own browser is needed by other scripts
```

### Create the Chrome profile

Copy your real Chrome profile once so StreakMate has a genuine fingerprint and a logged-in session:

```bash
cp -R "$HOME/Library/Application Support/Google/Chrome" "$HOME/StreakMate-profile"
```

Then run once manually and log in to TryHackMe in the window that opens — the session is saved in the profile for all future runs.

### Configure secrets

```bash
cp .env.example .env
# edit .env with your values
```

### Install the schedulers

Create three launchd agents in `~/Library/LaunchAgents/` (see [Scheduling on macOS](#scheduling-on-macos)) pointing at your runtime copy, then load them. A minimal `farm` plist:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>org.streakmate.farm</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/YOU/StreakMate/src/farm-chrome.js</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>6</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>/Users/YOU/StreakMate/logs/launchd.log</string>
  <key>StandardErrorPath</key><string>/Users/YOU/StreakMate/logs/launchd.log</string>
</dict>
</plist>
```

---

## Configuration

All configuration lives in `.env`:

| Variable | Required | Description |
| --- | --- | --- |
| `THM_EMAIL` | yes* | TryHackMe account email. |
| `THM_PASS` | yes* | TryHackMe account password — **quote it** if it contains `#` or special characters. |
| `TELEGRAM_BOT_TOKEN` | yes | Bot token from [@BotFather](https://t.me/BotFather). |
| `TELEGRAM_CHAT_ID` | yes | Your Telegram chat/user id. |
| `THM_ROOM` | no | Room slug to farm. Defaults to `torforbeginners`. |

\* Not always used — the Chrome-profile runner reuses your session and only falls back to password login when the session expires.

---

## Running manually

```bash
cd ~/StreakMate
node src/farm-chrome.js
```

Useful env flags on the headless variant:

```bash
DRY_RUN=1 node src/farm-thm.js    # verify login only, room untouched
HEADFUL=1 node src/farm-thm.js    # show the browser window
```

> ⚠️ **Don't fire manual bursts.** Each run is a request footprint against a bot-protected site. Testing in rapid succession triggers a Vercel challenge (`HTTP 429`) that takes hours of clean behavior to decay. Run when you have a reason to.

---

## Reliability engineering

StreakMate's value is uptime, so the design is defensive:

- **Retrying first navigation** — 3 attempts, 60s timeout each. Slow mornings no longer fail the run.
- **Challenge vs. loader distinction** — `Just a moment…` is also TryHackMe's normal loading screen. The bot waits for the logged-in state first and only reports a challenge if the loader is *stuck*.
- **Session self-recovery** — expired session triggers one autofill login instead of a helpless failure alert.
- **Stall tolerance** — a reset needs two consecutive empty attempts, so slow renders don't cause false resets.
- **Early reset** — a nearly-empty room is reset proactively rather than risking a sub-3 day.
- **Catch-up watcher** — a separate job covers a missed or failed 6 AM run within the same day.
- **Wake-hold** — `caffeinate` keeps the Mac awake across the schedule so the run isn't deferred into a DarkWake window.
- **Lazy credential reads** — alerts can never be silently skipped by module-load ordering.
- **On-time proof** — `Started:`/`Time:` timestamps in every alert.

---

## Troubleshooting

| Symptom | Likely cause | Action |
| --- | --- | --- |
| Alert arrives late (e.g. 06:16 instead of 06:01) | Mac slept through 06:00 and the job slid into a DarkWake window | Confirm `wakehold` loaded; check `pmset -g log` for sleep/wake around 06:00. |
| No Telegram at all, but `logs/last-success` advanced | Notification path, not the run | Check the bot chat isn't muted; verify `TG sent: 200` in logs. |
| `FAILED: Vercel challenge` / `HTTP 429` | Too many requests from testing | Stop running; wait hours for reputation to decay; resume the schedule. |
| `SHORT (n/3)` | Room ran out and reset failed | Manual reset from the room's Options menu, or investigate `logs/*-options-menu.png`. |
| `needs manual reset` in alert | Both auto-resets used | Reset the room by hand. |
| Run works only when you open the machine | Mac was asleep | Verify `pmset -g sched` shows the daily wake and `wakehold` is loaded. |

Logs live in `~/StreakMate/logs/`: `launchd.log` (main run), `catchup.log` (watcher), and dated screenshots.

---

## Security notes

- **`.env` is gitignored** and contains your TryHackMe password and Telegram token. It is never committed. Use `.env.example` as the template.
- **The GitHub token used to push this repo should be treated as compromised** the moment it is shared in plain text — revoke or rotate it after use.
- The bot only touches the TryHackMe room questions. It performs no destructive action, sends no email, and changes no account settings.
- Browser automation is performed by the owner on the owner's own account and machine.

---

## FAQ

**Does this violate TryHackMe's rules?**
This is a personal convenience bot automating your *own* learning account with your own real browser session. Automating a site may conflict with its terms — you run it at your own risk and should review TryHackMe's terms yourself.

**Why not run it on a VPS?**
Tried. TryHackMe sits behind a Vercel bot challenge that blocks datacenter IPs, silently rejecting logins even with stealth patches. A home machine with a real Chrome profile passes; a VPS does not.

**What if it fails one morning?**
The catch-up watcher retries later the same day. If the whole machine was off, it recovers on next boot (before the streak deadline).

**How do I add another text-answer question?**
Add `'<substring of question text>': '<answer>'` to `ANSWERS` in `src/farm-chrome.js`.

**Can it handle multiple users?**
Not yet — the current design is one account, one room. The profile-per-user and credential-per-user abstraction is the natural next step.

---

*Built to never lose a streak. Run it, forget it, and watch the fire grow.* 🔥
