'use strict';

// Estado só na memória. Se o processo reinicia, as salas somem.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const MAX_MESSAGE = 64 * 1024;
const PUBLIC_DIR = path.join(__dirname, 'public');

const FILES = new Map([
  ['/', 'index.html'],
  ['/watch', 'rooms.html'],
  ['/host', 'host.html'],
  ['/host.js', 'host.js'],
  ['/watch.js', 'watch.js'],
  ['/loopback-worklet.js', 'loopback-worklet.js'],
  ['/style.css', 'style.css'],
  ['/1', 'mosaic.html'],
  ['/2', 'mosaic.html'],
  ['/3', 'mosaic.html'],
  ['/4', 'mosaic.html']
]);

const ASSETS = new Map([
  ['/favicon.ico', 'favicon.ico'],
  ['/favicon-16x16.png', 'favicon-16x16.png'],
  ['/favicon-32x32.png', 'favicon-32x32.png'],
  ['/apple-touch-icon.png', 'apple-touch-icon.png'],
  ['/android-chrome-192x192.png', 'android-chrome-192x192.png'],
  ['/android-chrome-512x512.png', 'android-chrome-512x512.png'],
  ['/site.webmanifest', 'site.webmanifest']
]);

const TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.webmanifest', 'application/manifest+json']
]);

const SETUP_FILE = path.join(PUBLIC_DIR, 'vdz_1.1.0.exe');
const rooms = new Map();
const waiting = new Map();
const clients = new Map();

function send(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // O close seguinte tira o socket da sala.
  }
}

function newId() {
  return crypto.randomBytes(9).toString('base64url');
}

function roomName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().toLowerCase();
  if (!/^[a-z]{1,32}$/.test(name) || name === 'host' || name === 'watch') return null;
  return name;
}

function parseMessage(data, isBinary) {
  if (isBinary) return null;
  const text = typeof data === 'string' ? data : data.toString('utf8');
  if (text.length > MAX_MESSAGE) return null;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  if (typeof msg.type !== 'string') return null;
  return msg;
}

function cleanSignal(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (data.kind === 'offer' || data.kind === 'answer') {
    if (typeof data.sdp !== 'string') return null;
    return { kind: data.kind, sdp: data.sdp };
  }
  if (data.kind === 'ice') {
    if (!Object.prototype.hasOwnProperty.call(data, 'candidate')) return null;
    const candidate = data.candidate;
    if (candidate !== null && (typeof candidate !== 'object' || Array.isArray(candidate))) return null;
    return { kind: 'ice', candidate };
  }
  return null;
}

function targetOf(room, meta, to) {
  if (meta.role === 'host') return room.viewers.get(to) || null;
  if (meta.role === 'viewer' && to === room.hostId) return room.hostWs;
  return null;
}

function handleCreate(ws, meta, msg) {
  if (meta.role === 'host' && meta.roomId && rooms.has(meta.roomId)) return;
  if (meta.role) return;
  const id = roomName(msg.roomId);
  if (!id) {
    const raw = typeof msg.roomId === 'string' ? msg.roomId.trim().toLowerCase() : '';
    const message = raw === 'host' || raw === 'watch'
      ? 'Esse nome não pode ser usado'
      : 'Use só letras, sem números, sem espaços e nem símbolos';
    send(ws, { type: 'error', message });
    return;
  }
  if (rooms.has(id)) {
    send(ws, { type: 'error', message: 'Essa sala já está em uso' });
    return;
  }
  rooms.set(id, {
    id,
    hostId: meta.id,
    hostWs: ws,
    viewers: new Map()
  });
  meta.role = 'host';
  meta.roomId = id;
  send(ws, { type: 'created', roomId: id });
  admitWaiters(rooms.get(id));
}

function waitingBucket(id) {
  let bucket = waiting.get(id);
  if (!bucket) {
    bucket = new Map();
    waiting.set(id, bucket);
  }
  return bucket;
}

function parkViewer(ws, meta, id) {
  meta.role = 'waiter';
  meta.roomId = id;
  waitingBucket(id).set(meta.id, ws);
  send(ws, { type: 'waiting', roomId: id });
}

function dropWaiter(ws, meta) {
  if (!meta.roomId) return;
  const bucket = waiting.get(meta.roomId);
  if (!bucket) return;
  if (bucket.get(meta.id) === ws) bucket.delete(meta.id);
  if (bucket.size === 0) waiting.delete(meta.roomId);
}

function admitWaiters(room) {
  const bucket = waiting.get(room.id);
  if (!bucket) return;
  waiting.delete(room.id);
  for (const [viewerId, viewerWs] of bucket) {
    const viewer = clients.get(viewerWs);
    if (!viewer || viewerWs.readyState !== WebSocket.OPEN) continue;
    room.viewers.set(viewerId, viewerWs);
    viewer.role = 'viewer';
    viewer.roomId = room.id;
    send(viewerWs, { type: 'joined', roomId: room.id });
    send(room.hostWs, { type: 'viewer-joined', viewerId });
  }
}

function handleJoin(ws, meta, msg) {
  if (meta.role) return;
  const id = roomName(msg.roomId);
  if (!id) {
    send(ws, { type: 'waiting' });
    return;
  }
  const room = rooms.get(id);
  if (!room) {
    parkViewer(ws, meta, id);
    return;
  }
  room.viewers.set(meta.id, ws);
  meta.role = 'viewer';
  meta.roomId = room.id;
  send(ws, { type: 'joined', roomId: room.id });
  send(room.hostWs, { type: 'viewer-joined', viewerId: meta.id });
}

function handleSignal(meta, msg) {
  if (!meta.role || !meta.roomId) return;
  if (typeof msg.to !== 'string' || msg.to.length === 0) return;
  const room = rooms.get(meta.roomId);
  if (!room) return;
  const data = cleanSignal(msg.data);
  if (!data) return;
  if (data.kind === 'offer' && meta.role !== 'host') return;
  if (data.kind === 'answer' && (meta.role !== 'viewer' || msg.to !== room.hostId)) return;
  const dest = targetOf(room, meta, msg.to);
  if (!dest) return;
  send(dest, { type: 'signal', from: meta.id, data });
}

function removeClient(ws) {
  const meta = clients.get(ws);
  if (!meta) return;
  clients.delete(ws);
  if (meta.role === 'waiter') {
    dropWaiter(ws, meta);
    return;
  }
  if (!meta.roomId) return;
  const room = rooms.get(meta.roomId);
  if (!room) return;

  if (meta.role === 'host' && room.hostWs === ws) {
    const parked = [...room.viewers.entries()];
    rooms.delete(room.id);
    for (const [viewerId, viewerWs] of parked) {
      const viewer = clients.get(viewerWs);
      if (!viewer || viewerWs.readyState !== WebSocket.OPEN) continue;
      parkViewer(viewerWs, viewer, room.id);
    }
    return;
  }

  if (meta.role === 'viewer' && room.viewers.get(meta.id) === ws) {
    room.viewers.delete(meta.id);
    send(room.hostWs, { type: 'viewer-left', viewerId: meta.id });
  }
}

function serve(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://127.0.0.1');
  const assetName = ASSETS.get(url.pathname);
  if (assetName) {
    const fullPath = path.join(PUBLIC_DIR, assetName);
    fs.readFile(fullPath, (error, body) => {
      if (error) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(req.method === 'HEAD' ? undefined : 'not found');
        return;
      }
      const type = TYPES.get(path.extname(assetName)) || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': type,
        'Cache-Control': 'public, max-age=86400'
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    });
    return;
  }
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : 'ok');
    return;
  }
  if (url.pathname === '/api/rooms') {
    const names = [...rooms.keys()].sort();
    const body = JSON.stringify({ rooms: names });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return;
  }
  if (url.pathname === '/vdz_1.1.0.exe') {
    fs.stat(SETUP_FILE, (error, stat) => {
      if (error || !stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(req.method === 'HEAD' ? undefined : 'not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
        'Content-Disposition': 'attachment; filename="vdz_1.1.0.exe"',
        'Cache-Control': 'no-cache'
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const stream = fs.createReadStream(SETUP_FILE);
      stream.on('error', () => {
        res.destroy();
      });
      stream.pipe(res);
    });
    return;
  }

  let fileName = FILES.get(url.pathname);
  if (!fileName && /^\/[a-z]{1,32}$/.test(url.pathname)) fileName = 'watch.html';
  if (!fileName) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(req.method === 'HEAD' ? undefined : 'not found');
    return;
  }

  const fullPath = path.join(PUBLIC_DIR, fileName);
  fs.readFile(fullPath, (error, body) => {
    if (error) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(req.method === 'HEAD' ? undefined : 'not found');
      return;
    }
    const type = TYPES.get(path.extname(fileName)) || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
}

const server = http.createServer(serve);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MESSAGE });

wss.on('connection', (ws) => {
  const meta = { id: newId(), role: null, roomId: null };
  clients.set(ws, meta);

  ws.on('message', (data, isBinary) => {
    const msg = parseMessage(data, isBinary);
    if (!msg) return;
    if (msg.type === 'ping') {
      send(ws, { type: 'pong' });
      return;
    }
    if (msg.type === 'create') {
      handleCreate(ws, meta, msg);
      return;
    }
    if (msg.type === 'join') {
      handleJoin(ws, meta, msg);
      return;
    }
    if (msg.type === 'signal') {
      handleSignal(meta, msg);
    }
  });

  ws.on('error', () => {
    // O evento close limpa a sala.
  });
  ws.on('close', () => removeClient(ws));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('listening on ' + PORT);
});
