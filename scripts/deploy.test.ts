// Runs the real scripts/deploy.sh against throwaway git repos with fake npm,
// pm2 and curl on PATH. Linux only: the script needs flock and GNU coreutils
// (skipped on Windows / macOS; CI runs it on ubuntu-latest).
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const SCRIPT = path.resolve(__dirname, 'deploy.sh');
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'deploy-test',
  GIT_AUTHOR_EMAIL: 'deploy-test@example.invalid',
  GIT_COMMITTER_NAME: 'deploy-test',
  GIT_COMMITTER_EMAIL: 'deploy-test@example.invalid',
};

const FAKE_NPM = `#!/usr/bin/env bash
set -euo pipefail
echo "npm $* @ $PWD" >> "$FAKE_LOG"
sha=$(git rev-parse HEAD)
case "$*" in
  ci)
    mkdir -p node_modules && echo "$sha" > node_modules/marker ;;
  "run build")
    if [[ "\${FAKE_FAIL:-}" == build ]]; then echo "build broke" >&2; exit 1; fi
    if [[ "$PWD" == */client && -f .env.sentry-build-plugin ]]; then echo "sentry env visible @ $PWD" >> "$FAKE_LOG"; fi
    if [[ "$PWD" == */client && -n "\${FAKE_NO_CLIENT_DIST:-}" ]]; then exit 0; fi
    mkdir -p dist && echo "$sha" > dist/marker ;;
  "run migrate")
    [[ -f .env ]] || { echo "no .env in build checkout" >&2; exit 1; }
    for v in \${FAKE_MIGRATIONS:-}; do echo "[run]  $v ..."; echo "[ok]   $v"; done
    if [[ "\${FAKE_FAIL:-}" == migrate ]]; then echo "[fail] 099_broken" >&2; exit 1; fi ;;
  *) echo "fake npm: unexpected '$*'" >&2; exit 1 ;;
esac
`;

// FAKE_PM2_FAIL_RELOADS=N fails the first N startOrReload calls (counted in
// FAKE_RELOADS). FAKE_UPTIME pins the reported pm_uptime (a process that never
// restarted).
const FAKE_PM2 = `#!/usr/bin/env bash
set -euo pipefail
echo "pm2 $*" >> "$FAKE_LOG"
case "$1" in
  startOrReload)
    n=0; if [[ -f "$FAKE_RELOADS" ]]; then n=$(wc -l < "$FAKE_RELOADS"); fi
    git -C "$PWD" rev-parse HEAD >> "$FAKE_RELOADS"
    if (( n < \${FAKE_PM2_FAIL_RELOADS:-0} )); then echo "[PM2][ERROR] reload failed" >&2; exit 1; fi ;;
  jlist) echo "[{\\"name\\":\\"vernal\\",\\"pm2_env\\":{\\"status\\":\\"online\\",\\"pm_uptime\\":\${FAKE_UPTIME:-$(date +%s%3N)}}}]" ;;
  *) echo "fake pm2: unexpected '$*'" >&2; exit 1 ;;
esac
`;

// FAKE_HEALTH is a comma list consumed one per call ("fail" or "200"); the last
// entry repeats once the list runs out.
const FAKE_CURL = `#!/usr/bin/env bash
set -euo pipefail
n=$(cat "$FAKE_HEALTH_COUNT" 2>/dev/null || echo 0)
echo $((n + 1)) > "$FAKE_HEALTH_COUNT"
IFS=, read -ra seq <<< "\${FAKE_HEALTH:-200}"
idx=$(( n < \${#seq[@]} ? n : \${#seq[@]} - 1 ))
if [[ "\${seq[$idx]}" == 200 ]]; then echo '{"status":"ok"}'; exit 0; fi
echo "curl: (22) The requested URL returned error: 503" >&2
exit 22
`;

interface Env {
  root: string;
  app: string;
  build: string;
  seed: string;
  log: string;
  reloads: string;
  shaA: string;
  shaB: string;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

function commitFile(seed: string, file: string, content: string, message: string): string {
  fs.mkdirSync(path.dirname(path.join(seed, file)), { recursive: true });
  fs.writeFileSync(path.join(seed, file), content);
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', message);
  git(seed, 'push', '-q', 'origin', 'main');
  return git(seed, 'rev-parse', 'HEAD');
}

function writeMarker(dir: string, sha: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'marker'), `${sha}\n`);
}

function readMarker(dir: string): string {
  return fs.readFileSync(path.join(dir, 'marker'), 'utf8').trim();
}

// Live checkout at commit A with a "deployed" A build; origin/main is at B.
function setup(): Env {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vernal-deploy-'));
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  const app = path.join(root, 'app');
  const build = path.join(root, 'app-build');
  const bin = path.join(root, 'bin');

  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: GIT_ENV });
  execFileSync('git', ['init', '-q', '-b', 'main', seed], { env: GIT_ENV });
  git(seed, 'remote', 'add', 'origin', origin);
  fs.writeFileSync(path.join(seed, '.gitignore'), 'node_modules/\ndist/\n.env\n.env.sentry-build-plugin\n');
  // A tracked client env file: the build must get it from its own checkout.
  fs.mkdirSync(path.join(seed, 'client'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'client', '.env.production'), 'VITE_TRACKED=1\n');
  fs.writeFileSync(path.join(seed, 'ecosystem.config.cjs'), 'module.exports = { apps: [] };\n');
  const shaA = commitFile(seed, 'client/index.html', '<p>A</p>\n', 'A');

  execFileSync('git', ['clone', '-q', origin, app], { env: GIT_ENV });
  fs.writeFileSync(path.join(app, '.env'), 'DATABASE_URL=unused\n');
  fs.writeFileSync(path.join(app, 'client', '.env.sentry-build-plugin'), 'SENTRY_AUTH_TOKEN=unused\n');
  writeMarker(path.join(app, 'node_modules'), shaA);
  writeMarker(path.join(app, 'dist'), shaA);
  writeMarker(path.join(app, 'client', 'dist'), shaA);
  fs.mkdirSync(build); // the one-time empty directory, as on the server

  const shaB = commitFile(seed, 'client/index.html', '<p>B</p>\n', 'B');

  fs.mkdirSync(bin);
  for (const [name, body] of [['npm', FAKE_NPM], ['pm2', FAKE_PM2], ['curl', FAKE_CURL]]) {
    fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  }

  return {
    root, app, build, seed, shaA, shaB,
    log: path.join(root, 'calls.log'),
    reloads: path.join(root, 'reloads.log'),
  };
}

function deploy(env: Env, sha: string, extra: Record<string, string> = {}) {
  const result = spawnSync('bash', [SCRIPT, sha], {
    encoding: 'utf8',
    env: {
      PATH: `${path.join(env.root, 'bin')}:${process.env.PATH}`,
      HOME: env.root,
      LANG: 'C.UTF-8',
      VERNAL_DEPLOY_CLEAN_ENV: '1',
      VERNAL_DEPLOY_APP_DIR: env.app,
      VERNAL_DEPLOY_BUILD_DIR: env.build,
      VERNAL_DEPLOY_LOCK: path.join(env.root, 'deploy.lock'),
      VERNAL_DEPLOY_HEALTH_URL: 'http://localhost:9/health',
      VERNAL_DEPLOY_INTERVAL: '0',
      VERNAL_DEPLOY_PM2_ATTEMPTS: '3',
      VERNAL_DEPLOY_HEALTH_ATTEMPTS: '3',
      FAKE_LOG: env.log,
      FAKE_RELOADS: env.reloads,
      FAKE_HEALTH_COUNT: path.join(env.root, 'health.count'),
      ...extra,
    },
  });
  return { status: result.status, out: `${result.stdout}\n${result.stderr}` };
}

function calls(env: Env): string {
  return fs.existsSync(env.log) ? fs.readFileSync(env.log, 'utf8') : '';
}

function expectLiveAt(env: Env, sha: string): void {
  expect(git(env.app, 'rev-parse', 'HEAD')).toBe(sha);
  expect(readMarker(path.join(env.app, 'node_modules'))).toBe(sha);
  expect(readMarker(path.join(env.app, 'dist'))).toBe(sha);
  expect(readMarker(path.join(env.app, 'client', 'dist'))).toBe(sha);
}

describe.skipIf(process.platform !== 'linux')('scripts/deploy.sh', () => {
  let env: Env;

  beforeEach(() => {
    env = setup();
  });

  afterEach(() => {
    fs.rmSync(env.root, { recursive: true, force: true });
  });

  it('builds in the build checkout, migrates, swaps and keeps the previous build', () => {
    const r = deploy(env, env.shaB, { FAKE_MIGRATIONS: '031_new' });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain(`Deploy complete: ${env.shaA} -> ${env.shaB}`);
    expect(r.out).toContain('migrations applied by this deploy: 031_new');
    expectLiveAt(env, env.shaB);
    expect(readMarker(path.join(env.app, 'dist.prev'))).toBe(env.shaA);
    expect(readMarker(path.join(env.app, 'node_modules.prev'))).toBe(env.shaA);
    expect(readMarker(path.join(env.app, 'client', 'dist.prev'))).toBe(env.shaA);
    expect(fs.readlinkSync(path.join(env.build, '.env'))).toBe(path.join(env.app, '.env'));
    // Untracked client env files are linked in and visible to the client build;
    // tracked ones stay the checkout's own files.
    expect(fs.readlinkSync(path.join(env.build, 'client', '.env.sentry-build-plugin')))
      .toBe(path.join(env.app, 'client', '.env.sentry-build-plugin'));
    expect(calls(env)).toContain(`sentry env visible @ ${path.join(env.build, 'client')}`);
    expect(fs.lstatSync(path.join(env.build, 'client', '.env.production')).isFile()).toBe(true);
    // Install and builds ran in the build checkout, never in the live one.
    expect(calls(env)).not.toMatch(new RegExp(`npm .* @ ${env.app}(/client)?$`, 'm'));
    expect(calls(env)).toContain(`npm run migrate @ ${env.build}`);
  });

  it('a failed build changes nothing and never migrates', () => {
    const r = deploy(env, env.shaB, { FAKE_FAIL: 'build' });
    expect(r.status).toBe(1);
    expect(r.out).toContain(`deploy of ${env.shaB} failed at build`);
    expect(calls(env)).not.toContain('run migrate');
    expect(calls(env)).not.toContain('pm2 startOrReload');
    expectLiveAt(env, env.shaA);
    expect(fs.existsSync(path.join(env.app, 'dist.prev'))).toBe(false);
  });

  it('a failed migration stops before the swap and lists what it applied', () => {
    const r = deploy(env, env.shaB, { FAKE_FAIL: 'migrate', FAKE_MIGRATIONS: '031_new' });
    expect(r.status).toBe(1);
    expect(r.out).toContain(`deploy of ${env.shaB} failed at migrate`);
    expect(r.out).toContain('migrations applied by this deploy: 031_new');
    expect(calls(env)).not.toContain('pm2 startOrReload');
    expectLiveAt(env, env.shaA);
  });

  it('retries /health until it passes', () => {
    const r = deploy(env, env.shaB, { FAKE_HEALTH: 'fail,fail,200' });
    expect(r.status, r.out).toBe(0);
    expectLiveAt(env, env.shaB);
  });

  it('rolls back when /health never passes', () => {
    // Three failed attempts exhaust the new build's gate; the rollback's gate gets 200.
    const r = deploy(env, env.shaB, { FAKE_HEALTH: 'fail,fail,fail,200', FAKE_MIGRATIONS: '031_new' });
    expect(r.status).toBe(1);
    expect(r.out).toContain(`ROLLED BACK to ${env.shaA}: deploy of ${env.shaB} failed at health`);
    expect(r.out).toContain('migrations applied by this deploy (still applied): 031_new');
    expectLiveAt(env, env.shaA);
    expect(readMarker(path.join(env.app, 'dist.failed'))).toBe(env.shaB);
    expect(fs.readFileSync(env.reloads, 'utf8').trim().split('\n')).toEqual([env.shaB, env.shaA]);
  });

  it('reports ROLLBACK FAILED when the previous build is not healthy either', () => {
    const r = deploy(env, env.shaB, { FAKE_HEALTH: 'fail' });
    expect(r.status).toBe(1);
    expect(r.out).toContain('ROLLBACK FAILED: site may be down');
    expect(r.out).not.toContain('ROLLED BACK to');
  });

  it('restores a swap that stopped partway', () => {
    // The client build "succeeds" without output, so the client/dist rename fails
    // after node_modules and dist were already swapped.
    const r = deploy(env, env.shaB, { FAKE_NO_CLIENT_DIST: '1' });
    expect(r.status).toBe(1);
    expect(r.out).toContain(`ROLLED BACK to ${env.shaA}: deploy of ${env.shaB} failed at swap`);
    expectLiveAt(env, env.shaA);
    expect(fs.existsSync(path.join(env.app, 'client', 'dist.prev'))).toBe(false);
  });

  it('deploys again on top of a previous deploy', () => {
    expect(deploy(env, env.shaB).status).toBe(0);
    const shaC = commitFile(env.seed, 'client/index.html', '<p>C</p>\n', 'C');
    fs.mkdirSync(path.join(env.build, 'client', 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(env.build, 'client', 'node_modules', 'keep'), 'keep\n');
    const r = deploy(env, shaC);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain(`Deploy complete: ${env.shaB} -> ${shaC}`);
    expectLiveAt(env, shaC);
    expect(readMarker(path.join(env.app, 'node_modules.prev'))).toBe(env.shaB);
    expect(readMarker(path.join(env.app, 'dist.prev'))).toBe(env.shaB);
    expect(readMarker(path.join(env.app, 'client', 'dist.prev'))).toBe(env.shaB);
    // git clean keeps the client install and the env links.
    expect(fs.existsSync(path.join(env.build, 'client', 'node_modules', 'keep'))).toBe(true);
    expect(fs.readlinkSync(path.join(env.build, '.env'))).toBe(path.join(env.app, '.env'));
    expect(fs.readlinkSync(path.join(env.build, 'client', '.env.sentry-build-plugin')))
      .toBe(path.join(env.app, 'client', '.env.sentry-build-plugin'));
  });

  it('rolls back when the pm2 reload fails', () => {
    const r = deploy(env, env.shaB, { FAKE_PM2_FAIL_RELOADS: '1' });
    expect(r.status).toBe(1);
    expect(r.out).toContain(`ROLLED BACK to ${env.shaA}: deploy of ${env.shaB} failed at reload`);
    expectLiveAt(env, env.shaA);
    expect(fs.readFileSync(env.reloads, 'utf8').trim().split('\n')).toEqual([env.shaB, env.shaA]);
  });

  it('fails the health stage when pm2 never reports a restart', () => {
    // pm_uptime stays at 0 for the new build and for the rollback, so neither
    // gate gets past the pm2 check (and /health is never asked).
    const r = deploy(env, env.shaB, { FAKE_UPTIME: '0' });
    expect(r.status).toBe(1);
    expect(r.out).toContain('waiting: not restarted by this reload');
    expect(r.out).toContain(`ROLLBACK FAILED: site may be down (deploy of ${env.shaB} failed at health`);
    expect(fs.existsSync(path.join(env.root, 'health.count'))).toBe(false);
    expect(git(env.app, 'rev-parse', 'HEAD')).toBe(env.shaA);
  });

  it('removes a leftover .failed build on the next deploy', () => {
    writeMarker(path.join(env.app, 'dist.failed'), 'old');
    const r = deploy(env, env.shaB);
    expect(r.status, r.out).toBe(0);
    expect(fs.existsSync(path.join(env.app, 'dist.failed'))).toBe(false);
  });
});
