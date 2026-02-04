const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

let mainWindow;
let backendProcess;
let frontendProcess;

const isDev = process.argv.includes('--dev');
const BACKEND_PORT = 3333;
const FRONTEND_PORT = 3001;

// IPC handler for folder selection
ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Project Folder',
  });

  if (result.canceled) return null;
  return result.filePaths[0];
});

function getDatabaseUrl() {
  const userDataPath = app.getPath('userData');
  const dbPath = path.join(userDataPath, 'autopipeline.db');
  // Convert Windows backslashes to forward slashes for SQLite
  return `file:${dbPath.replace(/\\/g, '/')}`;
}

function waitForServer(url, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    const check = () => {
      http.get(url, (res) => {
        resolve();
      }).on('error', () => {
        if (Date.now() - startTime > timeout) {
          reject(new Error(`Server at ${url} did not start within ${timeout}ms`));
        } else {
          setTimeout(check, 500);
        }
      });
    };

    check();
  });
}

function runMigrations(databaseUrl) {
  return new Promise((resolve, reject) => {
    console.log('Running database migrations...');

    const migrate = spawn('npx', ['prisma', 'db', 'push'], {
      cwd: path.join(__dirname, '../apps/backend'),
      stdio: 'inherit',
      shell: true,
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });

    migrate.on('close', (code) => {
      if (code === 0) {
        console.log('Database migrations complete!');
        resolve();
      } else {
        reject(new Error(`Migration failed with code ${code}`));
      }
    });

    migrate.on('error', reject);
  });
}

async function startBackend() {
  const DATABASE_URL = getDatabaseUrl();
  console.log('Starting backend with DATABASE_URL:', DATABASE_URL);

  // Run migrations first
  try {
    await runMigrations(DATABASE_URL);
  } catch (err) {
    console.error('Migration error:', err);
  }

  backendProcess = spawn('node', [path.join(__dirname, '../apps/backend/dist/main.js')], {
    stdio: 'inherit',
    env: { ...process.env, PORT: String(BACKEND_PORT), DATABASE_URL },
    shell: true,
  });

  backendProcess.on('error', (err) => console.error('Backend error:', err));
}

function startFrontend() {
  const frontendDir = path.join(__dirname, '../apps/frontend');
  const script = isDev ? 'dev' : 'start';

  console.log(`Starting frontend in ${isDev ? 'development' : 'production'} mode...`);

  frontendProcess = spawn('npm', ['run', script], {
    cwd: frontendDir,
    stdio: 'inherit',
    shell: true,
  });

  frontendProcess.on('error', (err) => console.error('Frontend error:', err));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadURL(`http://localhost:${FRONTEND_PORT}`);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function cleanup() {
  if (backendProcess) backendProcess.kill();
  if (frontendProcess) frontendProcess.kill();
}

app.on('ready', async () => {
  startBackend();
  startFrontend();

  try {
    console.log('Waiting for frontend server...');
    await waitForServer(`http://localhost:${FRONTEND_PORT}`);
    console.log('Frontend ready!');
    createWindow();
  } catch (err) {
    console.error('Failed to start:', err);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  cleanup();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});

app.on('quit', cleanup);
