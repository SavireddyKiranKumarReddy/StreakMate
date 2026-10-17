# StreakMate Multi-User — Plan (v1)

Status: **planning** · Execution machine: Mac (residential IP) · Repo: github.com/SavireddyKiranKumarReddy/StreakMate

## Goal

Turn StreakMate from a single-user script into a small **invite-only service**:

> Users sign in (GitHub), submit their TryHackMe credentials, we verify and store them encrypted,
> farm the daily streak for every account, and each user watches their own progress — with proof
> screenshots — in a web dashboard. **No Telegram notifications for end users.**

## Locked decisions

| # | Decision | Value |
| --- | --- | --- |
| 1 | Audience | Trusted, invite-only beta |
| 2 | Intake + UI | Web app hosted on the Mac |
| 3 | Room | One fixed room for all users (same proven answer map) |
| 4 | THM credentials | Encrypted at rest, AES-256-GCM, master key in macOS Keychain |
| 5 | User sign-in | **GitHub-only** ("Sign in with GitHub") — no site passwords to manage |
| 6 | User notifications | **None via Telegram** — dashboard only |
| 7 | Telegram | Admin-only alerts for the operator (recommended, optional) |

> **Hard rule:** user credentials are **NEVER** stored in GitHub. The repo is public.
> GitHub serves only as the *login identity* for the dashboard.

## User flow

1. User opens the site → **Sign in with GitHub**.
2. Dashboard (empty state) → **Add TryHackMe account**: THM email + password (room is fixed, shown on the form).
3. System queues a **verification job**. Status widget moves through:
   `pending → verifying → active | invalid_creds | retry_later | 2fa_blocked`.
4. Once `active`: every morning (in the 4–9 AM IST window) the worker farms the room for that account.
5. User opens the dashboard any time to see:
   - today's status (`COMPLETED` / `SHORT` / `FAILED` / pending)
   - streak `x → y`, room progress, answered count, resets
   - **proof screenshots** (room before / after) for each day
   - run history and on-time timestamps (`Started:` / `Finished:`)

## Verification pipeline (one-time per user, then session reuse)

| Outcome | Detection | Stored status | User sees |
| --- | --- | --- | --- |
| Valid login | reaches "My Learning" | `active` | "Verified ✓ — daily farming started" |
| Wrong password | THM "incorrect" message | `invalid_creds` | "Check your THM credentials" |
| Bot challenge / captcha | stuck "Just a moment…", HTTP 429, or reCAPTCHA served | `retry_later` (backoff ≥ 1h, ≤ 2 attempts/day) | "Try again later — not your fault" |
| 2FA prompt (TOTP) | TOTP input appears | `2fa_blocked` | "Disable 2FA or unsupported" |

**Rules**
- A challenge must **never** be classified as wrong credentials.
- Verification rate policy: ≥ 2 minutes between verifications; challenge → hours of backoff.
- Each user gets a dedicated Chrome profile (`data/profiles/<user_id>`) — a fresh real-Chrome
  profile on the Mac (residential IP is what passes THM's Vercel challenge).
- After first success, the profile's session cookie carries daily runs; the password is only
  re-used when a session expires (one login attempt, self-recovery — as today).

## Daily run & proof artifacts

- Per-user profile: `data/profiles/<user_id>` (chmod 700).
- Proof images: `data/proofs/<user_id>/<YYYY-MM-DD>-before.png` and `-after.png`,
  referenced by the `runs` table and served on the dashboard (thumbnail + full view).
- Retention: proofs kept 30 days by default, then pruned.
- Success marker per user: `data/state/<user_id>.last-success` (drives per-user catch-up).

## System architecture

```
        GitHub OAuth ────┐
                         ▼
   ┌─────────────────────────────────────────┐
   │  Web app (Express + EJS + better-sqlite3)│
   │  • Sign in with GitHub   • intake form   │
   │  • status + run history  • proof images  │
   │  • admin view (operator)                 │
   └───────────────┬─────────────────────────┘
                   │  shared modules
   ┌───────────────▼─────────────────────────┐
   │  DB: data/streakmate.db (chmod 600)     │
   │  users · runs · jobs · events           │
   └───────────────▲─────────────────────────┘
                   │
   ┌───────────────┴─────────────────────────┐
   │  Worker daemon (launchd KeepAlive)      │
   │  • verify / farm / reauth jobs (queue)  │
   │  • 4–9 AM IST scheduler, staggered      │
   │  • profile pool, proofs, catch-up       │
   │  • admin Telegram alerts (operator)     │
   └─────────────────────────────────────────┘
        + wake-hold (caffeinate 05:55) — existing
        + Mac runs everything: execution must be residential IP
```

## DB schema (sketch)

- `users(id, github_id, github_login, thm_email, creds_enc, creds_nonce, status, room, created_at, last_verified_at)`
- `runs(id, user_id, day, started_at, finished_at, status, streak_before, streak_after, progress_before, progress_after, answered, resets, proof_before, proof_after, error)`
- `jobs(id, user_id, kind, run_after, state, attempts, last_error)` — `kind ∈ verify|farm|reauth`
- `events(id, ts, user_id, type, detail)` — audit trail

## Credential handling rules

- AES-256-GCM with per-record nonce; master key generated once, stored in macOS Keychain
  (`security add-generic-password`), injected into the daemon environment at load.
- Passwords are **write-only**: never logged, never rendered back to any page.
- DB file chmod 600; profiles chmod 700; operator-only file access on the Mac.
- Account deletion purges: DB row, profile directory, proofs.

## Capacity & scheduling

- ~1.5–2.5 min per farm run → **~120–200 accounts/night sequential** in a 5-hour window
  (4–9 AM IST); double with 2 parallel slots. One Mac is enough for the beta.
- Verifications are queued with spacing (≥2 min) — bursts are what trigger Vercel challenges.
- Per-user catch-up within the window; the existing 30-min watcher pattern becomes per-user jobs.

## Security notes

- The GitHub repo is public → nothing sensitive in git, ever (`.env`, DB, profiles, proofs are ignored/path-local).
- Shared GitHub token used for the initial push must be treated as compromised → rotate to a fine-grained token.
- Site exposure for the beta: Cloudflare Tunnel (or Tailscale) + GitHub OAuth gate — no public admin surface.
- ToS/ethics: this automates users' own accounts at their explicit consent; keep the beta small and disclosed.

## Build phases

- **Phase 0 — risk gates — DONE (2026-10-17), test account `leesec01`:**
  1. Fresh profile, **cold**, headed → reCAPTCHA image challenge on submit. ❌
  2. Fresh profile + **warm-up** (browse home/learn ~90s, mouse moves, accept cookies), headed → **login PASS, no captcha**, session survives browser restart. ✅
  3. Warm-up + **headless** → reCAPTCHA served. ❌ → worker browsers must run **headed**.
  4. End-to-end mini-proof: warmed profile farmed the room (3 checks, 8% → 33%) → account streak **0 → 1**. ✅
  - Learnings: (a) THM's "Just a moment…" loader also shows on *normal* dashboard loads (fresh accounts: >10s) — logged-in state is best probed via `/api/v2/users/statistics`, which answers even while the UI loads; (b) onboarding recipe = dedicated profile → warm-up → headed login → API check → store; (c) if CAPTCHA still appears: back off ≥ 1h, retry ≤ 2/day, else operator-assisted solve on the Mac.
  - Test tool: `src/test-fresh-login.js` (env-driven; exit codes classify the outcome).
- **Phase 1 — core:** extract `runFarm({profileDir, room})`; SQLite + crypto module; CLI
  `add-user` / `verify` / `farm`; proof paths per user.
- **Phase 2 — daemon:** queue + verification rate policy; per-user staggered scheduling; catch-up; proofs + retention; admin-only Telegram summary.
- **Phase 3 — web:** GitHub OAuth; user dashboard (status, history, proofs); admin view; tunnel exposure.

## Open questions

1. Confirm: "github only" = **Sign in with GitHub** for our site (creds never in GitHub). ⬅ assumed in this plan
2. Keep admin Telegram alerts for the operator? (recommended: yes)
3. ~~Which THM account is the Phase 0 test account?~~ → **resolved**: `leesec01` (warmed profile kept at `~/StreakMate-test-profile2` as the first beta-like account).
