'use strict';

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHUNK_BYTES = 960 * 2 * 4;
const MAX_TRACK = CHUNK_BYTES * 4;

let generation = 0;
let session = null;
const binaries = new Map();

function numberProp(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function pidFromXprop(text) {
  const match = /_NET_WM_PID\(CARDINAL\)\s*=\s*(\d+)/.exec(String(text || ''));
  return match ? Number(match[1]) : 0;
}

function ppidFromStat(stat) {
  const end = String(stat).lastIndexOf(')');
  if (end < 0) return 0;
  const parts = stat.slice(end + 2).trim().split(/\s+/);
  return numberProp(parts[1]);
}

function findBin(name) {
  if (binaries.has(name)) return binaries.get(name);
  const dirs = (process.env.PATH || '').split(path.delimiter).concat(['/usr/bin', '/bin', '/usr/local/bin']);
  let found = '';
  for (const dir of dirs) {
    if (!dir) continue;
    const full = path.join(dir, name);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      found = full;
      break;
    } catch {
      // O próximo diretório do PATH.
    }
  }
  binaries.set(name, found);
  return found;
}

function run(file, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeout || 5000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

function descendantPids(root) {
  const include = new Set([root]);
  let names;
  try {
    names = fs.readdirSync('/proc');
  } catch {
    return include;
  }
  const parentOf = new Map();
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = fs.readFileSync(path.join('/proc', name, 'stat'), 'utf8');
      const parent = ppidFromStat(stat);
      if (parent) parentOf.set(Number(name), parent);
    } catch {
      // O processo saiu no meio da leitura.
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, parent] of parentOf) {
      if (include.has(parent) && !include.has(pid)) {
        include.add(pid);
        changed = true;
      }
    }
  }
  return include;
}

function isNode(obj) {
  return obj && typeof obj.type === 'string' && obj.type.endsWith('Interface:Node') && obj.info && obj.info.props;
}

function audioNodesForPids(objects, pids) {
  const clientPid = new Map();
  for (const obj of objects) {
    if (!obj || typeof obj.type !== 'string' || !obj.type.endsWith('Interface:Client')) continue;
    const props = (obj.info && obj.info.props) || {};
    const pid = numberProp(props['application.process.id']);
    if (pid) clientPid.set(Number(obj.id), pid);
  }
  const nodes = [];
  for (const obj of objects) {
    if (!isNode(obj)) continue;
    const props = obj.info.props;
    const mediaClass = String(props['media.class'] || '');
    if (!mediaClass.startsWith('Stream/Output')) continue;
    const mediaType = props['media.type'];
    if (mediaType && mediaType !== 'Audio') continue;
    const name = String(props['node.name'] || '');
    if (name.startsWith('vdz-cap-')) continue;
    let pid = numberProp(props['application.process.id']);
    if (!pid) pid = clientPid.get(numberProp(props['client.id'])) || 0;
    if (!pid || !pids.has(pid)) continue;
    const serial = String(props['object.serial'] || '');
    if (!/^\d+$/.test(serial)) continue;
    nodes.push({ serial, id: Number(obj.id), name });
  }
  return nodes;
}

function portDirection(obj) {
  const info = obj.info || {};
  const props = info.props || {};
  return String(info.direction || props['port.direction'] || '').toLowerCase();
}

function portsFor(objects, nodeId, outgoing) {
  const list = [];
  for (const obj of objects) {
    if (!obj || typeof obj.type !== 'string' || !obj.type.endsWith('Interface:Port')) continue;
    const info = obj.info || {};
    const props = info.props || {};
    const owner = Number(info['node-id'] != null ? info['node-id'] : props['node.id']);
    if (owner !== nodeId) continue;
    const direction = portDirection(obj);
    const isOut = direction === 'out' || direction === 'output';
    if (isOut !== outgoing) continue;
    list.push({ id: Number(obj.id), name: String(props['port.name'] || '') });
  }
  return list;
}

function channelOf(name) {
  const value = String(name).toLowerCase();
  if (value.includes('mono')) return 'mono';
  if (value.includes('front-right') || /(^|_)fr($|_)/.test(value)) return 'r';
  if (value.includes('front-left') || /(^|_)fl($|_)/.test(value)) return 'l';
  return '';
}

function pairPorts(outputs, inputs) {
  const pairs = [];
  const used = new Set();
  function take(channel) {
    return inputs.find((port) => !used.has(port.id) && channelOf(port.name) === channel);
  }
  for (const output of outputs) {
    const channel = channelOf(output.name);
    let input = channel && channel !== 'mono' ? take(channel) : null;
    if (!input) input = inputs.find((port) => !used.has(port.id));
    if (!input) break;
    used.add(input.id);
    pairs.push([output.id, input.id]);
    if (channel === 'mono') {
      const other = inputs.find((port) => !used.has(port.id));
      if (other) {
        used.add(other.id);
        pairs.push([output.id, other.id]);
      }
    }
  }
  return pairs;
}

function linkedSet(objects) {
  const set = new Set();
  for (const obj of objects) {
    if (!obj || typeof obj.type !== 'string' || !obj.type.endsWith('Interface:Link')) continue;
    const info = obj.info || {};
    if (info['output-port-id'] == null || info['input-port-id'] == null) continue;
    set.add(info['output-port-id'] + ':' + info['input-port-id']);
  }
  return set;
}

function nodeBySerial(objects, serial) {
  for (const obj of objects) {
    if (!isNode(obj)) continue;
    if (String(obj.info.props['object.serial']) === serial) return obj;
  }
  return null;
}

function nodeByName(objects, name) {
  for (const obj of objects) {
    if (!isNode(obj)) continue;
    if (obj.info.props['node.name'] === name) return obj;
  }
  return null;
}

function createMix(onChunk) {
  const tracks = new Map();
  function remove(serial) {
    tracks.delete(serial);
  }
  function push(serial, chunk) {
    let buf = tracks.get(serial) || Buffer.alloc(0);
    buf = Buffer.concat([buf, chunk]);
    if (buf.length > MAX_TRACK) {
      const start = buf.length - MAX_TRACK;
      const aligned = start - (start % 4);
      buf = Buffer.from(buf.subarray(aligned));
    }
    tracks.set(serial, buf);
    drain();
  }
  function drain() {
    const ids = [...tracks.keys()];
    if (!ids.length) return;
    const ready = ids.filter((id) => tracks.get(id).length >= CHUNK_BYTES);
    if (!ready.length) return;
    const waiting = ids.some((id) => {
      const len = tracks.get(id).length;
      return len > 0 && len < CHUNK_BYTES;
    });
    const bloated = ids.some((id) => tracks.get(id).length >= CHUNK_BYTES * 3);
    if (waiting && !bloated) return;
    const out = Buffer.alloc(CHUNK_BYTES);
    const samples = CHUNK_BYTES / 4;
    for (let i = 0; i < samples; i++) {
      let sum = 0;
      for (const id of ready) sum += tracks.get(id).readFloatLE(i * 4);
      if (sum > 1) sum = 1;
      else if (sum < -1) sum = -1;
      out.writeFloatLE(sum, i * 4);
    }
    for (const id of ready) {
      const buf = tracks.get(id);
      tracks.set(id, Buffer.from(buf.subarray(CHUNK_BYTES)));
    }
    onChunk(out);
    drain();
  }
  return { push, remove };
}

function spawnRecord(current, node) {
  const nodeName = 'vdz-cap-' + node.serial;
  const child = spawn(current.recordBin, [
    '--raw',
    '--rate', '48000',
    '--channels', '2',
    '--channel-map', 'stereo',
    '--format', 'f32',
    '--latency', '20ms',
    '--target', '0',
    '--properties', JSON.stringify({ 'node.name': nodeName, 'node.description': 'vdz' }),
    '-'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const rec = { child, nodeName, logged: false };
  current.recs.set(node.serial, rec);
  let stderr = '';
  child.stderr.on('data', (buf) => {
    if (rec.logged) return;
    stderr += buf.toString();
    if (stderr.length > 400) stderr = stderr.slice(-400);
  });
  child.on('error', (error) => {
    console.error(error);
  });
  child.stdout.on('data', (buf) => {
    if (!session || session.gen !== current.gen) return;
    current.mix.push(node.serial, buf);
  });
  child.on('exit', () => {
    if (!session || session.gen !== current.gen) return;
    if (stderr.trim()) console.error(stderr.trim());
    rec.logged = true;
    current.recs.delete(node.serial);
    current.mix.remove(node.serial);
  });
}

async function linkAll(current, objects) {
  const existing = linkedSet(objects);
  const jobs = [];
  for (const [serial, rec] of current.recs) {
    const source = nodeBySerial(objects, serial);
    const sink = nodeByName(objects, rec.nodeName);
    if (!source || !sink) continue;
    const outputs = portsFor(objects, Number(source.id), true);
    const inputs = portsFor(objects, Number(sink.id), false);
    for (const pair of pairPorts(outputs, inputs)) {
      const key = pair[0] + ':' + pair[1];
      if (existing.has(key)) continue;
      jobs.push(run(current.linkBin, [String(pair[0]), String(pair[1])], 2000).catch(() => {}));
    }
  }
  await Promise.all(jobs);
}

async function refresh(current) {
  if (session !== current) return;
  const dumped = await run(current.dumpBin, [], 5000);
  if (session !== current) return;
  const objects = JSON.parse(dumped.stdout);
  if (!Array.isArray(objects)) return;
  const nodes = audioNodesForPids(objects, descendantPids(current.pid));
  const want = new Set(nodes.map((node) => node.serial));
  for (const [serial, rec] of current.recs) {
    if (want.has(serial)) continue;
    rec.child.kill();
    current.recs.delete(serial);
    current.mix.remove(serial);
  }
  for (const node of nodes) {
    if (!current.recs.has(node.serial)) spawnRecord(current, node);
  }
  await linkAll(current, objects);
}

function stop() {
  const current = session;
  session = null;
  generation += 1;
  if (!current) return;
  clearInterval(current.timer);
  for (const rec of current.recs.values()) {
    try {
      rec.child.kill();
    } catch {
      // O gravador já tinha saído.
    }
  }
  current.recs.clear();
}

function start(pid, onChunk) {
  stop();
  const gen = generation;
  const root = numberProp(pid);
  if (!root || root === process.pid) return Promise.resolve(false);
  const dumpBin = findBin('pw-dump');
  const recordBin = findBin('pw-record');
  const linkBin = findBin('pw-link');
  if (!dumpBin || !recordBin || !linkBin) {
    console.error('pipewire indisponível');
    return Promise.resolve(false);
  }
  return run(dumpBin, [], 5000).then(() => {
    if (gen !== generation) return false;
    const current = {
      gen,
      pid: root,
      dumpBin,
      recordBin,
      linkBin,
      recs: new Map(),
      mix: createMix(onChunk),
      timer: null
    };
    current.timer = setInterval(() => {
      refresh(current).catch((error) => console.error(error));
    }, 1000);
    session = current;
    return refresh(current).then(() => true, (error) => {
      console.error(error);
      return true;
    });
  }).catch((error) => {
    console.error(error);
    return false;
  });
}

function lookupPids(windowIds) {
  const bin = findBin('xprop');
  return Promise.all(windowIds.map((id) => {
    if (!bin || !/^\d+$/.test(String(id))) return Promise.resolve(0);
    return run(bin, ['-id', String(id), '_NET_WM_PID'], 2000).then(
      (result) => pidFromXprop(result.stdout),
      (error) => pidFromXprop(error.stdout)
    );
  }));
}

function selfCheck() {
  const errors = [];
  function expect(cond, message) {
    if (!cond) errors.push(message);
  }
  expect(pidFromXprop('_NET_WM_PID(CARDINAL) = 4242\n') === 4242, 'pid do xprop');
  expect(pidFromXprop('_NET_WM_PID:  not found.') === 0, 'xprop sem pid');
  expect(ppidFromStat('12 (my proc) S 20 1') === 20, 'ppid');
  expect(ppidFromStat('12 (weird) name) S 7 1') === 7, 'ppid com parentese');
  const nodes = audioNodesForPids([
    { id: 10, type: 'PipeWire:Interface:Client', info: { props: { 'application.process.id': '50' } } },
    {
      id: 20,
      type: 'PipeWire:Interface:Node',
      info: {
        props: {
          'object.serial': 99,
          'media.class': 'Stream/Output',
          'media.type': 'Audio',
          'client.id': 10,
          'node.name': 'Firefox'
        }
      }
    },
    {
      id: 21,
      type: 'PipeWire:Interface:Node',
      info: {
        props: {
          'object.serial': 100,
          'media.class': 'Stream/Output',
          'media.type': 'Video',
          'application.process.id': 50,
          'node.name': 'Firefox-video'
        }
      }
    },
    {
      id: 22,
      type: 'PipeWire:Interface:Node',
      info: {
        props: {
          'object.serial': 101,
          'media.class': 'Stream/Output',
          'media.type': 'Audio',
          'application.process.id': 50,
          'node.name': 'vdz-cap-1'
        }
      }
    }
  ], new Set([50]));
  expect(nodes.length === 1 && nodes[0].serial === '99', 'filtra o fluxo de audio');
  const outputs = [{ id: 1, name: 'output_FL' }, { id: 2, name: 'output_FR' }];
  const inputs = [{ id: 3, name: 'input_FR' }, { id: 4, name: 'input_FL' }];
  const pairs = pairPorts(outputs, inputs);
  expect(pairs.length === 2 && pairs[0][0] === 1 && pairs[0][1] === 4 && pairs[1][1] === 3, 'emparelha canais');
  const mono = pairPorts([{ id: 1, name: 'output_MONO' }], inputs);
  expect(mono.length === 2, 'mono vai para os dois canais');
  const chunks = [];
  const mix = createMix((piece) => chunks.push(piece));
  const frame = Buffer.alloc(4);
  frame.writeFloatLE(0.5, 0);
  const block = Buffer.alloc(CHUNK_BYTES);
  for (let i = 0; i < CHUNK_BYTES; i += 4) frame.copy(block, i);
  mix.push('a', block);
  expect(chunks.length === 1 && chunks[0].readFloatLE(0) === 0.5, 'mix de um fluxo');
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
}

if (require.main === module && process.argv[2] === '--self-check') selfCheck();

module.exports = { lookupPids, start, stop };
