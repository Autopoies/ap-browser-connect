#!/usr/bin/env node
// No-install protocol probe: Node >=26, disposable headless Chrome/profile only.
// Run: node tests/recording-cdp-probe.mjs
// Optional CDP_PROBE_CHROME: explicit browser executable (missing => failure).
// This does NOT exercise the extension/native host, or guarantee background fps.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const chromePath = process.env.CDP_PROBE_CHROME
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const LIMIT_MS = 45_000;
const abort = new AbortController();
const delay = ms => sleep(ms, undefined, { signal: abort.signal });
const mono = () => performance.now();
let profile, chrome, cdp, timeout;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => abort.abort(new Error(`Received ${signal}`)));
// Last-resort deadline even if a native socket/cleanup operation fails to settle.
setTimeout(() => {
  if (chrome && chrome.exitCode === null && chrome.signalCode === null) chrome.kill('SIGKILL');
  console.error('FAIL: CDP probe hard deadline exceeded');
  process.exit(1);
}, LIMIT_MS + 10_000).unref();
let chromeLog = '';
let spawnError;
let failed = false;
let acked = 0;
const pendingAcks = new Set(), ackErrors = [];
const report = {
  scope: 'protocol-only; disposable headless Chrome; not extension/native E2E or background-tab evidence',
  node: process.version,
  chromePath,
};

class CDP {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.pending = new Map();
    this.handlers = new Map();
    this.nextId = 0;
    this.socket.addEventListener('message', ({ data }) => {
      try {
        const message = JSON.parse(data);
        if (message.id) {
          const request = this.pending.get(message.id);
          if (!request) return;
          this.pending.delete(message.id);
          clearTimeout(request.timer);
          if (message.error) request.reject(new Error(JSON.stringify(message.error)));
          else request.resolve(message.result);
        } else {
          for (const handler of this.handlers.get(message.method) ?? []) handler(message.params);
        }
      } catch (error) {
        this.eventError ??= error;
      }
    });
    this.socket.addEventListener('close', () => this.rejectPending(new Error('CDP closed')));
    this.socket.addEventListener('error', () => this.rejectPending(new Error('CDP socket error')));
  }
  async open() {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP open timeout')), 5000);
      this.socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP open failed')); }, { once: true });
    });
  }
  on(method, handler) {
    const handlers = this.handlers.get(method) ?? [];
    handlers.push(handler);
    this.handlers.set(method, handlers);
  }
  send(method, params = {}) {
    if (abort.signal.aborted) return Promise.reject(abort.signal.reason);
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP not open'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  rejectPending(error) {
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
    this.pending.clear();
  }
  close() {
    this.rejectPending(new Error('Probe cleanup'));
    this.socket.close();
  }
}

// Decode SOF dimensions rather than assuming screencast metadata is JPEG pixels.
function jpegDimensions(data) {
  const bytes = Buffer.from(data, 'base64');
  assert.ok(bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8, 'JPEG SOI');
  assert.ok(bytes.length < 4 * 1024 * 1024, 'bounded JPEG');
  for (let i = 2; i + 3 < bytes.length;) {
    assert.equal(bytes[i++], 0xff, 'JPEG marker');
    while (bytes[i] === 0xff) i++;
    const marker = bytes[i++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const length = bytes.readUInt16BE(i);
    assert.ok(length >= 2 && i + length <= bytes.length, 'JPEG segment bounds');
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      assert.ok(length >= 8, 'JPEG SOF length');
      return { width: bytes.readUInt16BE(i + 5), height: bytes.readUInt16BE(i + 3), bytes: bytes.length };
    }
    i += length;
  }
  throw new Error('JPEG has no dimensions');
}

async function waitUntil(predicate, ms, label) {
  const deadline = mono() + ms;
  while (!await predicate()) {
    if (spawnError) throw spawnError;
    if (chrome && (chrome.exitCode !== null || chrome.signalCode !== null)) throw new Error(`Chrome exited during ${label}`);
    assert.ok(mono() < deadline, `${label} timed out (${ms}ms)`);
    await delay(25);
  }
}

async function json(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(3000)]) });
  assert.ok(response.ok, `HTTP ${response.status} from disposable Chrome`);
  return response.json();
}

// Inline synthetic fixture: fixed CSS viewport, no network, no user data.
const fixture = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;overflow:hidden;background:#172033}canvas{display:block}
</style><canvas width="800" height="600"></canvas><script>
const ctx=document.querySelector('canvas').getContext('2d');
window.fixture={ticks:0,elapsed:0,done:false};
function paint(t){ctx.fillStyle='#172033';ctx.fillRect(0,0,800,600);
ctx.fillStyle='#ffe466';ctx.fillRect(30+(t/4)%650,240,100,100);
ctx.fillStyle='white';ctx.font='24px sans-serif';ctx.fillText('Synthetic CDP probe',30,60);}
paint(0);
window.animateFixture=()=>{const start=performance.now();
function tick(now){const t=Math.min(now-start,2000);paint(t);fixture.ticks++;
fixture.elapsed=t;if(t<2000)requestAnimationFrame(tick);else fixture.done=true;}
requestAnimationFrame(tick);};
</script>`;

async function evaluate(expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  assert.ok(!result.exceptionDetails, `Fixture JS error: ${JSON.stringify(result.exceptionDetails)}`);
  return result.result.value;
}

async function capture(name, durationMs, animate) {
  const frames = [];
  let stopSent, stopResolved;
  const ackStart = acked;
  const start = mono(), startEpochMs = Date.now();
  const handler = ({ data, metadata, sessionId }) => {
    const receivedMs = mono() - start;
    assert.ok(frames.length < 1200, 'bounded frame observations');
    const dimensions = jpegDimensions(data);
    const sha256 = createHash('sha256').update(Buffer.from(data, 'base64')).digest('hex');
    frames.push({ receivedMs, receivedEpochMs: Date.now(), sessionId, ...dimensions, sha256, metadata });
  };
  cdp.on('Page.screencastFrame', handler);
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 640, maxHeight: 480, everyNthFrame: 1 });
  const startResolvedMs = mono() - start;
  if (animate) await evaluate('animateFixture()');
  await delay(durationMs);
  stopSent = mono() - start;
  await cdp.send('Page.stopScreencast');
  stopResolved = mono() - start;
  // Observe a bounded tail; stop does not promise a new/final frame.
  await delay(750);
  await waitUntil(() => pendingAcks.size === 0, 5000, 'frame ACK drain');
  cdp.handlers.set('Page.screencastFrame', cdp.handlers.get('Page.screencastFrame').filter(item => item !== handler));
  assert.equal(cdp.eventError, undefined, 'valid screencast events');
  assert.deepEqual(ackErrors, [], 'all ACK RPCs succeed');
  assert.ok(frames.length > 0, `${name}: initial frame within ${durationMs}ms`);
  assert.equal(acked - ackStart, frames.length, 'ACK every frame, including stop tail');
  for (const [index, frame] of frames.entries()) {
    assert.equal(frame.width, 640, 'actual JPEG width');
    assert.equal(frame.height, 480, 'actual JPEG height');
    assert.equal(frame.metadata.deviceWidth, 800, 'metadata CSS viewport width');
    assert.equal(frame.metadata.deviceHeight, 600, 'metadata CSS viewport height');
    assert.equal(frame.metadata.pageScaleFactor, 1, 'page scale');
    assert.equal(frame.metadata.offsetTop, 0, 'no top controls');
    assert.equal(frame.metadata.scrollOffsetX, 0, 'no scroll x');
    assert.equal(frame.metadata.scrollOffsetY, 0, 'no scroll y');
    assert.ok(Number.isFinite(frame.metadata.timestamp), 'finite CDP timestamp');
    if (index) assert.ok(frame.receivedMs >= frames[index - 1].receivedMs, 'monotonic receipt clock');
  }
  const epochOffsets = frames.map(frame => frame.receivedEpochMs - frame.metadata.timestamp * 1000);
  const summary = {
    name, requestedDurationMs: durationMs, observedStopSentMs: stopSent,
    startResolvedMs, firstFrameMs: frames[0].receivedMs, lastFrameMs: frames.at(-1).receivedMs,
    frames: frames.length, acked: acked - ackStart, stopResolvedMs: stopResolved,
    distinctJpegs: new Set(frames.map(frame => frame.sha256)).size,
    distinctAckSessionIds: [...new Set(frames.map(frame => frame.sessionId))],
    rawTimestampRegressions: frames.flatMap((frame, index) => index && frame.metadata.timestamp < frames[index - 1].metadata.timestamp
      ? [{ index, previous: frames[index - 1].metadata.timestamp, current: frame.metadata.timestamp,
        regressionMs: (frames[index - 1].metadata.timestamp - frame.metadata.timestamp) * 1000,
        receivedMs: frame.receivedMs }] : []),
    framesAfterStopSent: frames.filter(frame => frame.receivedMs >= stopSent).length,
    framesAfterStopResolved: frames.filter(frame => frame.receivedMs >= stopResolved).length,
    tailObservationMs: 750,
    firstFrame: frames[0], lastFrame: frames.at(-1),
    rawTimestampSpanMs: (frames.at(-1).metadata.timestamp - frames[0].metadata.timestamp) * 1000,
    timestampTimes1000ToReceiptEpochOffsetMs: { min: Math.min(...epochOffsets), max: Math.max(...epochOffsets) },
    nodeStartEpochMs: startEpochMs,
    geometry: '800x600 CSS => 640x480 JPEG, scale 0.8; metadata device dimensions are not encoded JPEG dimensions',
  };
  if (animate) {
    const state = await evaluate('fixture');
    assert.ok(state.done && state.ticks >= 2, 'fixture completed animation then became static');
    assert.ok(frames.filter(frame => frame.receivedMs < 2200).length >= 2, 'multiple animated frames');
    assert.ok(summary.distinctJpegs >= 2, 'animation changes actual encoded content');
    assert.ok(stopSent >= 5000, 'five-second recording window');
    summary.fixture = state;
    summary.framesReceivedAfterAnimationSettledMs2500 = frames.filter(frame => frame.receivedMs > 2500 && frame.receivedMs < stopSent).length;
  }
  report[name] = summary;
}

async function main() {
  assert.ok(Number(process.versions.node.split('.')[0]) >= 26, 'Node >=26 with native fetch/WebSocket required');
  await access(chromePath, constants.X_OK); // Absent/unsupported browser is failure, never skip.
  profile = await mkdtemp(join(tmpdir(), 'recording-cdp-probe-'));
  chrome = spawn(chromePath, [
    '--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--disable-extensions', '--disable-default-apps', '--disable-breakpad', '--disable-crash-reporter',
    '--metrics-recording-only', '--password-store=basic', '--use-mock-keychain', '--window-size=800,600', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  chrome.on('error', error => { spawnError = error; });
  chrome.stderr.on('data', data => { chromeLog = (chromeLog + data).slice(-8192); });
  // Read ONLY the newly created private profile; no existing browser discovery.
  let port;
  await waitUntil(async () => {
    try {
      const text = await readFile(join(profile, 'DevToolsActivePort'), 'utf8');
      port = Number(text.split('\n')[0]);
      return Number.isInteger(port) && port > 0 && port <= 65535;
    } catch { return false; /* startup has not written it yet */ }
  }, 10_000, 'DevToolsActivePort discovery');
  return port;
}

try {
  timeout = setTimeout(() => abort.abort(new Error(`Probe exceeded ${LIMIT_MS}ms`)), LIMIT_MS);
  const discoveredPort = await main();
  const base = `http://127.0.0.1:${discoveredPort}`;
  const version = await json(`${base}/json/version`);
  report.browser = { product: version.Browser, protocol: version['Protocol-Version'] };
  const target = await json(`${base}/json/new?about:blank`, { method: 'PUT' });
  const wsUrl = new URL(target.webSocketDebuggerUrl);
  assert.ok(['127.0.0.1', 'localhost'].includes(wsUrl.hostname), 'own loopback websocket');
  assert.equal(Number(wsUrl.port), discoveredPort, 'own ephemeral port');
  cdp = new CDP(wsUrl.href);
  await cdp.open();
  // Permanent ACK listener also covers malformed events, and gaps between captures.
  cdp.on('Page.screencastFrame', ({ sessionId }) => {
    const ack = cdp.send('Page.screencastFrameAck', { sessionId })
      .then(() => { acked++; }, error => { ackErrors.push(String(error)); })
      .finally(() => pendingAcks.delete(ack));
    pendingAcks.add(ack);
  });
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `data:text/html;charset=utf-8,${encodeURIComponent(fixture)}` });
  await waitUntil(async () => await evaluate('typeof window.animateFixture === "function"'), 5000, 'synthetic fixture readiness');
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await delay(250); // Ensure static page was painted before starting the screencast.
  report.viewport = await evaluate('({width: innerWidth, height: innerHeight, dpr: devicePixelRatio})');
  assert.deepEqual(report.viewport, { width: 800, height: 600, dpr: 1 });
  await capture('staticInitial', 3000, false);
  await capture('animatedThenStatic', 5000, true);
  report.clock = 'Node performance.now() is the receipt/deadline monotonic clock; Date.now() and raw CDP timestamp are retained separately. Raw CDP timestamps can regress; no cross-clock subtraction defines elapsed time. Epoch offsets are observations, not a clock-origin guarantee.';
  report.ackedTotal = acked;
  assert.deepEqual(ackErrors, []);
  assert.equal(acked, report.staticInitial.frames + report.animatedThenStatic.frames, 'no unaccounted frame events');
  report.stop = '750ms tail observation per capture; no assertion that stop produces a final frame, or that an observed empty tail guarantees future behavior.';
} catch (error) {
  failed = true;
  report.error = error.stack ?? String(error);
} finally {
  clearTimeout(timeout);
  abort.abort();
  cdp?.close();
  if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
    chrome.kill('SIGTERM'); // Only this spawned process, never killall/pkill.
    await Promise.race([new Promise(resolve => chrome.once('exit', resolve)), sleep(2000)]);
    if (chrome.exitCode === null && chrome.signalCode === null) {
      chrome.kill('SIGKILL');
      await Promise.race([new Promise(resolve => chrome.once('exit', resolve)), sleep(2000)]);
    }
    if (chrome.exitCode === null && chrome.signalCode === null) { failed = true; report.cleanupError = 'Spawned Chrome did not exit'; }
  }
  if (profile) {
    try { await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
    catch (error) { failed = true; report.cleanupError = String(error); }
  }
  report.cleanup = { spawnedProcessExited: !chrome || chrome.exitCode !== null || chrome.signalCode !== null, privateProfileRemoved: profile ? !report.cleanupError : true };
  if (failed) report.chromeStderrTail = chromeLog;
}
report.result = failed ? 'FAIL' : 'PASS';
console.log(JSON.stringify(report, null, 2));
process.exitCode = failed ? 1 : 0;
