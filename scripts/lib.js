'use strict';

/**
 * Shared helpers for the AutoPipeline orchestrator.
 *
 * The orchestrator has ZERO runtime dependencies — it only uses Node built-ins
 * so that `npm start` works without a root `npm install`.
 */

const { spawn, spawnSync } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');

const IS_WIN = process.platform === 'win32';
const ROOT = path.resolve(__dirname, '..');
const APPS_DIR = path.join(ROOT, 'apps');

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[90m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

// Per-service label colors.
const TAG = {
  setup: COLORS.yellow,
  run: COLORS.blue,
  agent: COLORS.magenta,
  backend: COLORS.cyan,
  frontend: COLORS.green,
};

function tag(name) {
  const color = TAG[name] || COLORS.dim;
  return `${color}[${name}]${COLORS.reset} `;
}

function log(name, msg) {
  process.stdout.write(tag(name) + msg + '\n');
}

function warn(name, msg) {
  process.stdout.write(tag(name) + COLORS.yellow + msg + COLORS.reset + '\n');
}

function error(name, msg) {
  process.stderr.write(tag(name) + COLORS.red + msg + COLORS.reset + '\n');
}

/**
 * Quote an argument for a Windows/POSIX shell command line.
 * The project path contains spaces, so quoting is mandatory.
 */
function quote(arg) {
  const s = String(arg);
  if (s.length > 0 && !/[\s"'&|<>^()]/.test(s)) return s;
  return '"' + s.replace(/"/g, '\\"') + '"';
}

function toCommand(cmd, args) {
  return [cmd, ...args].map(quote).join(' ');
}

/**
 * Forward a child's stdout/stderr to our stdout, line-by-line, with a prefix.
 */
function pipePrefixed(child, name) {
  const prefix = tag(name);
  const attach = (stream, out) => {
    if (!stream) return;
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        out.write(prefix + line + '\n');
      }
    });
    stream.on('end', () => {
      if (buffer.trim()) out.write(prefix + buffer.replace(/\r$/, '') + '\n');
    });
  };
  attach(child.stdout, process.stdout);
  attach(child.stderr, process.stdout);
}

/**
 * Run a one-shot command to completion. Resolves on exit code 0, rejects otherwise.
 * Used by setup steps.
 */
function runStep(name, cmd, args, opts = {}) {
  const command = toCommand(cmd, args);
  const where = opts.cwd ? `  ${COLORS.dim}(in ${path.relative(ROOT, opts.cwd) || '.'})${COLORS.reset}` : '';
  log(name, `${COLORS.dim}$${COLORS.reset} ${command}${where}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: opts.cwd || ROOT,
      env: { ...process.env, ...opts.env },
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    pipePrefixed(child, name);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`\`${cmd}\` exited with code ${code}`));
    });
  });
}

/**
 * Start a long-running service. Returns the ChildProcess (kept alive).
 */
function startService(name, cmd, args, opts = {}) {
  const command = toCommand(cmd, args);
  log(name, `${COLORS.dim}$ ${command}${COLORS.reset}`);
  const child = spawn(command, {
    cwd: opts.cwd || ROOT,
    env: { ...process.env, ...opts.env },
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pipePrefixed(child, name);
  return child;
}

/**
 * Forcefully kill a child process and its whole tree (npm -> node/electron, etc.).
 */
function killTree(child) {
  if (!child || child.pid == null) return;
  try {
    if (IS_WIN) {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }
  } catch {
    /* already gone */
  }
}

/** Poll an HTTP URL until it responds (optionally with a specific status). */
function waitForHttp(url, { timeout = 60000, interval = 700, expectStatus = null } = {}) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const retry = () => {
      if (Date.now() - start > timeout) reject(new Error(`Timed out waiting for ${url}`));
      else setTimeout(attempt, interval);
    };
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (expectStatus == null || res.statusCode === expectStatus) resolve();
        else retry();
      });
      req.on('error', retry);
      req.setTimeout(4000, () => req.destroy());
    };
    attempt();
  });
}

/** Poll a TCP port until something accepts a connection. */
function waitForPort(port, host = '127.0.0.1', { timeout = 60000, interval = 700 } = {}) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const retry = () => {
      if (Date.now() - start > timeout) reject(new Error(`Timed out waiting for port ${port}`));
      else setTimeout(attempt, interval);
    };
    const attempt = () => {
      const socket = net.connect(port, host);
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        retry();
      });
    };
    attempt();
  });
}

/** Find a Python >= 3.11 interpreter. Returns { cmd, pre } or null. */
function detectPython() {
  const candidates = IS_WIN
    ? [['py', ['-3']], ['python', []], ['python3', []]]
    : [['python3', []], ['python', []]];
  for (const [cmd, pre] of candidates) {
    try {
      const res = spawnSync(cmd, [...pre, '-c', 'import sys;print("%d.%d" % sys.version_info[:2])'], {
        encoding: 'utf8',
      });
      if (res.status === 0 && res.stdout) {
        const [maj, min] = res.stdout.trim().split('.').map(Number);
        if (maj === 3 && min >= 11) return { cmd, pre };
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Absolute path to the Python interpreter inside an app's virtualenv. */
function venvPython(appDir) {
  return IS_WIN
    ? path.join(appDir, '.venv', 'Scripts', 'python.exe')
    : path.join(appDir, '.venv', 'bin', 'python');
}

module.exports = {
  IS_WIN,
  ROOT,
  APPS_DIR,
  COLORS,
  log,
  warn,
  error,
  runStep,
  startService,
  killTree,
  waitForHttp,
  waitForPort,
  detectPython,
  venvPython,
  fs,
  path,
};
