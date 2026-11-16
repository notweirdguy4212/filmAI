#!/usr/bin/env bash
set -euo pipefail

REMOTE_URL="${1:-}"
if [[ -z "$REMOTE_URL" ]]; then
  echo "Usage: ./upload-to-github.sh https://github.com/OWNER/REPOSITORY.git" >&2
  exit 2
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git init
fi

git add -A
if ! git diff --cached --quiet; then
  git commit -m "Upload filmAI Studio"
else
  echo "No staged changes to commit."
fi

if git show-ref --verify --quiet refs/heads/main; then
  git branch -M main
elif [[ -z "$(git branch --show-current)" ]]; then
  git checkout -b main
fi

if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$REMOTE_URL"
else
  git remote add origin "$REMOTE_URL"
fi

git push -u origin HEAD
