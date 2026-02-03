const { app, BrowserWindow } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let mainWindow;
let backendProcess;
let agentProcess;


function getDatabaseUrl() {
  const userDataPath = app.getPath('userData');
  const dbPath = path.join(userDataPath, 'autopipeline.db');

  // Prisma SQLite URL format
  return `file:${dbPath}`;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Load frontend (Next.js exported folder)
  mainWindow.loadFile(path.join(__dirname, '../apps/frontend/out/index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.on('ready', () => {
  const DATABASE_URL = getDatabaseUrl();
  console.log("DATABASE_URL =", DATABASE_URL);

  backendProcess = spawn(
    'node',
    [path.join(__dirname, '../apps/backend/dist/main.js')],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        PORT: '3333',
        DATABASE_URL,
      },
    }
  );

//   // Start Python agent
//   agentProcess = spawn('python', [path.join(__dirname, '../apps/agent/agent_main.py')], {
//     stdio: 'inherit',
//   });

  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
  if (backendProcess) backendProcess.kill();
  if (agentProcess) agentProcess.kill();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});
