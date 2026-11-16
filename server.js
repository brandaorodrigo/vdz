const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/stream', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'stream.html'));
});

app.get('/online', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'online.html'));
});

app.get('/play', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'play.html'));
});

app.get('/update', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'update.html'));
});

app.get('/ping', (_req, res) => {
    res.status(204).end();
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

const MAX_BROADCASTERS = 4;
const broadcasters = new Map();
const watchers = new Map();
const lobbies = new Set();
let nextId = 1;

function send(ws, msg) {
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify(msg));
    }
}

function readName(value) {
    return String(value ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 40);
}

function onlineList() {
    return [...broadcasters.entries()].map(([id, socket]) => ({ id, name: socket.name }));
}

function publishOnline() {
    const list = onlineList();
    for (const lobby of lobbies) {
        send(lobby, { list, type: 'online' });
    }
}

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
            return;
        }

        if (msg.type === 'broadcaster') {
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

        if (msg.type === 'stop' && ws.role === 'broadcaster') {
            endBroadcast(ws);
            ws.role = null;
            return;
        }

        if (msg.type === 'lobby') {
            if (ws.role) {
                return;
            }
            ws.role = 'lobby';
            lobbies.add(ws);
            send(ws, { list: onlineList(), type: 'online' });
            return;
        }

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
            send(broadcaster, { id, type: 'watcher' });
            return;
        }

        if (msg.type === 'offer' && ws.role === 'broadcaster') {
            send(watchers.get(msg.id), { id: ws.id, sdp: msg.sdp, type: 'offer' });
            return;
        }

        if (msg.type === 'answer' && ws.role === 'watcher') {
            if (msg.id !== ws.broadcasterId) {
                return;
            }
            send(broadcasters.get(ws.broadcasterId), { id: ws.id, sdp: msg.sdp, type: 'answer' });
            return;
        }

        if (msg.type === 'candidate') {
            if (ws.role === 'broadcaster') {
                send(watchers.get(msg.id), { candidate: msg.candidate, id: ws.id, type: 'candidate' });
            } else if (ws.role === 'watcher' && msg.id === ws.broadcasterId) {
                send(broadcasters.get(ws.broadcasterId), { candidate: msg.candidate, id: ws.id, type: 'candidate' });
            }
        }
    });

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

if (require.main === module) {
    listen(3000).then((port) => {
        console.log(`http://localhost:${port}`);
    });
}

module.exports = { close: () => server.close(), listen };
