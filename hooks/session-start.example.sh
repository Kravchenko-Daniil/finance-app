#!/usr/bin/env bash
# Pulls latest state of the data repo on Claude Code session start.
# Silent on success and on benign failures (network, no repo).
#
# Setup:
#   1. Copy this file to hooks/session-start.sh (it's in .gitignore)
#   2. Replace REPO_DIR with the absolute path to your local data repo clone
#   3. Hook this script into ~/.claude/settings.json as a SessionStart hook
#      (see hooks/HOOK-INSTALL.md)
REPO_DIR="/absolute/path/to/your/data-repo"   # ← REPLACE THIS
[ -d "$REPO_DIR/.git" ] || exit 0
cd "$REPO_DIR" 2>/dev/null || exit 0
git pull --rebase --autostash --quiet 2>/dev/null || true
exit 0
