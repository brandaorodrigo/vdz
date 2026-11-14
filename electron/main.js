const { spawn } = require('node:child_process');
const path = require('node:path');
const { app, BrowserWindow, desktopCapturer, ipcMain, Menu, session } = require('electron');

app.commandLine.appendSwitch('lang', 'pt-BR');

let win = null;
let pendingVideo = null;
let activeSource = null;
let capture = null;
let generation = 0;

function audioExe() {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, 'win-audio.exe');
    }
    return path.join(__dirname, 'win-audio.exe');
}

function hwndOf(id) {
    return Number(String(id).split(':')[1]);
}

function pidsFor(hwnds) {
    return new Promise((resolve) => {
        if (!hwnds.length) {
            resolve(new Map());
            return;
        }
        const child = spawn(audioExe(), ['--pid', ...hwnds.map(String)], { windowsHide: true });
        let out = '';
        let finished = false;
        const done = () => {
            if (finished) {
                return;
            }
            finished = true;
            const map = new Map();
            for (const line of out.split(/\r?\n/)) {
                const [hwnd, pid] = line.trim().split(' ');
                if (hwnd && pid) {
                    map.set(Number(hwnd), Number(pid));
                }
            }
            resolve(map);
        };
        child.stdout.on('data', (chunk) => {
            out += chunk.toString();
        });
        child.on('error', done);
        child.on('close', done);
    });
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
    if (!capture) {
        return;
    }
    const child = capture;
    capture = null;
    child.kill();
}

const streamUrl = `https://vdz.onrender.com/stream?version=${app.getVersion()}`;

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
    const pids = await pidsFor(sources.map((source) => hwndOf(source.id)).filter(Boolean));
    const list = [];
    for (const source of sources) {
        const pid = pids.get(hwndOf(source.id));
        if (!source.name || pid === process.pid) {
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
    const hwnd = activeSource ? hwndOf(activeSource.id) : 0;
    if (!hwnd) {
        return null;
    }
    stopAudio();
    const gen = generation;
    const child = spawn(audioExe(), [String(hwnd)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    capture = child;
    return new Promise((resolve) => {
        let settled = false;
        let meta = null;
        let buf = Buffer.alloc(0);
        const finish = (value) => {
            if (settled) {
                return;
            }
            settled = true;
            resolve(value);
        };
        child.stdout.on('data', (chunk) => {
            if (gen !== generation) {
                return;
            }
            buf = Buffer.concat([buf, chunk]);
            if (!meta) {
                if (buf.length < 8) {
                    return;
                }
                meta = { bitsPerSample: buf.readUInt16LE(6), channels: buf.readUInt16LE(4), isFloat: false, sampleRate: buf.readUInt32LE(0) };
                buf = buf.subarray(8);
                finish({ channels: meta.channels || 2, sampleRate: meta.sampleRate || 48000 });
            }
            const frame = Math.max(1, (meta.bitsPerSample / 8) * meta.channels);
            const usable = buf.length - (buf.length % frame);
            if (!usable) {
                return;
            }
            sendChunk(gen, buf.subarray(0, usable), meta);
            buf = buf.subarray(usable);
        });
        child.stderr.on('data', (chunk) => console.error(chunk.toString()));
        child.on('error', (err) => {
            console.error(err);
            finish(null);
        });
        child.on('close', () => finish(null));
        setTimeout(() => finish(null), 2500);
    });
});

ipcMain.handle('stop-audio', () => {
    stopAudio();
});

function open() {
    win = new BrowserWindow({
        autoHideMenuBar: true,
        backgroundColor: '#000000',
        fullscreenable: false,
        height: 520,
        icon: path.join(__dirname, '..', 'public', 'android-chrome-512x512.png'),
        maximizable: false,
        resizable: false,
        show: false,
        title: 'stream',
        webPreferences: {
            backgroundThrottling: false,
            contextIsolation: true,
            nodeIntegration: false,
            preload: path.join(__dirname, 'preload.js'),
            sandbox: true,
        },
        width: 340,
    });
    win.once('ready-to-show', () => win.show());
    return win.loadURL(streamUrl);
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
});

app.on('window-all-closed', () => {
    app.quit();
});
