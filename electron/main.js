const { spawn } = require('node:child_process');
const path = require('node:path');
const { app, BrowserWindow, desktopCapturer, ipcMain, Menu, session } = require('electron');

// Processo principal do Electron.
// Abre a janela do stream, lista janelas do Windows e captura o áudio
// da janela escolhida via o executável nativo win-audio.exe.
// A página só fala com este processo pelos canais expostos em preload.js.

// Força a interface do Chromium (diálogos, getDisplayMedia) em português.
app.commandLine.appendSwitch('lang', 'pt-BR');

let win = null;
// Fonte de vídeo reservada para o próximo getDisplayMedia da página.
// Consumida uma vez pelo setDisplayMediaRequestHandler.
let pendingVideo = null;
// Janela escolhida cuja áudio será capturado. Independente de pendingVideo,
// que é zerado assim que o vídeo é entregue.
let activeSource = null;
// Processo filho atual do win-audio.exe, ou null se não há captura.
let capture = null;
// Identifica a captura em curso. Sobe a cada stopAudio para que trechos
// atrasados do processo antigo sejam descartados.
let generation = 0;

// Caminho do capturador nativo. No app empacotado ele vai em resources;
// em desenvolvimento fica ao lado deste arquivo.
function audioExe() {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, 'win-audio.exe');
    }
    return path.join(__dirname, 'win-audio.exe');
}

// O id do desktopCapturer tem a forma "window:<hwnd>:<outro>".
// Devolve o HWND numérico usado pelo win-audio.exe.
function hwndOf(id) {
    return Number(String(id).split(':')[1]);
}

// Pergunta ao win-audio.exe o PID de cada HWND (`--pid <hwnd> ...`).
// A saída é uma linha "hwnd pid" por janela. Serve para esconder a
// própria janela do app na lista de fontes.
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
        // Erro de spawn e encerramento normal resolvem do mesmo jeito:
        // com o que já foi lido, ou com um mapa vazio.
        child.on('error', done);
        child.on('close', done);
    });
}

// Converte o PCM cru do win-audio.exe em Float32 no intervalo [-1, 1],
// o formato que a página espera em 'audio-chunk'.
// Float32 é copiado; Int16 é normalizado por 32768. Outros formatos viram vazio.
function samplesFrom(data, meta) {
    const bytes = Buffer.from(data);
    if (meta?.isFloat && meta.bitsPerSample === 32) {
        const copy = new Float32Array(bytes.byteLength / 4);
        // Copia para um ArrayBuffer novo: o Buffer do Node pode ser uma
        // visão sobre um pool compartilhado e não pode ir direto ao renderer.
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

// Invalida a captura atual e mata o processo filho, se houver.
// O incremento de generation acontece mesmo sem processo, para que um
// start-audio concorrente também seja ignorado.
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

// Encaminha um trecho à página só se ainda for da captura vigente
// e a janela continuar aberta.
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

// Lista as janelas capturáveis como { id, name }.
// Descarta fontes sem nome e a janela deste próprio processo.
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

// Guarda a janela escolhida. pendingVideo alimenta o próximo getDisplayMedia;
// activeSource permanece para o start-audio, que pode ocorrer depois.
// Retorna false se o id não existir mais.
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

// Inicia a captura do áudio da janela em activeSource.
// O win-audio.exe escreve no stdout um cabeçalho de 8 bytes
// (sampleRate u32, channels u16, bitsPerSample u16, little-endian)
// e em seguida o PCM contínuo.
// Resolve com { channels, sampleRate } ao ler o cabeçalho, ou null
// se não houver HWND, o processo falhar, ou o cabeçalho não chegar em 2,5 s.
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
            // Só encaminha frames inteiros (amostra × canais). O resto fica no buffer.
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

// Encerra a captura. O processo filho recebe kill em stopAudio.
ipcMain.handle('stop-audio', () => {
    stopAudio();
});

// Janela fixa, sem menu e sem throttle em segundo plano, para o áudio
// e o vídeo do stream não pausarem quando a janela perde o foco.
// Fica oculta até o primeiro paint para não piscar fundo branco.
function open() {
    win = new BrowserWindow({
        autoHideMenuBar: true,
        backgroundColor: '#000000',
        fullscreenable: false,
        height: 700,
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
        width: 400,
    });
    win.once('ready-to-show', () => win.show());
    return win.loadURL(streamUrl);
}

app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    // getDisplayMedia da página não abre o seletor do sistema:
    // devolve a fonte guardada por 'choose' e a consome na hora.
    // Sem vídeo pedido ou sem fonte pendente, recusa o pedido.
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

// Não há janela secundária; fechar a única encerra o processo.
app.on('window-all-closed', () => {
    app.quit();
});
