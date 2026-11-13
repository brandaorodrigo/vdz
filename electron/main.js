const http = require('node:http');
const path = require('node:path');
const { app, BrowserWindow, desktopCapturer, ipcMain, Menu, session } = require('electron');
const { close, listen } = require('../server');

let audio = null;
try {
    audio = require('electron-native-screenshare');
} catch (err) {
    console.error(err);
}

let win = null;
let ownsServer = false;
let pendingVideo = null;
let activeSource = null;
let generation = 0;

function hwndOf(id) {
    return Number(String(id).split(':')[1]);
}

function pidOf(id) {
    if (!audio?.getPidFromWindowHandle) {
        return 0;
    }
    const hwnd = hwndOf(id);
    if (!hwnd) {
        return 0;
    }
    try {
        return audio.getPidFromWindowHandle(hwnd) || 0;
    } catch {
        return 0;
    }
}

function samplesFrom(data, meta) {
    const bytes = Buffer.from(data);
    if (meta?.isFloat && meta.bitsPerSample === 32) {
        const copy = new Float32Array(bytes.byteLength / 4);
        copy.set(new Float32Array(bytes.buffer, bytes.byteOffset, copy.length));
        return copy;
    }
    if (meta?.bitsPerSample === 16) {
        const view = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
        const copy = new Float32Array(view.length);
        for (let i = 0; i < view.length; i++) {
            copy[i] = view[i] / 32768;
        }
        return copy;
    }
    return new Float32Array();
}

function stopAudio() {
    generation += 1;
    try {
        audio?.stopCapture();
    } catch (err) {
        console.error(err);
    }
}

function serverUp(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${port}/stream`, (res) => {
            res.resume();
            resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.setTimeout(400, () => {
            req.destroy();
            resolve(false);
        });
    });
}

async function port() {
    if (await serverUp(3000)) {
        return 3000;
    }
    ownsServer = true;
    return listen(3000);
}

function sendChunk(gen, data, meta) {
    if (gen !== generation || !win || win.isDestroyed()) {
        return;
    }
    const samples = samplesFrom(data, meta);
    if (!samples.length) {
        return;
    }
    win.webContents.send('audio-chunk', { channels: meta?.channels || 2, samples });
}

ipcMain.handle('windows', async () => {
    const sources = await desktopCapturer.getSources({ thumbnailSize: { height: 0, width: 0 }, types: ['window'] });
    const list = [];
    for (const source of sources) {
        if (!source.name || pidOf(source.id) === process.pid) {
            continue;
        }
        list.push({ id: source.id, name: source.name });
    }
    return list;
});

ipcMain.handle('choose', async (_event, id) => {
    const sources = await desktopCapturer.getSources({ thumbnailSize: { height: 0, width: 0 }, types: ['window'] });
    const source = sources.find((item) => item.id === id);
    if (!source) {
        pendingVideo = null;
        return false;
    }
    pendingVideo = source;
    activeSource = source;
    return true;
});

ipcMain.handle('start-audio', () => {
    if (!audio?.startCapture || !activeSource) {
        return null;
    }
    const pid = pidOf(activeSource.id);
    if (!pid) {
        return null;
    }
    stopAudio();
    const gen = generation;
    return new Promise((resolve) => {
        let settled = false;
        const finish = (meta) => {
            if (settled) {
                return;
            }
            settled = true;
            resolve({ channels: meta?.channels || 2, sampleRate: meta?.sampleRate || 48000 });
        };
        try {
            const ok = audio.startCapture(pid, true, (data, meta) => {
                finish(meta);
                sendChunk(gen, data, meta);
            });
            if (!ok) {
                settled = true;
                resolve(null);
                return;
            }
        } catch (err) {
            console.error(err);
            settled = true;
            resolve(null);
            return;
        }
        setTimeout(() => finish(null), 800);
    });
});

ipcMain.handle('stop-audio', () => {
    stopAudio();
});

function open() {
    win = new BrowserWindow({
        autoHideMenuBar: true,
        backgroundColor: '#ffffff',
        height: 180,
        show: false,
        title: 'stream',
        webPreferences: {
            backgroundThrottling: false,
            contextIsolation: true,
            nodeIntegration: false,
            preload: path.join(__dirname, 'preload.js'),
            sandbox: true,
        },
        width: 520,
    });
    win.once('ready-to-show', () => win.show());
    return port().then((number) => win.loadURL(`http://127.0.0.1:${number}/stream`));
}

app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
        const source = pendingVideo;
        pendingVideo = null;
        if (!request.videoRequested || !source) {
            callback({});
            return;
        }
        callback({ video: source });
    });
    return open();
});

app.on('before-quit', () => {
    stopAudio();
    if (ownsServer) {
        close();
    }
});

app.on('window-all-closed', () => {
    app.quit();
});
