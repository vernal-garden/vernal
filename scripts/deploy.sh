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
#
# The deploy runs under `env -i` with a small allow-list (HOME, PATH, LANG,
# PM2_HOME) and reloads the app from ecosystem.config.cjs. The app must not
# inherit the SSH session's environment: pm2 --update-env merges the caller's
# env into the app's, and dotenv never overrides existing variables, so a stray
# MAIL (the mail spool path) once beat the .env setting and crashed production.
# npm ci / migrate / the Vite build also run with this clean env.
#
# pm2 --update-env only adds/overwrites keys: keys inherited by earlier deploys
# stay in the stored process env (and dump.pm2) until a one-time
# `pm2 delete vernal && pm2 start ecosystem.config.cjs && pm2 save` from a clean
# shell. Setting VERNAL_DEPLOY_CLEAN_ENV by hand skips the clean re-exec (the
# forced command can't).
#
# After changing this file, reinstall the copy at /home/deploy/bin/vernal-deploy.
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

# Re-exec once in a clean environment. The copy has no SSH_ORIGINAL_COMMAND, so
# it takes the $1 path with the SHA validated above. BASH_SOURCE[0] is the
# absolute /home/deploy/bin/vernal-deploy under sshd's forced command (and
# whatever path was used when run manually, which is fine).
if [[ -z "${VERNAL_DEPLOY_CLEAN_ENV:-}" ]]; then
  clean_env=(HOME="$HOME" PATH="$PATH" LANG=C.UTF-8 VERNAL_DEPLOY_CLEAN_ENV=1)
  if [[ -n "${PM2_HOME:-}" ]]; then
    clean_env+=(PM2_HOME="$PM2_HOME")
  fi
  exec env -i "${clean_env[@]}" bash "${BASH_SOURCE[0]}" "$SHA"
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
# Reload from the ecosystem file (app name 'vernal') so its env block applies.
pm2 startOrReload ecosystem.config.cjs --update-env 9>&-
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
