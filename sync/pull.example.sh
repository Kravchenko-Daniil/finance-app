#!/usr/bin/env bash
# Two-way sync of the data repo: pull from GitHub, push local edits up.
# Idempotent. Designed to be run from cron every ~5 min.
#
# Setup:
#   1. Copy this file to sync/pull.sh (it's in .gitignore so won't be committed)
#   2. Replace REPO_DIR with the absolute path to your local data repo clone
#   3. Make executable: chmod +x sync/pull.sh
#   4. Add to crontab: */5 * * * * /absolute/path/to/sync/pull.sh
set -euo pipefail

REPO_DIR="/absolute/path/to/your/data-repo"   # ← REPLACE THIS
LOCK="/tmp/data-sync.lock"
LOG="/tmp/data-sync.log"

exec 9>"$LOCK"
flock -n 9 || exit 0

cd "$REPO_DIR"

{
  echo "=== $(date -u +%FT%TZ) ==="
  git pull --rebase --autostash --quiet origin master 2>&1 || echo "pull failed"
  if [ -n "$(git status --porcelain)" ]; then
    git add -A
    git commit -m "auto-sync: $(date -u +%FT%TZ)" --quiet
    git push --quiet origin master 2>&1 || echo "push failed"
    echo "pushed local edits"
  fi
} >>"$LOG" 2>&1

# Trim log to last 200 lines
tail -n 200 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
