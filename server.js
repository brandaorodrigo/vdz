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

app.get('/play', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'play.html'));
});

app.get('/update', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'update.html'));
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

const MAX_BROADCASTERS = 4;
const broadcasters = new Map();
const watchers = new Map();
let nextId = 1;

function send(ws, msg) {
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify(msg));
    }
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
            if (broadcasters.size >= MAX_BROADCASTERS) {
                send(ws, { type: 'full' });
                return;
            }
            const id = nextId++;
            ws.role = 'broadcaster';
            ws.id = id;
            broadcasters.set(id, ws);
            for (const watcherId of watchers.keys()) {
                send(ws, { id: watcherId, type: 'watcher' });
            }
            return;
        }

        if (msg.type === 'stop' && ws.role === 'broadcaster') {
            broadcasters.delete(ws.id);
            ws.role = null;
            for (const watcher of watchers.values()) {
                send(watcher, { id: ws.id, type: 'stop' });
            }
            return;
        }

        if (msg.type === 'watcher') {
            if (ws.role) {
                return;
            }
            const id = nextId++;
            ws.role = 'watcher';
            ws.id = id;
            watchers.set(id, ws);
            for (const broadcaster of broadcasters.values()) {
                send(broadcaster, { id, type: 'watcher' });
            }
            return;
        }

        if (msg.type === 'offer' && ws.role === 'broadcaster') {
            send(watchers.get(msg.id), { id: ws.id, sdp: msg.sdp, type: 'offer' });
            return;
        }

        if (msg.type === 'answer' && ws.role === 'watcher') {
            send(broadcasters.get(msg.id), { id: ws.id, sdp: msg.sdp, type: 'answer' });
            return;
        }

        if (msg.type === 'candidate') {
            if (ws.role === 'broadcaster') {
                send(watchers.get(msg.id), { candidate: msg.candidate, id: ws.id, type: 'candidate' });
            } else if (ws.role === 'watcher') {
                send(broadcasters.get(msg.id), { candidate: msg.candidate, id: ws.id, type: 'candidate' });
            }
        }
    });

    ws.on('close', () => {
        if (ws.role === 'broadcaster' && broadcasters.delete(ws.id)) {
            for (const watcher of watchers.values()) {
                send(watcher, { id: ws.id, type: 'stop' });
            }
            return;
        }
        if (ws.role === 'watcher' && watchers.delete(ws.id)) {
            for (const broadcaster of broadcasters.values()) {
                send(broadcaster, { id: ws.id, type: 'watcher-gone' });
            }
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
