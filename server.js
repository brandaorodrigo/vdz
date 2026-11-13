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

let broadcaster = null;
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
            const prev = broadcaster;
            broadcaster = ws;
            if (prev && prev !== ws) {
                prev.close();
            }
            for (const id of watchers.keys()) {
                send(ws, { id, type: 'watcher' });
            }
            return;
        }

        if (msg.type === 'stop' && ws === broadcaster) {
            broadcaster = null;
            for (const watcher of watchers.values()) {
                send(watcher, { type: 'stop' });
            }
            return;
        }

        if (msg.type === 'watcher') {
            const id = nextId++;
            ws.id = id;
            watchers.set(id, ws);
            send(broadcaster, { id, type: 'watcher' });
            return;
        }

        if (msg.type === 'offer') {
            send(watchers.get(msg.id), { sdp: msg.sdp, type: 'offer' });
            return;
        }

        if (msg.type === 'answer') {
            send(broadcaster, { id: ws.id, sdp: msg.sdp, type: 'answer' });
            return;
        }

        if (msg.type === 'candidate') {
            if (ws === broadcaster) {
                send(watchers.get(msg.id), { candidate: msg.candidate, type: 'candidate' });
            } else {
                send(broadcaster, { candidate: msg.candidate, id: ws.id, type: 'candidate' });
            }
        }
    });

    ws.on('close', () => {
        if (ws === broadcaster) {
            broadcaster = null;
            for (const watcher of watchers.values()) {
                send(watcher, { type: 'stop' });
            }
            return;
        }
        if (ws.id && watchers.delete(ws.id)) {
            send(broadcaster, { id: ws.id, type: 'watcher-gone' });
        }
    });
});

server.listen(3000, () => {
    console.log('http://localhost:3000');
});
