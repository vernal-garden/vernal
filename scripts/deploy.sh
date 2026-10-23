#!/usr/bin/env bash
# Production deploy, run on the droplet as the deploy user.
#
# Installed as a COPY at /home/deploy/bin/vernal-deploy (not a symlink): the
# deploy key's authorized_keys entry forces this command, so changing what the
# key can do takes a deliberate reinstall, not just a merge.
#
#   restrict,command="/home/deploy/bin/vernal-deploy" ssh-ed25519 AAAA... deploy@github
#
# Usage: vernal-deploy <40-char commit sha>
# Under the forced command the SHA comes from SSH_ORIGINAL_COMMAND instead.
set -euo pipefail

APP_DIR=/var/www/vernal

if [[ -n "${SSH_ORIGINAL_COMMAND:-}" ]]; then
  if [[ ! "$SSH_ORIGINAL_COMMAND" =~ ^[^[:space:]]*vernal-deploy\ ([0-9a-f]{40})$ ]]; then
    echo "refused: expected 'vernal-deploy <40-char commit sha>'" >&2
    exit 2
  fi
  SHA="${BASH_REMATCH[1]}"
else
  if [[ $# -ne 1 || ! "$1" =~ ^[0-9a-f]{40}$ ]]; then
    echo "usage: vernal-deploy <40-char commit sha>" >&2
    exit 2
  fi
  SHA="$1"
fi

exec 9>"$HOME/.vernal-deploy.lock"
if ! flock -n 9; then
  echo "another deploy is running" >&2
  exit 1
fi

cd "$APP_DIR"
git fetch origin main
if ! git merge-base --is-ancestor "$SHA" origin/main 2>/dev/null; then
  echo "refused: $SHA is not on origin/main" >&2
  exit 2
fi

git reset --hard "$SHA"
npm ci
npm run migrate
npm run build
cd "$APP_DIR/client"
npm ci
npm run build
cd "$APP_DIR"
# 9>&-: a pm2 daemon started here must not inherit the deploy lock.
pm2 reload vernal --update-env 9>&-
sleep 5
pm2 jlist 9>&- | node -e '
const list = JSON.parse(require("fs").readFileSync(0, "utf8"));
const p = list.find(x => x.name === "vernal");
if (!p) { console.error("FAIL: vernal not in pm2 list"); process.exit(1); }
if (p.pm2_env.status !== "online") { console.error("FAIL: status " + p.pm2_env.status); process.exit(1); }
const upSec = (Date.now() - p.pm2_env.pm_uptime) / 1000;
if (upSec > 60) { console.error("FAIL: uptime " + upSec + "s — reload did not restart the process"); process.exit(1); }
console.log("OK: vernal online, uptime " + Math.round(upSec) + "s");
'
curl -fsS --max-time 10 http://localhost:3000/health
echo "Deploy complete: $(date)"
