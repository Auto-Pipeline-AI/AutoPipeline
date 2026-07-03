'use strict';

/**
 * Fetches the agent / backend / frontend repos into ./apps and installs their
 * dependencies. Idempotent: skips heavy steps that are already done.
 *
 *   node scripts/setup.js              clone missing repos, install missing deps
 *   node scripts/setup.js --update     also `git pull` repos that already exist
 *   node scripts/setup.js --reinstall  force reinstall of all dependencies
 */

const {
  ROOT,
  APPS_DIR,
  log,
  warn,
  error,
  runStep,
  detectPython,
  venvPython,
  fs,
  path,
} = require('./lib');

const REPOS = [
  { name: 'agent', url: 'https://github.com/Auto-Pipeline-AI/agent.git' },
  { name: 'backend', url: 'https://github.com/Auto-Pipeline-AI/backend.git' },
  { name: 'frontend', url: 'https://github.com/Auto-Pipeline-AI/frontend.git' },
];

function appDir(name) {
  return path.join(APPS_DIR, name);
}

/** Copy `.env-example` to `.env` inside a repo, if present and not already there. */
function seedEnv(dir, fallback) {
  const dest = path.join(dir, '.env');
  if (fs.existsSync(dest)) return;
  const example = path.join(dir, '.env-example');
  if (fs.existsSync(example)) {
    fs.copyFileSync(example, dest);
    log('setup', `Created ${path.relative(ROOT, dest)} from .env-example`);
  } else if (fallback) {
    fs.writeFileSync(dest, fallback);
    log('setup', `Created ${path.relative(ROOT, dest)}`);
  }
}

/** Write/overwrite a single KEY=value in a repo's .env (ensures the value is correct). */
function ensureEnvVar(dir, key, value) {
  const dest = path.join(dir, '.env');
  let content = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : '';
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(content)) {
    content = content.replace(re, line);
  } else {
    if (content.length && !content.endsWith('\n')) content += '\n';
    content += line + '\n';
  }
  fs.writeFileSync(dest, content);
}

async function ensureRepo(repo, { update }) {
  const dir = appDir(repo.name);
  if (fs.existsSync(path.join(dir, '.git'))) {
    if (update) {
      try {
        await runStep('setup', 'git', ['-C', dir, 'pull', '--ff-only']);
      } catch (e) {
        warn('setup', `Could not update ${repo.name} (${e.message}); using existing checkout.`);
      }
    } else {
      log('setup', `${repo.name}: already present, skipping clone.`);
    }
    return;
  }
  await runStep('setup', 'git', ['clone', repo.url, dir]);
}

async function setupAgent({ reinstall }) {
  const dir = appDir('agent');
  const py = venvPython(dir);
  if (reinstall || !fs.existsSync(py)) {
    const found = detectPython();
    if (!found) {
      throw new Error(
        'Python >= 3.11 not found on PATH. Install it from https://www.python.org/downloads/ and re-run setup.',
      );
    }
    log('setup', `Creating Python virtualenv for the agent…`);
    await runStep('setup', found.cmd, [...found.pre, '-m', 'venv', '.venv'], { cwd: dir });
    await runStep('setup', py, ['-m', 'pip', 'install', '--upgrade', 'pip'], { cwd: dir });
    log('setup', 'Installing agent dependencies (this can take a few minutes)…');
    await runStep('setup', py, ['-m', 'pip', 'install', '-e', '.'], { cwd: dir });
  } else {
    log('setup', 'agent: virtualenv already present, skipping install (use --reinstall to force).');
  }
  seedEnv(dir);
}

async function setupBackend({ reinstall }) {
  const dir = appDir('backend');
  if (reinstall || !fs.existsSync(path.join(dir, 'node_modules'))) {
    log('setup', 'Installing backend dependencies…');
    await runStep('setup', 'npm', ['install'], { cwd: dir });
  } else {
    log('setup', 'backend: node_modules already present, skipping install.');
  }
  // Prisma client + database (SQLite path is resolved by prisma.config.ts per-OS).
  await runStep('setup', 'npx', ['prisma', 'generate'], { cwd: dir });
  await runStep('setup', 'npx', ['prisma', 'migrate', 'deploy'], { cwd: dir });
  seedEnv(dir, 'PORT=3333\nAGENT_URL=http://localhost:8000\n');
  ensureEnvVar(dir, 'PORT', '3333');
  ensureEnvVar(dir, 'AGENT_URL', 'http://localhost:8000');
}

async function setupFrontend({ reinstall }) {
  const dir = appDir('frontend');
  if (reinstall || !fs.existsSync(path.join(dir, 'node_modules'))) {
    log('setup', 'Installing frontend dependencies (includes Electron; first run downloads it)…');
    await runStep('setup', 'npm', ['install'], { cwd: dir });
  } else {
    log('setup', 'frontend: node_modules already present, skipping install.');
  }
  seedEnv(dir, 'NEXT_PUBLIC_BACKEND_URL=http://localhost:3333\n');
  ensureEnvVar(dir, 'NEXT_PUBLIC_BACKEND_URL', 'http://localhost:3333');
}

async function setup(opts = {}) {
  const { update = false, reinstall = false } = opts;
  fs.mkdirSync(APPS_DIR, { recursive: true });

  log('setup', 'Fetching repositories…');
  for (const repo of REPOS) {
    await ensureRepo(repo, { update });
  }

  await setupAgent({ reinstall });
  await setupBackend({ reinstall });
  await setupFrontend({ reinstall });

  log('setup', '\x1b[32mSetup complete.\x1b[0m Run `npm start` to launch AutoPipeline.');
}

/** Are all three apps cloned and installed? Used by run.js to auto-setup. */
function isSetupComplete() {
  return (
    fs.existsSync(venvPython(appDir('agent'))) &&
    fs.existsSync(path.join(appDir('backend'), 'node_modules')) &&
    fs.existsSync(path.join(appDir('frontend'), 'node_modules'))
  );
}

module.exports = { setup, isSetupComplete };

if (require.main === module) {
  const args = process.argv.slice(2);
  setup({
    update: args.includes('--update'),
    reinstall: args.includes('--reinstall'),
  }).catch((e) => {
    error('setup', e.message);
    process.exit(1);
  });
}
