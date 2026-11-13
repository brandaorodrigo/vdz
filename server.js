const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

// TURN (opcional): defina no ambiente antes de `npm start`
// TURN_URLS=turn:global.relay.metered.ca:80,turns:global.relay.metered.ca:443?transport=tcp
// TURN_USERNAME=...
// TURN_CREDENTIAL=...

const STUN_URLS = [
    'stun:stun.l.google.com:19302',
    'stun:stun1.l.google.com:19302',
    'stun:stun2.l.google.com:19302',
    'stun:stun3.l.google.com:19302',
    'stun:stun4.l.google.com:19302',
    'stun:stun.services.mozilla.com',
    'stun:stun.stunprotocol.org:3478',
];

function iceServersForClient() {
    const iceServers = [{ urls: STUN_URLS }];
    const turnUrls = process.env.TURN_URLS;
    const username = process.env.TURN_USERNAME;
    const credential = process.env.TURN_CREDENTIAL;
    if (turnUrls && username && credential) {
        iceServers.push({
            credential,
            urls: turnUrls.split(',').map((s) => s.trim()).filter(Boolean),
            username,
        });
    }
    return { iceServers };
}

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

app.get('/rtc-ice.js', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'rtc-ice.js'));
});

app.get('/api/ice', (_req, res) => {
    res.json(iceServersForClient());
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
