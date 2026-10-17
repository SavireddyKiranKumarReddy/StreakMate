#!/bin/bash
# StreakMate catch-up: if today's run hasn't succeeded and it's past 06:10 IST, run now.
# Covers: Mac asleep/off at 6 AM, or a FAILED 6 AM run. Manual runs are never blocked.
# Self-locating: works from Desktop source or ~/StreakMate runtime copy.
cd "$(dirname "$0")/.." || exit 0
TODAY=$(TZ=Asia/Kolkata date +%F)
NOW=$(TZ=Asia/Kolkata date +%H%M)
LAST=$(cat logs/last-success 2>/dev/null | tr -d ' \n')
LOCK=logs/catchup.lock
if [ -f "$LOCK" ] && kill -0 "$(cat $LOCK)" 2>/dev/null; then exit 0; fi
echo $$ > "$LOCK"
trap "rm -f $LOCK" EXIT
if [ "$LAST" != "$TODAY" ] && [ "$NOW" -ge 0610 ]; then
  echo "[$(TZ=Asia/Kolkata date '+%F %T')] catch-up run starting (last success: ${LAST:-none})" >> logs/catchup.log
  /opt/homebrew/bin/node src/farm-chrome.js >> logs/catchup.log 2>&1
fi
