'use strict';

/**
 * Launches the full AutoPipeline stack as one app:
 *
 *   1. Agent    (Python / FastAPI)  ->  http://localhost:8000
 *   2. Backend  (NestJS BFF)        ->  http://localhost:3333
 *   3. Frontend (Next.js dev)       ->  http://localhost:3001
 *   4. Electron desktop window (the frontend's own shell) opens the UI.
 *
 * The client types one prompt in the window; the backend proxies the agent's
 * streamed response back. Closing the window (or Ctrl+C) tears everything down.
 */

const {
  APPS_DIR,
  log,
  warn,
  error,
  startService,
  killTree,
  waitForHttp,
  waitForPort,
  freePort,
  venvPython,
  fs,
  path,
  COLORS,
} = require('./lib');
const { setup, isSetupComplete } = require('./setup');

const AGENT_PORT = 8000;
const BACKEND_PORT = 3333;
const FRONTEND_PORT = 3001;

const AGENT_DIR = path.join(APPS_DIR, 'agent');
const BACKEND_DIR = path.join(APPS_DIR, 'backend');
const FRONTEND_DIR = path.join(APPS_DIR, 'frontend');

const children = [];
let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('run', 'Shutting down services…');
  for (const child of children) killTree(child);
  // Give taskkill a moment to reap the trees before exiting.
  setTimeout(() => process.exit(code), 500);
}

function track(child, name, { fatal = false } = {}) {
  children.push(child);
  child.on('close', (code) => {
    if (shuttingDown) return;
    if (fatal) {
      log('run', `${name} exited — shutting down.`);
      shutdown(code || 0);
    } else if (code && code !== 0) {
      warn('run', `${name} exited unexpectedly with code ${code}.`);
    }
  });
  child.on('error', (err) => error(name, err.message));
}

async function main() {
  process.on('SIGINT', () => {
    process.stdout.write('\n');
    shutdown(0);
  });
  process.on('SIGTERM', () => shutdown(0));

  if (!isSetupComplete()) {
    log('run', 'Apps not fully installed — running setup first…');
    await setup({ update: false, reinstall: false });
  }

  // Clear out any stale processes left over from a previous run that didn't
  // shut down cleanly (e.g. terminal closed instead of Ctrl+C) — otherwise
  // the new services fail to bind their ports and the whole stack exits
  // immediately.
  freePort(AGENT_PORT, 'run');
  freePort(BACKEND_PORT, 'run');
  freePort(FRONTEND_PORT, 'run');

  // 1) Agent -----------------------------------------------------------------
  log('run', 'Starting agent…');
  const agent = startService('agent', venvPython(AGENT_DIR), ['-m', 'agent'], {
    cwd: AGENT_DIR,
    env: {
      PYTHONPATH: path.join(AGENT_DIR, 'src'),
      PYTHONUNBUFFERED: '1',
    },
  });
  track(agent, 'agent', { fatal: true });
  try {
    await waitForHttp(`http://localhost:${AGENT_PORT}/health`, { timeout: 180000, expectStatus: 200 });
    log('run', `${COLORS.green}Agent ready${COLORS.reset} on :${AGENT_PORT}`);
  } catch (e) {
    error('run', `Agent failed to become healthy: ${e.message}`);
    return shutdown(1);
  }

  // 2) Backend ---------------------------------------------------------------
  log('run', 'Starting backend…');
  const backend = startService('backend', 'npm', ['run', 'start:dev'], {
    cwd: BACKEND_DIR,
    env: {
      PORT: String(BACKEND_PORT),
      AGENT_URL: `http://localhost:${AGENT_PORT}`,
    },
  });
  track(backend, 'backend', { fatal: true });
  try {
    await waitForPort(BACKEND_PORT, '127.0.0.1', { timeout: 120000 });
    log('run', `${COLORS.green}Backend ready${COLORS.reset} on :${BACKEND_PORT}`);
  } catch (e) {
    error('run', `Backend failed to start: ${e.message}`);
    return shutdown(1);
  }

  // 3) Frontend (Next dev server) --------------------------------------------
  log('run', 'Starting frontend…');
  const frontendEnv = { NEXT_PUBLIC_BACKEND_URL: `http://localhost:${BACKEND_PORT}` };
  const web = startService('frontend', 'npm', ['run', 'dev'], {
    cwd: FRONTEND_DIR,
    env: frontendEnv,
  });
  track(web, 'frontend', { fatal: true });
  try {
    await waitForHttp(`http://localhost:${FRONTEND_PORT}`, { timeout: 120000 });
    log('run', `${COLORS.green}Frontend ready${COLORS.reset} on :${FRONTEND_PORT}`);
  } catch (e) {
    error('run', `Frontend failed to start: ${e.message}`);
    return shutdown(1);
  }

  // 4) Electron desktop window (frontend's own shell + preload) ---------------
  log('run', 'Opening the desktop window…');
  const desktop = startService('frontend', 'npm', ['run', 'electron'], {
    cwd: FRONTEND_DIR,
    env: frontendEnv,
  });
  // Closing the window is the signal to stop the whole stack.
  track(desktop, 'desktop', { fatal: true });

  log('run', `${COLORS.green}AutoPipeline is running.${COLORS.reset} Close the window or press Ctrl+C to stop.`);
}

main().catch((e) => {
  error('run', e.stack || e.message);
  shutdown(1);
});
