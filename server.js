// Servidor HTTP (páginas estáticas) e WebSocket (sinalização WebRTC).
// Não carrega o vídeo: só apresenta quem está ao vivo e troca as mensagens
// que o navegador precisa para abrir a conexão peer a peer.

const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
// O WebSocket compartilha a mesma porta do HTTP.
const wss = new WebSocketServer({ server });

// Cada rota entrega uma página da pasta public.
app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/stream', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'stream.html'));
});

app.get('/play', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'play.html'));
});

app.get('/update', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'update.html'));
});

// Resposta vazia usada só para medir se o servidor está no ar.
app.get('/ping', (_req, res) => {
    res.status(204).end();
});

// CSS, imagens e demais arquivos de public. index: false evita que
// um index.html solto substitua a rota "/" definida acima.
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// No máximo quatro transmissões ao mesmo tempo.
const MAX_BROADCASTERS = 4;
// id -> socket de quem está transmitindo.
const broadcasters = new Map();
// id -> socket de quem está assistindo uma transmissão.
const watchers = new Map();
// sockets da página que só lista quem está online.
const lobbies = new Set();
// Próximo id livre, compartilhado por transmissores e espectadores.
let nextId = 1;

// Envia um objeto JSON se o socket ainda estiver aberto (readyState 1).
function send(ws, msg) {
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify(msg));
    }
}

// Normaliza o nome exibido: uma linha, sem espaços repetidos, até 40 caracteres.
function readName(value) {
    return String(value ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 40);
}

// Lista atual de transmissões: id e nome de cada broadcaster.
function onlineList() {
    return [...broadcasters.entries()].map(([id, socket]) => ({ id, name: socket.name }));
}

// Avisa todas as páginas de lobby que a lista de online mudou.
function publishOnline() {
    const list = onlineList();
    for (const lobby of lobbies) {
        send(lobby, { list, type: 'online' });
    }
}

// Tira o transmissor do ar e avisa os espectadores ligados a ele.
function endBroadcast(ws) {
    if (!broadcasters.delete(ws.id)) {
        return;
    }
    for (const watcher of watchers.values()) {
        if (watcher.broadcasterId === ws.id) {
            send(watcher, { id: ws.id, type: 'stop' });
        }
    }
    publishOnline();
}

wss.on('connection', (ws) => {
    ws.on('message', (data) => {
        let msg;
        try {
            msg = JSON.parse(data.toString());
        } catch {
            // Mensagem que não é JSON é ignorada.
            return;
        }

        // Alguém quer começar a transmitir.
        if (msg.type === 'broadcaster') {
            // Cada socket assume um papel uma única vez.
            if (ws.role) {
                return;
            }
            const name = readName(msg.name);
            if (!name) {
                send(ws, { type: 'need-name' });
                return;
            }
            if (broadcasters.size >= MAX_BROADCASTERS) {
                send(ws, { type: 'full' });
                return;
            }
            const id = nextId++;
            ws.role = 'broadcaster';
            ws.id = id;
            ws.name = name;
            broadcasters.set(id, ws);
            publishOnline();
            return;
        }

        // O transmissor encerrou a live de propósito.
        if (msg.type === 'stop' && ws.role === 'broadcaster') {
            endBroadcast(ws);
            ws.role = null;
            return;
        }

        // Página que só quer a lista de quem está transmitindo.
        if (msg.type === 'lobby') {
            if (ws.role) {
                return;
            }
            ws.role = 'lobby';
            lobbies.add(ws);
            send(ws, { list: onlineList(), type: 'online' });
            return;
        }

        // Espectador escolheu uma transmissão para assistir.
        if (msg.type === 'watcher') {
            if (ws.role) {
                return;
            }
            const broadcaster = broadcasters.get(Number(msg.id));
            if (!broadcaster) {
                send(ws, { type: 'gone' });
                return;
            }
            const id = nextId++;
            ws.role = 'watcher';
            ws.id = id;
            ws.broadcasterId = broadcaster.id;
            watchers.set(id, ws);
            // Pede ao transmissor que abra uma oferta WebRTC para este espectador.
            send(broadcaster, { id, type: 'watcher' });
            return;
        }

        // Oferta SDP do transmissor, encaminhada ao espectador certo.
        if (msg.type === 'offer' && ws.role === 'broadcaster') {
            send(watchers.get(msg.id), { id: ws.id, sdp: msg.sdp, type: 'offer' });
            return;
        }

        // Resposta SDP do espectador, só aceita se for para a transmissão que ele escolheu.
        if (msg.type === 'answer' && ws.role === 'watcher') {
            if (msg.id !== ws.broadcasterId) {
                return;
            }
            send(broadcasters.get(ws.broadcasterId), { id: ws.id, sdp: msg.sdp, type: 'answer' });
            return;
        }

        // Candidato ICE, nos dois sentidos, para completar a conexão peer a peer.
        if (msg.type === 'candidate') {
            if (ws.role === 'broadcaster') {
                send(watchers.get(msg.id), { candidate: msg.candidate, id: ws.id, type: 'candidate' });
            } else if (ws.role === 'watcher' && msg.id === ws.broadcasterId) {
                send(broadcasters.get(ws.broadcasterId), { candidate: msg.candidate, id: ws.id, type: 'candidate' });
            }
        }
    });

    // Limpa o papel deste socket quando a conexão cai.
    ws.on('close', () => {
        if (ws.role === 'broadcaster') {
            endBroadcast(ws);
            return;
        }
        if (ws.role === 'lobby') {
            lobbies.delete(ws);
            return;
        }
        if (ws.role === 'watcher' && watchers.delete(ws.id)) {
            send(broadcasters.get(ws.broadcasterId), { id: ws.id, type: 'watcher-gone' });
        }
    });
});

// Sobe o servidor na porta pedida. Se já estiver ouvindo, devolve a porta atual.
function listen(port = 3000) {
    if (server.listening) {
        return Promise.resolve(server.address().port);
    }
    return new Promise((resolve, reject) => {
        const onError = (err) => {
            server.off('error', onError);
            reject(err);
        };
        server.once('error', onError);
        server.listen(port, () => {
            server.off('error', onError);
            resolve(server.address().port);
        });
    });
}

// Só escuta ao rodar este arquivo direto (node server.js). Em teste, quem importa chama listen().
if (require.main === module) {
    listen(3000).then((port) => {
        console.log(`http://localhost:${port}`);
    });
}

module.exports = { close: () => server.close(), listen };
