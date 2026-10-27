'use strict';

const { app, BrowserWindow, Menu, desktopCapturer, ipcMain, session } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const linuxAudio = require('./linux-audio');

const CHUNK_BYTES = 960 * 2 * 4;

function serverOrigin() {
  const fromArg = process.argv.find((arg) => arg.startsWith('--url='));
  const raw = (fromArg && fromArg.slice('--url='.length)) || process.env.VDZ_URL || 'https://vdz.onrender.com';
  return new URL(raw).origin;
}

function loopbackPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'vdz-loopback.exe');
  return path.join(__dirname, 'loopback', 'publish', 'vdz-loopback.exe');
}

let selectedSource = null;
const sourceCache = new Map();
let audioChild = null;
let audioQueue = Buffer.alloc(0);
let hostContents = null;

function hwndFromSourceId(id) {
  const match = /^window:(-?\d+):(-?\d+)$/.exec(id);
  if (!match) return null;
  const value = BigInt(match[1]);
  const bits = process.platform === 'linux' ? 32n : 64n;
  const mask = (1n << bits) - 1n;
  return (value & mask).toString();
}

function stopAudio() {
  audioQueue = Buffer.alloc(0);
  if (process.platform === 'linux') {
    linuxAudio.stop();
    return;
  }
  const child = audioChild;
  audioChild = null;
  if (!child) return;
  child.stdout.removeAllListeners('data');
  try {
    child.stdin.end();
  } catch {
    // A entrada já estava fechada.
  }
  child.kill();
}

function startAudio(pid, contents) {
  stopAudio();
  hostContents = contents;
  if (process.platform === 'linux') {
    return linuxAudio.start(pid, (piece) => {
      if (!hostContents || hostContents.isDestroyed()) return;
      hostContents.send('vdz-pcm', piece);
    });
  }
  let child;
  try {
    child = spawn(loopbackPath(), ['capture', String(pid)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
  } catch (error) {
    console.error(error);
    return Promise.resolve(false);
  }
  audioChild = child;
  let stderr = '';
  let settled = false;
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(false), 5000);
    function finish(ok) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!ok) {
        if (stderr) console.error(stderr.trim());
        if (audioChild === child) stopAudio();
        resolve(false);
        return;
      }
      resolve(true);
    }
    child.stderr.on('data', (buf) => {
      stderr += buf.toString();
      if (stderr.includes('ready')) finish(true);
    });
    child.on('error', (error) => {
      stderr += String(error);
      finish(false);
    });
    child.on('exit', () => {
      if (!settled) finish(false);
    });
    child.stdout.on('data', (buf) => {
      if (audioChild !== child || !hostContents || hostContents.isDestroyed()) return;
      audioQueue = Buffer.concat([audioQueue, buf]);
      while (audioQueue.length >= CHUNK_BYTES) {
        const piece = Buffer.from(audioQueue.subarray(0, CHUNK_BYTES));
        audioQueue = audioQueue.subarray(CHUNK_BYTES);
        hostContents.send('vdz-pcm', piece);
      }
    });
  });
}

function lookupPids(hwnds) {
  if (!hwnds.length) return Promise.resolve([]);
  if (process.platform === 'linux') return linuxAudio.lookupPids(hwnds);
  return new Promise((resolve, reject) => {
    const child = spawn(loopbackPath(), ['lookup'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text) => {
      out += text;
    });
    child.stderr.on('data', (text) => {
      err += text;
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(err.trim() || 'falha ao identificar as janelas'));
        return;
      }
      const lines = out.trim() ? out.trim().split(/\r?\n/) : [];
      resolve(lines.map((line) => Number(line)));
    });
    child.stdin.write(hwnds.join('\n') + '\n');
    child.stdin.end();
  });
}

function appIcon() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'icon.png');
  return path.join(__dirname, '..', 'public', 'android-chrome-512x512.png');
}

function windowOptions() {
  return {
    width: 960,
    height: 720,
    backgroundColor: '#1a1917',
    autoHideMenuBar: true,
    title: 'vdz',
    icon: appIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  };
}

function allowOrigin(url) {
  try {
    return new URL(url).origin === serverOrigin();
  } catch {
    return false;
  }
}

function wireNavigation(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!allowOrigin(url)) return { action: 'deny' };
    return {
      action: 'allow',
      overrideBrowserWindowOptions: windowOptions()
    };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!allowOrigin(url)) event.preventDefault();
  });
}

function createHost() {
  const win = new BrowserWindow(windowOptions());
  wireNavigation(win);
  win.loadURL(serverOrigin() + '/');
  return win;
}

if (process.platform === 'linux') app.commandLine.appendSwitch('ozone-platform', 'x11');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'media' || permission === 'display-capture' || permission === 'fullscreen');
  });
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    if (!selectedSource) {
      callback({});
      return;
    }
    callback({ video: selectedSource });
  });

  ipcMain.handle('vdz-list-windows', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: false
    });
    const hwnds = [];
    const usable = [];
    for (const source of sources) {
      const hwnd = hwndFromSourceId(source.id);
      if (!hwnd || !source.name || source.name === 'vdz') continue;
      hwnds.push(hwnd);
      usable.push(source);
    }
    let pids = [];
    try {
      pids = await lookupPids(hwnds);
    } catch (error) {
      console.error(error);
      pids = hwnds.map(() => 0);
    }
    sourceCache.clear();
    const listed = [];
    for (let i = 0; i < usable.length; i++) {
      const source = usable[i];
      const pid = pids[i] || 0;
      if (pid === process.pid) continue;
      if (!pid && process.platform !== 'linux') continue;
      sourceCache.set(source.id, source);
      listed.push({
        id: source.id,
        name: source.name,
        thumbnail: source.thumbnail.isEmpty() ? '' : source.thumbnail.toDataURL()
      });
    }
    return listed;
  });

  ipcMain.on('vdz-arm', (event, sourceId) => {
    const source = typeof sourceId === 'string' ? sourceCache.get(sourceId) : null;
    selectedSource = source || null;
    event.returnValue = !!source;
  });

  ipcMain.handle('vdz-begin-audio', async (event, sourceId) => {
    const source = typeof sourceId === 'string' ? sourceCache.get(sourceId) : null;
    if (!source) return false;
    const hwnd = hwndFromSourceId(source.id);
    if (!hwnd) return false;
    let pid = 0;
    try {
      const pids = await lookupPids([hwnd]);
      pid = pids[0] || 0;
    } catch (error) {
      console.error(error);
      return false;
    }
    if (!pid || pid === process.pid) return false;
    return startAudio(pid, event.sender);
  });

  ipcMain.handle('vdz-stop-audio', () => {
    stopAudio();
  });

  createHost();
});

app.on('before-quit', () => {
  stopAudio();
});

app.on('window-all-closed', () => {
  app.quit();
});
