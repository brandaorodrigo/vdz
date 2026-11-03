'use strict';

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const PING_MS = 4 * 60 * 1000;
const BITRATES = new Map([
  ['480:30', 500_000],
  ['480:60', 1_000_000],
  ['720:30', 2_000_000],
  ['720:60', 3_000_000],
  ['1080:30', 4_000_000],
  ['1080:60', 5_000_000]
]);
const FRAME_RATES = new Set([30, 60]);
const RESOLUTIONS = new Map([
  [480, { width: 854, height: 480 }],
  [720, { width: 1280, height: 720 }],
  [1080, { width: 1920, height: 1080 }]
]);

const statusEl = document.getElementById('status');
const nameInput = document.getElementById('room-name');
const settingsEl = document.getElementById('capture-settings');
const fpsSelect = document.getElementById('fps');
const resolutionSelect = document.getElementById('resolution');
const createBtn = document.getElementById('create');
const shareBtn = document.getElementById('share');
const stopBtn = document.getElementById('stop');
const preview = document.getElementById('preview');
const pickerEl = document.getElementById('picker');
const pickerList = document.getElementById('picker-list');

let ws = null;
let phase = 'idle';
let creating = false;
let queuedCreate = false;
let pendingName = '';
let roomWasLost = false;
let reconnectTimer = null;
let reconnectAttempt = 0;
let pingTimer = null;
let localStream = null;
const viewers = new Set();
const peers = new Map();

function setStatus(text) {
  const message = typeof text === 'string' ? text.trim() : '';
  statusEl.textContent = message;
  statusEl.hidden = !message;
}

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

function chosenBitrate() {
  const size = chosenSize();
  return BITRATES.get(size.height + ':' + chosenFrameRate()) || 3_000_000;
}

function chosenFrameRate() {
  const value = Number(fpsSelect.value);
  return FRAME_RATES.has(value) ? value : 30;
}

function chosenSize() {
  return RESOLUTIONS.get(Number(resolutionSelect.value)) || RESOLUTIONS.get(720);
}

function videoConstraints() {
  const size = chosenSize();
  return {
    width: { ideal: size.width },
    height: { ideal: size.height },
    frameRate: { ideal: chosenFrameRate() },
    cursor: 'always'
  };
}

async function applyCaptureLimits(track) {
  const size = chosenSize();
  const frameRate = chosenFrameRate();
  try {
    await track.applyConstraints({
      width: { ideal: size.width, max: size.width },
      height: { ideal: size.height, max: size.height },
      frameRate: { ideal: frameRate, max: frameRate }
    });
  } catch (error) {
    console.error(error);
  }
}

function showQuality(visible) {
  fpsSelect.hidden = !visible;
  resolutionSelect.hidden = !visible;
}

function showRoom() {
  nameInput.hidden = true;
  nameInput.disabled = false;
  settingsEl.hidden = true;
  createBtn.hidden = true;
  createBtn.disabled = false;
  showQuality(true);
  shareBtn.hidden = false;
  shareBtn.disabled = false;
  stopBtn.hidden = false;
}

function showCreate() {
  nameInput.hidden = false;
  nameInput.disabled = false;
  settingsEl.hidden = false;
  createBtn.hidden = false;
  createBtn.disabled = false;
  showQuality(false);
  shareBtn.hidden = true;
  stopBtn.hidden = true;
  preview.hidden = true;
}

function hideWhileReconnect() {
  nameInput.hidden = true;
  settingsEl.hidden = true;
  createBtn.hidden = true;
  showQuality(false);
  shareBtn.hidden = true;
  stopBtn.hidden = true;
  preview.hidden = true;
}

function stopStream() {
  releaseDesktopAudio();
  if (!localStream) return;
  for (const track of localStream.getTracks()) {
    track.onended = null;
    track.stop();
  }
  localStream = null;
  preview.srcObject = null;
  preview.hidden = true;
}

function closePeer(viewerId) {
  const entry = peers.get(viewerId);
  if (!entry) return;
  peers.delete(viewerId);
  clearEntryTimers(entry);
  entry.pc.onicecandidate = null;
  entry.pc.onconnectionstatechange = null;
  entry.pc.oniceconnectionstatechange = null;
  try {
    entry.pc.close();
  } catch {
    // A conexão já estava encerrada.
  }
}

function closeAllPeers() {
  for (const viewerId of [...peers.keys()]) closePeer(viewerId);
}

function teardownMedia() {
  stopStream();
  closeAllPeers();
  clearAllRetries();
  viewers.clear();
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
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const socket = new WebSocket(wsUrl());
  ws = socket;

  socket.onopen = () => {
    if (ws !== socket) return;
    reconnectAttempt = 0;
    startPing();
    if (roomWasLost) {
      roomWasLost = false;
      creating = false;
      queuedCreate = false;
      phase = 'dead';
      showCreate();
      setStatus();
      return;
    }
    if (queuedCreate) {
      queuedCreate = false;
      send({ type: 'create', roomId: pendingName });
      return;
    }
    if (phase === 'reconnecting') {
      phase = 'idle';
      showCreate();
      setStatus();
    }
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
    if (msg.type === 'error') onCreateError(msg);
    else if (msg.type === 'created') onCreated(msg);
    else if (msg.type === 'viewer-joined') onViewerJoined(msg);
    else if (msg.type === 'viewer-left') onViewerLeft(msg);
    else if (msg.type === 'signal') onSignal(msg);
  };

  socket.onerror = () => {
    // O close reconecta.
  };

  socket.onclose = () => {
    const wasCurrent = ws === socket;
    if (wasCurrent) {
      ws = null;
      stopPing();
    }
    if (socket.userEnded) {
      if (wasCurrent) creating = false;
      return;
    }
    if (!wasCurrent) return;
    const lostRoom = phase === 'live' || phase === 'sharing';
    if (lostRoom) {
      roomWasLost = true;
      creating = false;
      queuedCreate = false;
      teardownMedia();
      hideWhileReconnect();
    } else if (creating) {
      queuedCreate = true;
    }
    phase = 'reconnecting';
    setStatus('reconectando');
    scheduleReconnect();
  };
}

function chosenName() {
  return nameInput.value.trim().toLowerCase();
}

function onCreateError(msg) {
  if (phase === 'live' || phase === 'sharing') return;
  creating = false;
  queuedCreate = false;
  phase = 'idle';
  showCreate();
  const text = typeof msg.message === 'string' && msg.message
    ? msg.message
    : 'Não foi possível criar a sala';
  setStatus(text);
}

function onCreated(msg) {
  if (typeof msg.roomId !== 'string' || phase === 'live' || phase === 'sharing') return;
  creating = false;
  queuedCreate = false;
  phase = 'live';
  viewers.clear();
  clearAllRetries();
  closeAllPeers();
  preview.hidden = true;
  showRoom();
  setStatus();
}

function onViewerJoined(msg) {
  if (typeof msg.viewerId !== 'string') return;
  if (phase !== 'live' && phase !== 'sharing') return;
  viewers.add(msg.viewerId);
  offerTo(msg.viewerId);
}

function onViewerLeft(msg) {
  if (typeof msg.viewerId !== 'string') return;
  viewers.delete(msg.viewerId);
  clearRetry(msg.viewerId);
  closePeer(msg.viewerId);
}

function onSignal(msg) {
  if (typeof msg.from !== 'string' || !msg.data) return;
  const entry = peers.get(msg.from);
  if (!entry) return;
  entry.chain = entry.chain.then(() => {
    if (peers.get(msg.from) !== entry) return;
    return applyRemote(entry, msg.data);
  }).catch((error) => {
    console.error(error);
  });
}

async function applyRemote(entry, data) {
  if (data.kind === 'answer' && typeof data.sdp === 'string') {
    await entry.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
    await flushCandidates(entry);
    return;
  }
  if (data.kind === 'ice') {
    if (!entry.pc.remoteDescription) {
      entry.queue.push(data.candidate);
      return;
    }
    await addCandidate(entry.pc, data.candidate);
  }
}

async function flushCandidates(entry) {
  const queued = entry.queue.splice(0);
  for (const candidate of queued) await addCandidate(entry.pc, candidate);
}

async function addCandidate(pc, candidate) {
  if (!candidate) return;
  try {
    await pc.addIceCandidate(candidate);
  } catch (error) {
    console.error(error);
  }
}

async function capVideoBitrate(pc) {
  const sender = pc.getSenders().find((item) => item.track && item.track.kind === 'video');
  if (!sender) return;
  const params = sender.getParameters();
  if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
  params.encodings[0].maxBitrate = chosenBitrate();
  params.encodings[0].maxFramerate = chosenFrameRate();
  await sender.setParameters(params);
}

let qualityChain = Promise.resolve();

function scheduleQuality() {
  qualityChain = qualityChain.then(() => pushQuality()).catch((error) => {
    console.error(error);
  });
}

async function pushQuality() {
  const stream = localStream;
  if (phase !== 'sharing' || !stream) return;
  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) return;
  await applyCaptureLimits(videoTrack);
  if (localStream !== stream || phase !== 'sharing') return;
  await Promise.all([...peers.values()].map(async (entry) => {
    try {
      await capVideoBitrate(entry.pc);
    } catch (error) {
      console.error(error);
    }
  }));
}

const RETRY_STALL_MS = 15000;
const RETRY_DISCONNECT_MS = 5000;
const retries = new Map();

function canRetry(viewerId) {
  return viewers.has(viewerId) && !!localStream && (phase === 'live' || phase === 'sharing');
}

function peerIsUp(pc) {
  if (!pc) return false;
  const ice = pc.iceConnectionState;
  if (ice === 'connected' || ice === 'completed') return true;
  return pc.connectionState === 'connected';
}

function peerIsNegotiating(pc) {
  if (!pc || pc.connectionState === 'closed' || pc.signalingState === 'closed') return false;
  if (pc.signalingState === 'have-local-offer') return true;
  const ice = pc.iceConnectionState;
  const conn = pc.connectionState;
  return ice === 'new' || ice === 'checking' || conn === 'new' || conn === 'connecting';
}

function ensureRetry(viewerId) {
  let state = retries.get(viewerId);
  if (!state) {
    state = { timer: null, attempt: 0, running: false, again: false };
    retries.set(viewerId, state);
  }
  return state;
}

function clearRetry(viewerId) {
  const state = retries.get(viewerId);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  retries.delete(viewerId);
}

function clearAllRetries() {
  for (const viewerId of [...retries.keys()]) clearRetry(viewerId);
}

function clearEntryTimers(entry) {
  if (entry.stallTimer) clearTimeout(entry.stallTimer);
  if (entry.disconnectTimer) clearTimeout(entry.disconnectTimer);
  entry.stallTimer = null;
  entry.disconnectTimer = null;
}

function notePeerUp(viewerId) {
  const state = retries.get(viewerId);
  if (state) {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    state.attempt = 0;
    state.again = false;
  }
  const entry = peers.get(viewerId);
  if (!entry) return;
  clearEntryTimers(entry);
}

function schedulePeerRetry(viewerId) {
  if (!canRetry(viewerId)) return;
  const entry = peers.get(viewerId);
  if (entry && peerIsUp(entry.pc)) return;
  if (entry && entry.disconnectTimer) {
    clearTimeout(entry.disconnectTimer);
    entry.disconnectTimer = null;
  }
  const state = ensureRetry(viewerId);
  if (state.running) {
    state.again = true;
    return;
  }
  if (state.timer) return;
  const delay = Math.min(RETRY_STALL_MS, 2000 * 2 ** Math.min(state.attempt, 4));
  state.attempt += 1;
  state.timer = setTimeout(() => {
    state.timer = null;
    retryPeer(viewerId);
  }, delay);
}

function armStall(viewerId, entry) {
  if (entry.stallTimer) clearTimeout(entry.stallTimer);
  entry.stallTimer = setTimeout(() => {
    entry.stallTimer = null;
    if (peers.get(viewerId) !== entry) return;
    if (peerIsUp(entry.pc)) return;
    schedulePeerRetry(viewerId);
  }, RETRY_STALL_MS);
}

function armDisconnect(viewerId, entry) {
  if (entry.disconnectTimer) return;
  entry.disconnectTimer = setTimeout(() => {
    entry.disconnectTimer = null;
    if (peers.get(viewerId) !== entry) return;
    if (peerIsUp(entry.pc)) return;
    const ice = entry.pc.iceConnectionState;
    const conn = entry.pc.connectionState;
    if (ice === 'disconnected' || conn === 'disconnected') schedulePeerRetry(viewerId);
  }, RETRY_DISCONNECT_MS);
}

function watchPeer(viewerId, entry) {
  const pc = entry.pc;
  pc.onconnectionstatechange = () => {
    if (peers.get(viewerId) !== entry) return;
    if (peerIsUp(pc)) {
      notePeerUp(viewerId);
      return;
    }
    if (pc.connectionState === 'failed') schedulePeerRetry(viewerId);
    if (pc.connectionState === 'disconnected') armDisconnect(viewerId, entry);
  };
  pc.oniceconnectionstatechange = () => {
    if (peers.get(viewerId) !== entry) return;
    if (peerIsUp(pc)) {
      notePeerUp(viewerId);
      return;
    }
    if (pc.iceConnectionState === 'failed') schedulePeerRetry(viewerId);
    if (pc.iceConnectionState === 'disconnected') armDisconnect(viewerId, entry);
  };
}

async function retryPeer(viewerId) {
  const state = retries.get(viewerId);
  if (!state || state.running) return;
  if (!canRetry(viewerId)) return;
  state.running = true;
  state.again = false;
  try {
    let entry = peers.get(viewerId);
    if (entry && peerIsUp(entry.pc)) return;
    const replace = !entry
      || entry.pc.signalingState !== 'stable'
      || entry.pc.connectionState === 'closed'
      || state.attempt % 3 === 0;
    if (!replace) {
      let sent = false;
      try {
        sent = await renegotiate(entry, viewerId, true);
      } catch (error) {
        console.error(error);
      }
      if (!canRetry(viewerId)) return;
      if (sent && peers.get(viewerId) === entry) return;
      if (peers.get(viewerId) !== entry) return;
    }
    if (!canRetry(viewerId)) return;
    entry = peers.get(viewerId);
    if (entry) closePeer(viewerId);
    await offerTo(viewerId);
  } finally {
    state.running = false;
    if (state.again && retries.get(viewerId) === state) {
      state.again = false;
      const current = peers.get(viewerId);
      if (!current || !peerIsNegotiating(current.pc)) schedulePeerRetry(viewerId);
    }
  }
}

async function offerTo(viewerId) {
  if (!localStream || !viewers.has(viewerId) || peers.has(viewerId)) return;
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const entry = {
    pc,
    queue: [],
    chain: Promise.resolve(),
    iceBuffer: [],
    iceOpen: false,
    stallTimer: null,
    disconnectTimer: null
  };
  peers.set(viewerId, entry);
  watchPeer(viewerId, entry);
  pc.onicecandidate = (event) => {
    const data = { kind: 'ice', candidate: event.candidate };
    if (!entry.iceOpen) {
      entry.iceBuffer.push(data);
      return;
    }
    send({ type: 'signal', to: viewerId, data });
  };

  try {
    const videoTrack = localStream.getVideoTracks()[0];
    if (!videoTrack) {
      closePeer(viewerId);
      schedulePeerRetry(viewerId);
      return;
    }
    const audioTrack = localStream.getAudioTracks()[0] || null;
    const videoTransceiver = pc.addTransceiver(videoTrack, {
      direction: 'sendonly',
      streams: [localStream],
      sendEncodings: [{ maxBitrate: chosenBitrate(), maxFramerate: chosenFrameRate() }]
    });
    const audioTransceiver = audioTrack
      ? pc.addTransceiver(audioTrack, { direction: 'sendonly', streams: [localStream] })
      : pc.addTransceiver('audio', { direction: 'sendonly' });
    entry.videoSender = videoTransceiver.sender;
    entry.audioSender = audioTransceiver.sender;
    const offer = await pc.createOffer();
    if (peers.get(viewerId) !== entry) return;
    await pc.setLocalDescription(offer);
    if (peers.get(viewerId) !== entry) return;
    try {
      await capVideoBitrate(pc);
    } catch (error) {
      console.error(error);
    }
    if (peers.get(viewerId) !== entry) return;
    send({
      type: 'signal',
      to: viewerId,
      data: { kind: 'offer', sdp: pc.localDescription.sdp }
    });
    entry.iceOpen = true;
    for (const data of entry.iceBuffer.splice(0)) {
      send({ type: 'signal', to: viewerId, data });
    }
    if (peers.get(viewerId) === entry) armStall(viewerId, entry);
  } catch (error) {
    console.error(error);
    closePeer(viewerId);
    schedulePeerRetry(viewerId);
  }
}

function isCancel(error) {
  return error && (error.name === 'NotAllowedError' || error.name === 'AbortError');
}

let pickerResolver = null;
let loopbackGraph = null;

function closePicker(result) {
  if (pickerEl) pickerEl.hidden = true;
  if (pickerList) pickerList.replaceChildren();
  const resolve = pickerResolver;
  pickerResolver = null;
  if (resolve) resolve(result);
}

function chooseWindow() {
  return window.vdzDesktop.listWindows().then((windows) => {
    if (!windows.length) throw new Error('sem janelas');
    if (phase !== 'live' && phase !== 'sharing') {
      const error = new Error('cancelado');
      error.name = 'AbortError';
      throw error;
    }
    pickerList.replaceChildren();
    return new Promise((resolve) => {
      pickerResolver = resolve;
      for (const item of windows) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'window-choice';
        if (item.thumbnail) {
          const thumb = document.createElement('img');
          thumb.alt = '';
          thumb.src = item.thumbnail;
          button.append(thumb);
        }
        const label = document.createElement('span');
        label.textContent = item.name;
        button.append(label);
        button.addEventListener('click', () => closePicker(item));
        pickerList.append(button);
      }
      pickerEl.hidden = false;
    });
  });
}

function floatsFromBytes(bytes) {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return new Float32Array(copy);
}

function closeLoopbackGraph() {
  const graph = loopbackGraph;
  loopbackGraph = null;
  if (!graph) return;
  graph.unsubscribe();
  graph.ctx.close().catch(() => {});
}

function releaseDesktopAudio() {
  closeLoopbackGraph();
  if (window.vdzDesktop) window.vdzDesktop.stopAudio();
}

async function connectLoopback(stream) {
  closeLoopbackGraph();
  const ctx = new AudioContext({ sampleRate: 48000 });
  await ctx.resume();
  await ctx.audioWorklet.addModule('/loopback-worklet.js');
  const node = new AudioWorkletNode(ctx, 'vdz-loopback', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2]
  });
  const dest = ctx.createMediaStreamDestination();
  dest.channelCount = 2;
  dest.channelCountMode = 'explicit';
  node.connect(dest);
  const unsubscribe = window.vdzDesktop.onPcm((bytes) => {
    if (!bytes || !bytes.byteLength) return;
    node.port.postMessage(floatsFromBytes(bytes));
  });
  stream.addTrack(dest.stream.getAudioTracks()[0]);
  loopbackGraph = { ctx, unsubscribe };
}

function cancelError() {
  const error = new Error('cancelado');
  error.name = 'AbortError';
  return error;
}

async function captureDesktopWindow() {
  const picked = await chooseWindow();
  if (!picked) throw cancelError();
  if (phase !== 'live' && phase !== 'sharing') throw cancelError();
  if (!window.vdzDesktop.arm(picked.id)) throw new Error('janela indisponível');
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: videoConstraints(),
    audio: false
  });
  let audioMissing = true;
  try {
    const started = await window.vdzDesktop.beginAudio(picked.id);
    if (started) {
      await connectLoopback(stream);
      audioMissing = false;
    }
  } catch (error) {
    console.error(error);
    try {
      await window.vdzDesktop.stopAudio();
    } catch {
      // A imagem segue sem o som do processo.
    }
  }
  return { stream, audioMissing };
}

async function captureScreen() {
  if (window.vdzDesktop) return captureDesktopWindow();
  const video = videoConstraints();
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video, audio: true });
    return { stream, audioMissing: stream.getAudioTracks().length === 0 };
  } catch (error) {
    if (isCancel(error)) throw error;
    const stream = await navigator.mediaDevices.getDisplayMedia({ video, audio: false });
    return { stream, audioMissing: true };
  }
}

function bindEnded(track) {
  if (!track) return;
  track.onended = () => pauseCapture();
}

function pauseCapture() {
  if (phase !== 'sharing') return;
  const stream = localStream;
  localStream = null;
  stopStreamTracks(stream);
  releaseDesktopAudio();
  preview.srcObject = null;
  preview.hidden = true;
  phase = 'live';
  shareBtn.hidden = false;
  shareBtn.disabled = false;
  setStatus('aguardando transmissão');
}

function unbindEnded(stream) {
  if (!stream) return;
  for (const track of stream.getTracks()) track.onended = null;
}

function stopStreamTracks(stream) {
  if (!stream) return;
  unbindEnded(stream);
  for (const track of stream.getTracks()) track.stop();
}

async function replaceOnPeer(entry, videoTrack, audioTrack) {
  if (entry.videoSender) await entry.videoSender.replaceTrack(videoTrack);
  if (entry.audioSender) await entry.audioSender.replaceTrack(audioTrack);
}

async function pushTracks(videoTrack, audioTrack) {
  const current = [...peers.values()];
  await Promise.all(current.map((entry) => replaceOnPeer(entry, videoTrack, audioTrack)));
}

async function renegotiate(entry, viewerId, iceRestart) {
  const pc = entry.pc;
  if (!pc || pc.signalingState !== 'stable') return false;
  const restart = !!iceRestart;
  if (restart && typeof pc.restartIce === 'function') pc.restartIce();
  if (restart) entry.queue = [];
  entry.iceBuffer = [];
  entry.iceOpen = false;
  const offer = await pc.createOffer(restart ? { iceRestart: true } : undefined);
  if (peers.get(viewerId) !== entry) return false;
  await pc.setLocalDescription(offer);
  if (peers.get(viewerId) !== entry) return false;
  if (restart) {
    try {
      await capVideoBitrate(pc);
    } catch (error) {
      console.error(error);
    }
  }
  if (peers.get(viewerId) !== entry) return false;
  send({
    type: 'signal',
    to: viewerId,
    data: { kind: 'offer', sdp: pc.localDescription.sdp }
  });
  entry.iceOpen = true;
  for (const data of entry.iceBuffer.splice(0)) {
    send({ type: 'signal', to: viewerId, data });
  }
  armStall(viewerId, entry);
  return true;
}

async function startCapture() {
  if ((phase !== 'live' && phase !== 'sharing') || shareBtn.disabled) return;
  const switching = phase === 'sharing' && !!localStream;
  shareBtn.disabled = true;
  if (switching) unbindEnded(localStream);
  let captured;
  try {
    captured = await captureScreen();
  } catch (error) {
    shareBtn.disabled = false;
    if (switching) bindEnded(localStream && localStream.getVideoTracks()[0]);
    if (!isCancel(error)) {
      console.error(error);
      if (!switching) setStatus('não foi possível capturar a tela');
    }
    return;
  }

  const stream = captured.stream;
  if (phase !== 'live' && phase !== 'sharing') {
    stopStreamTracks(stream);
    releaseDesktopAudio();
    return;
  }
  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) {
    stopStreamTracks(stream);
    releaseDesktopAudio();
    shareBtn.disabled = false;
    if (switching) bindEnded(localStream && localStream.getVideoTracks()[0]);
    if (!switching) setStatus('não foi possível capturar a tela');
    return;
  }

  await applyCaptureLimits(videoTrack);
  videoTrack.contentHint = 'detail';
  const audioTrack = stream.getAudioTracks()[0] || null;
  const previous = localStream;
  localStream = stream;
  try {
    await pushTracks(videoTrack, audioTrack);
  } catch (error) {
    console.error(error);
    localStream = previous;
    stopStreamTracks(stream);
    releaseDesktopAudio();
    shareBtn.disabled = false;
    if (switching) bindEnded(previous && previous.getVideoTracks()[0]);
    if (!switching) setStatus('não foi possível capturar a tela');
    return;
  }

  const resumeIds = previous ? [] : [...peers.keys()];
  stopStreamTracks(previous);
  bindEnded(videoTrack);
  preview.srcObject = stream;
  preview.hidden = false;
  preview.play().catch(() => {});
  phase = 'sharing';
  shareBtn.disabled = false;
  if (captured.audioMissing) setStatus('transmissão sem som');
  else setStatus();

  if (!previous) {
    for (const viewerId of [...viewers]) {
      await offerTo(viewerId);
    }
    for (const viewerId of resumeIds) {
      const entry = peers.get(viewerId);
      if (!entry) continue;
      try {
        const sent = await renegotiate(entry, viewerId);
        if (sent) continue;
      } catch (error) {
        console.error(error);
      }
      if (!viewers.has(viewerId) || peers.get(viewerId) !== entry) continue;
      closePeer(viewerId);
      await offerTo(viewerId);
    }
  }
}

function endRoom() {
  closePicker(null);
  if (phase !== 'live' && phase !== 'sharing') return;
  send({ type: 'leave' });
  phase = 'dead';
  roomWasLost = false;
  creating = false;
  queuedCreate = false;
  teardownMedia();
  showCreate();
  setStatus();
}

function leavePage() {
  if (phase === 'live' || phase === 'sharing') send({ type: 'leave' });
  if (!ws || ws.readyState === WebSocket.CLOSED) return;
  ws.userEnded = true;
  ws.close();
}

function roomNameFromField() {
  const name = chosenName();
  if (name === 'host' || name === 'watch') {
    setStatus('esse nome não pode ser usado');
    return '';
  }
  if (/^[a-z]{1,32}$/.test(name)) return name;
  setStatus(name ? 'use somente letras, sem espaços nem números' : 'nome obrigatório');
  return '';
}

function requestCreate() {
  if (creating || phase === 'live' || phase === 'sharing') return;
  const name = roomNameFromField();
  if (!name) return;
  pendingName = name;
  nameInput.value = name;
  creating = true;
  createBtn.disabled = true;
  nameInput.disabled = true;
  if (ws && ws.readyState === WebSocket.OPEN) {
    send({ type: 'create', roomId: pendingName });
    return;
  }
  queuedCreate = true;
  if (phase !== 'reconnecting') {
    phase = 'reconnecting';
    setStatus('Reconectando');
  }
  connect();
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && pickerResolver) closePicker(null);
});

nameInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  requestCreate();
});

fpsSelect.addEventListener('change', scheduleQuality);
resolutionSelect.addEventListener('change', scheduleQuality);

createBtn.addEventListener('click', requestCreate);
document.querySelector('.stream-back').addEventListener('click', (event) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (phase !== 'live' && phase !== 'sharing') return;
  send({ type: 'leave' });
});
window.addEventListener('pagehide', leavePage);
shareBtn.addEventListener('click', () => {
  startCapture();
});
stopBtn.addEventListener('click', endRoom);

connect();
