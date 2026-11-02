'use strict';

const ICE_SERVERS = [{
  urls: [
    'stun:stun.l.google.com:19302',
    'stun:stun1.l.google.com:19302',
    'stun:stun.cloudflare.com:3478'
  ]
}];
const PING_MS = 4 * 60 * 1000;

const statusEl = document.getElementById('status');
const unmuteBtn = document.getElementById('unmute');
const volumeInput = document.getElementById('volume');
const leaveBtn = document.getElementById('leave');
const soundIcon = unmuteBtn.querySelector('.icon');
const video = document.getElementById('remote');
video.addEventListener('playing', notePlayback);
video.addEventListener('timeupdate', notePlayback);
video.addEventListener('resize', () => {
  ensurePlaying();
  notePlayback();
});
video.addEventListener('canplay', ensurePlaying);
video.addEventListener('loadeddata', ensurePlaying);
const viewerCountEl = document.getElementById('viewer-count');
const VOLUME_START = 50;

let ws = null;
let pc = null;
let hostId = null;
let iceQueue = [];
let remoteReady = false;
let offerEpoch = 0;
let holdLocalIce = () => {};
let releaseLocalIce = () => {};
let generation = 0;
let chain = Promise.resolve();
let reconnectTimer = null;
let reconnectAttempt = 0;
let pingTimer = null;
let mediaTimer = null;
let recoveries = 0;
let playNudges = 0;
let hearing = false;
let volumeLevel = VOLUME_START;
let soundMuted = false;

function setStatus(text) {
  statusEl.hidden = text === 'No ar';
}

function notePlayback() {
  if (!video.srcObject || video.paused || video.videoWidth <= 0) return;
  recoveries = 0;
  playNudges = 0;
  clearMediaTimer();
  setStatus('No ar');
}

function clearMediaTimer() {
  if (!mediaTimer) return;
  clearTimeout(mediaTimer);
  mediaTimer = null;
}

function armReconnect(extended) {
  clearMediaTimer();
  const gen = generation;
  mediaTimer = setTimeout(() => {
    mediaTimer = null;
    reconnectIfStuck(gen, Boolean(extended));
  }, extended ? 8000 : 12000);
}

function reconnectIfStuck(gen, extended) {
  if (gen !== generation) return;
  if (document.hidden) {
    armReconnect(true);
    return;
  }
  if (video.srcObject && !video.paused && video.videoWidth > 0) {
    notePlayback();
    return;
  }
  const ice = pc && pc.iceConnectionState;
  if (ice === 'connected' || ice === 'completed') {
    ensurePlaying();
    if (!video.paused && video.videoWidth > 0) return;
    if (!video.paused && video.videoWidth <= 0 && playNudges >= 3 && recoveries < 5) {
      recoveries += 1;
      playNudges = 0;
      if (ws && ws.readyState === WebSocket.OPEN) ws.close();
      return;
    }
    if (playNudges >= 4) return;
    playNudges += 1;
    armReconnect(true);
    return;
  }
  if (!extended && (ice === 'checking' || ice === 'disconnected')) {
    armReconnect(true);
    return;
  }
  if (recoveries >= 5) return;
  recoveries += 1;
  if (ws && ws.readyState === WebSocket.OPEN) ws.close();
}

function setViewerCount(count) {
  if (!Number.isInteger(count) || count < 1) {
    viewerCountEl.hidden = true;
    viewerCountEl.textContent = '';
    viewerCountEl.removeAttribute('aria-label');
    return;
  }
  viewerCountEl.hidden = false;
  viewerCountEl.textContent = String(count);
  const people = count === 1 ? '1 pessoa assistindo' : count + ' pessoas assistindo';
  viewerCountEl.setAttribute('aria-label', people);
}

function soundGlyph(muted) {
  return muted ? 'volume_off' : 'volume_up';
}

function renderSound() {
  const silent = soundMuted || volumeLevel === 0;
  video.volume = volumeLevel / 100;
  video.muted = silent;
  volumeInput.value = String(volumeLevel);
  volumeInput.style.setProperty('--volume', volumeLevel + '%');
  soundIcon.textContent = soundGlyph(silent);
  const soundLabel = silent ? 'Desmutar' : 'Mutar';
  unmuteBtn.setAttribute('aria-label', soundLabel);
  unmuteBtn.dataset.tooltip = soundLabel;
}

function setVolume(level) {
  volumeLevel = Math.min(100, Math.max(0, Math.round(level)));
  soundMuted = volumeLevel === 0;
  renderSound();
  if (!video.muted) video.play().catch(() => {});
}

function playMuted(gen) {
  if (gen !== generation || !video.srcObject) return Promise.resolve();
  soundMuted = true;
  renderSound();
  const ensure = () => {
    if (gen !== generation || !video.srcObject || !video.paused) return;
    video.muted = true;
    video.play().catch(() => {});
  };
  const started = video.play();
  if (started) started.then(ensure).catch(ensure);
  window.setTimeout(ensure, 500);
  return started || Promise.resolve();
}

function ensurePlaying() {
  const gen = generation;
  if (gen !== generation || !video.srcObject) return;
  if (hearing) {
    if (video.paused) playMuted(gen);
    else notePlayback();
    return;
  }
  if (!video.paused && video.readyState >= 2) {
    notePlayback();
    trySound(gen);
    return;
  }
  video.muted = true;
  const started = video.play();
  if (!started) return;
  started.then(() => {
    if (gen !== generation || !video.srcObject) return;
    notePlayback();
    if (hearing || video.paused) return;
    trySound(gen);
  }).catch(() => {
    if (gen === generation) playMuted(gen);
  });
}

function trySound(gen) {
  if (gen !== generation || !video.srcObject || hearing) return;
  hearing = true;
  let settled = false;
  const finish = () => {
    if (settled) return false;
    settled = true;
    video.removeEventListener('pause', onPause);
    return true;
  };
  const onPause = () => {
    if (!finish() || gen !== generation || !video.srcObject) return;
    playMuted(gen);
  };
  video.addEventListener('pause', onPause);
  soundMuted = false;
  renderSound();
  return video.play().then(() => {
    if (gen !== generation || !video.srcObject) {
      finish();
      return;
    }
    if (video.paused || video.muted) {
      if (finish()) playMuted(gen);
      return;
    }
    window.setTimeout(() => {
      if (gen !== generation) {
        finish();
        return;
      }
      if (video.paused) {
        if (finish()) playMuted(gen);
        return;
      }
      finish();
    }, 400);
  }).catch(() => {
    if (finish()) playMuted(gen);
  });
}

function roomIdFromPath() {
  const match = location.pathname.match(/^\/([a-z]{1,32})$/);
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return '';
  }
}

const roomId = roomIdFromPath();

function wsUrl() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return protocol + '//' + location.host + '/ws';
}

function send(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function startPing() {
  stopPing();
  pingTimer = setInterval(() => {
    send({ type: 'ping' });
  }, PING_MS);
}

function stopPing() {
  if (!pingTimer) return;
  clearInterval(pingTimer);
  pingTimer = null;
}

function later(fn) {
  const gen = generation;
  chain = chain.then(() => {
    if (gen !== generation) return;
    return fn();
  }).catch((error) => {
    console.error(error);
  });
}

function closePc() {
  generation += 1;
  offerEpoch += 1;
  iceQueue = [];
  remoteReady = false;
  hearing = false;
  clearMediaTimer();
  holdLocalIce = () => {};
  releaseLocalIce = () => {};
  hostId = null;
  if (pc) {
    pc.onicecandidate = null;
    pc.ontrack = null;
    try {
      pc.close();
    } catch {
      // A conexão já estava encerrada.
    }
    pc = null;
  }
  video.srcObject = null;
  volumeLevel = VOLUME_START;
  soundMuted = false;
  renderSound();
}

function createPc() {
  const gen = generation;
  const localIce = [];
  let iceOpen = false;
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  holdLocalIce = () => {
    if (gen !== generation) return;
    iceOpen = false;
    localIce.splice(0);
  };

  releaseLocalIce = () => {
    if (gen !== generation) return;
    iceOpen = true;
    for (const data of localIce.splice(0)) {
      if (hostId) send({ type: 'signal', to: hostId, data });
    }
  };

  pc.onicecandidate = (event) => {
    if (gen !== generation) return;
    const data = { kind: 'ice', candidate: event.candidate };
    if (!iceOpen || !hostId) {
      localIce.push(data);
      return;
    }
    send({ type: 'signal', to: hostId, data });
  };

  pc.ontrack = (event) => {
    if (gen !== generation) return;
    const remote = event.streams[0];
    if (remote) {
      if (video.srcObject !== remote) {
        video.muted = true;
        video.srcObject = remote;
      }
    } else if (!video.srcObject) {
      video.muted = true;
      video.srcObject = new MediaStream([event.track]);
    } else if (!video.srcObject.getTracks().includes(event.track)) {
      video.srcObject.addTrack(event.track);
    }
    const kick = () => {
      if (gen !== generation) return;
      ensurePlaying();
    };
    event.track.addEventListener('unmute', kick);
    kick();
    event.track.addEventListener('ended', () => {
      if (gen !== generation || event.track.kind !== 'video') return;
      const stream = video.srcObject;
      const live = stream && stream.getVideoTracks().some((track) => track.readyState === 'live');
      if (live) return;
      video.srcObject = null;
      hearing = false;
      soundMuted = true;
      renderSound();
      setStatus('Esperando a transmissão');
    });
  };
}

function waitForIce(conn, ms) {
  if (!conn || conn.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      conn.removeEventListener('icegatheringstatechange', onState);
      resolve();
    };
    const onState = () => {
      if (conn.iceGatheringState === 'complete') finish();
    };
    const timer = setTimeout(finish, ms);
    conn.addEventListener('icegatheringstatechange', onState);
    if (conn.iceGatheringState === 'complete') finish();
  });
}

function addCandidate(candidate) {
  const current = pc;
  if (!current) return;
  try {
    current.addIceCandidate(candidate).catch((error) => {
      console.error(error);
    });
  } catch (error) {
    console.error(error);
  }
}

function flushCandidates() {
  const queued = iceQueue.splice(0);
  for (const candidate of queued) addCandidate(candidate);
}

function queueIce(candidate) {
  if (!remoteReady || !pc || !pc.remoteDescription) {
    iceQueue.push(candidate);
    return;
  }
  addCandidate(candidate);
}

function onSignal(msg) {
  if (!msg.data) return;
  if (msg.data.kind === 'ice') {
    queueIce(msg.data.candidate);
    return;
  }
  if (msg.data.kind !== 'offer' || typeof msg.data.sdp !== 'string' || typeof msg.from !== 'string') return;
  offerEpoch += 1;
  const epoch = offerEpoch;
  const gen = generation;
  remoteReady = false;
  iceQueue = [];
  clearMediaTimer();
  holdLocalIce();
  later(async () => {
    const current = pc;
    if (!current || gen !== generation || epoch !== offerEpoch) return;
    try {
      hostId = msg.from;
      await current.setRemoteDescription({ type: 'offer', sdp: msg.data.sdp });
      if (gen !== generation || pc !== current || epoch !== offerEpoch) return;
      const answer = await current.createAnswer();
      if (gen !== generation || pc !== current || epoch !== offerEpoch) return;
      await current.setLocalDescription(answer);
      if (gen !== generation || pc !== current || epoch !== offerEpoch) return;
      await waitForIce(current, 1500);
      if (gen !== generation || pc !== current || epoch !== offerEpoch) return;
      send({
        type: 'signal',
        to: hostId,
        data: { kind: 'answer', sdp: current.localDescription.sdp }
      });
      remoteReady = true;
      releaseLocalIce();
      flushCandidates();
      armReconnect(false);
    } catch (error) {
      console.error(error);
      if (gen === generation && epoch === offerEpoch) reconnectIfStuck(gen, true);
    }
  });
}

function waitForBroadcast() {
  closePc();
  setStatus('Esperando a transmissão');
  setViewerCount(0);
}

function nextDelay() {
  const delay = Math.min(15000, 1000 * 2 ** reconnectAttempt);
  reconnectAttempt += 1;
  return delay;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, nextDelay());
}

function connect() {
  if (!roomId) {
    waitForBroadcast();
    return;
  }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const socket = new WebSocket(wsUrl());
  ws = socket;

  socket.onopen = () => {
    if (ws !== socket) return;
    reconnectAttempt = 0;
    startPing();
    waitForBroadcast();
    send({ type: 'join', roomId });
  };

  socket.onmessage = (event) => {
    if (ws !== socket) return;
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'pong') return;
    if (msg.type === 'waiting' || msg.type === 'error') {
      waitForBroadcast();
      return;
    }
    if (msg.type === 'joined') {
      closePc();
      createPc();
      setStatus('Esperando a transmissão');
      return;
    }
    if (msg.type === 'viewers' && Number.isInteger(msg.count)) {
      setViewerCount(msg.count);
      return;
    }
    if (msg.type === 'signal') {
      onSignal(msg);
    }
  };

  socket.onerror = () => {
    // O close reconecta.
  };

  socket.onclose = () => {
    if (ws === socket) ws = null;
    stopPing();
    waitForBroadcast();
    scheduleReconnect();
  };
}

volumeInput.addEventListener('input', () => {
  setVolume(Number(volumeInput.value));
});

unmuteBtn.addEventListener('click', () => {
  soundMuted = !video.muted;
  if (!soundMuted && volumeLevel === 0) volumeLevel = VOLUME_START;
  renderSound();
  if (!video.muted) video.play().catch(() => {});
});

function leaveWatch() {
  location.assign('/watch');
}

leaveBtn.addEventListener('click', leaveWatch);

document.querySelector('.stage').addEventListener('pointerdown', () => {
  if (!video.srcObject) return;
  ensurePlaying();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) ensurePlaying();
});

const playerMenu = document.getElementById('player-menu');
if (window.matchMedia('(hover: none)').matches) {
  playerMenu.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button, input')) return;
    playerMenu.classList.toggle('open');
  });
}

connect();
