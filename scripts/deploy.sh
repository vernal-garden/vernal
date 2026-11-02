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
# Only the live commit or a newer one deploys. To roll back on purpose, run it
# by hand as deploy with VERNAL_DEPLOY_ALLOW_DOWNGRADE=1; the forced command
# never passes that variable on.
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
# Flow: install and build in a separate worktree (BUILD_DIR, same filesystem as
# APP_DIR), migrate, then swap node_modules, dist and client/dist into the live
# checkout by renaming (the previous build is kept as *.prev) and reset it to
# the new SHA. If the swap, the pm2 reload or the health gate fails, the swap is
# undone (the new build moves to *.failed), the checkout is reset to the
# previous SHA and the old build is reloaded and health-checked again.
# Migrations are never rolled back, so a migration must work with the previous
# release's code (see migrations/README.md).
#
# The build checkout's .env and any untracked client/.env* files (e.g.
# .env.sentry-build-plugin) are symlinks to the live checkout's, so a new
# server-side client env file only has to exist in /var/www/vernal/client/.
#
# One-time setup: `sudo install -d -o deploy -g deploy /var/www/vernal-build`.
#
# The VERNAL_DEPLOY_* overrides below exist for scripts/deploy.test.ts. They
# only take effect together with a manual VERNAL_DEPLOY_CLEAN_ENV=1; the forced
# command's env -i re-exec drops them.
#
# After changing this file, reinstall the copy at /home/deploy/bin/vernal-deploy.
set -euo pipefail

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
  # A deliberate rollback is a manual run only: the forced command (GitHub's
  # key) never passes the override on.
  if [[ -z "${SSH_ORIGINAL_COMMAND:-}" && "${VERNAL_DEPLOY_ALLOW_DOWNGRADE:-}" == 1 ]]; then
    clean_env+=(VERNAL_DEPLOY_ALLOW_DOWNGRADE=1)
  fi
  exec env -i "${clean_env[@]}" bash "${BASH_SOURCE[0]}" "$SHA"
fi

# If the SSH session drops mid-deploy, the next write to the closed stdout or
# stderr would raise SIGPIPE (or the hangup SIGHUP) and kill bash halfway
# through a swap or rollback. Ignore both so writes just fail with EPIPE and
# the script runs to the end.
trap '' HUP PIPE

APP_DIR="${VERNAL_DEPLOY_APP_DIR:-/var/www/vernal}"
BUILD_DIR="${VERNAL_DEPLOY_BUILD_DIR:-/var/www/vernal-build}"
LOCK_FILE="${VERNAL_DEPLOY_LOCK:-$HOME/.vernal-deploy.lock}"
HEALTH_URL="${VERNAL_DEPLOY_HEALTH_URL:-http://localhost:3000/health}"
INTERVAL="${VERNAL_DEPLOY_INTERVAL:-2}"
PM2_ATTEMPTS="${VERNAL_DEPLOY_PM2_ATTEMPTS:-10}"       # 10 x 2 s = 20 s
HEALTH_ATTEMPTS="${VERNAL_DEPLOY_HEALTH_ATTEMPTS:-30}" # 30 x 2 s = 60 s

# Moved between the build and live checkouts, in this order.
SWAP_ITEMS=(node_modules dist client/dist)
SWAPPED_OUT=() # live -> .prev done
SWAPPED_IN=()  # build -> live done
APPLIED=""     # migration versions this deploy applied

exec 9>"$LOCK_FILE"
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
PREV_SHA="$(git rev-parse HEAD)"

# Only the live commit or a newer one. An older one would quietly roll
# production back (for example by re-running an old Actions run).
if [[ "$SHA" != "$PREV_SHA" ]] && ! git merge-base --is-ancestor "$PREV_SHA" "$SHA"; then
  if [[ "${VERNAL_DEPLOY_ALLOW_DOWNGRADE:-}" == 1 ]]; then
    echo "VERNAL_DEPLOY_ALLOW_DOWNGRADE=1: deploying $SHA, which is older than the live $PREV_SHA" >&2
  else
    echo "refused: $SHA is not the live $PREV_SHA or a newer commit. To roll back on purpose, run vernal-deploy by hand on the server with VERNAL_DEPLOY_ALLOW_DOWNGRADE=1." >&2
    exit 2
  fi
fi

print_migrations() {
  if [[ -n "$APPLIED" ]]; then
    echo "migrations applied by this deploy$1: $APPLIED" >&2
  fi
}

# Before the swap: the live checkout is untouched, so just stop.
abort() {
  echo "FAIL: deploy of $SHA failed at $1; nothing was swapped, $PREV_SHA is still live" >&2
  print_migrations ""
  exit 1
}

prepare_build() {
  local f name
  if [[ -e "$BUILD_DIR/.git" ]]; then
    # Drop the client env links from the last deploy; they are re-linked below,
    # and --force restores any that this SHA tracks.
    for f in "$BUILD_DIR"/client/.env*; do
      if [[ -L "$f" ]]; then
        rm -f "$f" || return 1
      fi
    done
    git -C "$BUILD_DIR" checkout -q --detach --force "$SHA" || return 1
  else
    git -C "$APP_DIR" worktree prune || return 1
    git -C "$APP_DIR" worktree add -q --detach "$BUILD_DIR" "$SHA" || return 1
  fi
  # -x also removes ignored files (old dist, client/dist); -e keeps the installs
  # and the untracked .env* links (tracked .env* files come from the checkout).
  git -C "$BUILD_DIR" clean -q -ffdx -e node_modules -e '.env*' || return 1
  ln -sfn "$APP_DIR/.env" "$BUILD_DIR/.env" || return 1
  # Gitignored client env files on the server (.env.sentry-build-plugin for the
  # Sentry Vite plugin, .env.production.local, ...) are read from the build's
  # cwd, so link them in. Files either checkout tracks are left to git.
  for f in "$APP_DIR"/client/.env*; do
    [[ -f "$f" ]] || continue # also the unmatched glob
    name="${f##*/}"
    if git -C "$APP_DIR" ls-files --error-unmatch "client/$name" >/dev/null 2>&1 ||
      git -C "$BUILD_DIR" ls-files --error-unmatch "client/$name" >/dev/null 2>&1; then
      continue
    fi
    ln -sfn "$f" "$BUILD_DIR/client/$name" || return 1
  done
  if [[ "$(stat -c %d "$APP_DIR")" != "$(stat -c %d "$BUILD_DIR")" ]]; then
    echo "$BUILD_DIR and $APP_DIR must be on the same filesystem" >&2
    return 1
  fi
}

build() {
  (cd "$BUILD_DIR" && npm ci && npm run build) || return 1
  (cd "$BUILD_DIR/client" && npm ci && npm run build) || return 1
}

migrate() {
  local log status
  log="$(mktemp)" || return 1
  status=0
  (cd "$BUILD_DIR" && npm run migrate) 2>&1 | tee "$log" || status=$?
  APPLIED="$(sed -n 's/^\[ok\] *\([^ ]*\).*/\1/p' "$log" | paste -sd' ' -)"
  rm -f "$log"
  return "$status"
}

swap() {
  local x
  for x in "${SWAP_ITEMS[@]}"; do
    rm -rf "${APP_DIR:?}/$x.prev" || return 1
  done
  for x in "${SWAP_ITEMS[@]}"; do
    if [[ -e "$APP_DIR/$x" ]]; then
      mv -T "$APP_DIR/$x" "$APP_DIR/$x.prev" || return 1
      SWAPPED_OUT+=("$x")
    fi
    mv -T "$BUILD_DIR/$x" "$APP_DIR/$x" || return 1
    SWAPPED_IN+=("$x")
  done
  git -C "$APP_DIR" reset -q --hard "$SHA" || return 1
}

reload() {
  RELOAD_AT="$(date +%s%3N)"
  # 9>&-: a pm2 daemon started here must not inherit the deploy lock.
  # Reload from the ecosystem file (app name 'vernal') so its env block applies.
  (cd "$APP_DIR" && pm2 startOrReload ecosystem.config.cjs --update-env 9>&-)
}

pm2_online() {
  pm2 jlist 9>&- | RELOAD_AT="$RELOAD_AT" node -e '
const list = JSON.parse(require("fs").readFileSync(0, "utf8"));
const p = list.find(x => x.name === "vernal");
if (!p) { console.error("waiting: vernal not in pm2 list"); process.exit(1); }
if (p.pm2_env.status !== "online") { console.error("waiting: status " + p.pm2_env.status); process.exit(1); }
if (p.pm2_env.pm_uptime < Number(process.env.RELOAD_AT) - 1000) { console.error("waiting: not restarted by this reload"); process.exit(1); }
console.log("OK: vernal online");
'
}

health_ok() {
  curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null
}

# retry <attempts> <command...>: run until it succeeds, INTERVAL seconds apart.
retry() {
  local attempts="$1" i
  shift
  for ((i = 1; i <= attempts; i++)); do
    if "$@"; then
      return 0
    fi
    if ((i < attempts)); then
      sleep "$INTERVAL"
    fi
  done
  return 1
}

health_gate() {
  retry "$PM2_ATTEMPTS" pm2_online || return 1
  retry "$HEALTH_ATTEMPTS" health_ok || return 1
  # || true: with SIGPIPE ignored, a dropped SSH session makes this write fail,
  # and that must not turn a healthy deploy into a rollback.
  echo "OK: $HEALTH_URL returned 200" || true
}

# After the swap started: put the previous build back. Always exits 1.
rollback() {
  local stage="$1" ok=1 i x
  set +e
  # swap failed before its first rename (clearing the old *.prev): the live
  # checkout was never touched, so there is nothing to reload or check.
  if ((${#SWAPPED_IN[@]} == 0 && ${#SWAPPED_OUT[@]} == 0)) &&
    [[ "$(git -C "$APP_DIR" rev-parse HEAD)" == "$PREV_SHA" ]]; then
    echo "FAIL: deploy of $SHA failed at $stage before anything was moved; $PREV_SHA is still live" >&2
    print_migrations " (still applied)"
    exit 1
  fi
  echo "deploy of $SHA failed at $stage; rolling back to $PREV_SHA" >&2
  for ((i = ${#SWAPPED_IN[@]} - 1; i >= 0; i--)); do
    x="${SWAPPED_IN[i]}"
    rm -rf "${APP_DIR:?}/$x.failed"
    mv -T "$APP_DIR/$x" "$APP_DIR/$x.failed" || ok=0
  done
  for ((i = ${#SWAPPED_OUT[@]} - 1; i >= 0; i--)); do
    x="${SWAPPED_OUT[i]}"
    mv -T "$APP_DIR/$x.prev" "$APP_DIR/$x" || ok=0
  done
  git -C "$APP_DIR" reset -q --hard "$PREV_SHA" || ok=0
  if ((ok)); then
    if ! reload || ! health_gate; then
      ok=0
    fi
  fi
  if ((ok)); then
    echo "ROLLED BACK to $PREV_SHA: deploy of $SHA failed at $stage" >&2
  else
    echo "ROLLBACK FAILED: site may be down (deploy of $SHA failed at $stage; rollback to $PREV_SHA did not pass)" >&2
  fi
  print_migrations " (still applied)"
  exit 1
}

for x in "${SWAP_ITEMS[@]}"; do
  rm -rf "${APP_DIR:?}/$x.failed"
done

prepare_build || abort prepare
build || abort build
migrate || abort migrate
swap || rollback swap
reload || rollback reload
health_gate || rollback health

print_migrations ""
echo "Deploy complete: $PREV_SHA -> $SHA ($(date))"
