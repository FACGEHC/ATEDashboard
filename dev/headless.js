// Headless Chrome driver over the DevTools protocol (no npm packages; Node 22+ for the built-in WebSocket).
// Opens a URL, relays console messages, waits until document.title equals --until (or the timeout), then
// saves a screenshot. Unlike --virtual-time-budget this waits in real time, so Web Workers get to finish.
//
//   node dev/headless.js --url "file:///.../dev/ui-test.html?coil=1.5T%20GEM%20PA" --until "ui ready" --out shot.png [--timeout 120000] [--width 1500 --height 1050]
//
// Chrome is found via CHROME env var or the default install path.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const url = args.url, until = args.until || 'ui ready', out = args.out || 'headless.png';
const timeout = +(args.timeout || 120000), width = +(args.width || 1500), height = +(args.height || 1050);
if (!url) { console.error('usage: node dev/headless.js --url <url> [--until <title>] [--out <png>] [--timeout ms]'); process.exit(2); }
const chrome = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const port = 9000 + Math.floor(Math.random() * 1000);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-headless-'));
const proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check',
  '--allow-file-access-from-files', '--disable-gpu', '--hide-scrollbars', '--window-size=' + width + ',' + height, 'about:blank'], { stdio: 'ignore' });
let exitCode = 1;
function cleanup() { try { proc.kill(); } catch (e) { /* ignore */ } setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ } process.exit(exitCode); }, 300); }
process.on('SIGINT', cleanup);

async function waitForDevTools() {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/json/version'); if (r.ok) return await r.json(); } catch (e) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('Chrome DevTools endpoint did not come up');
}

(async () => {
  await waitForDevTools();
  const target = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result); return; }
    if (m.method === 'Runtime.consoleAPICalled') {
      const txt = m.params.args.map(a => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' ');
      console.log('[' + m.params.type + '] ' + txt);
    } else if (m.method === 'Runtime.exceptionThrown') {
      console.log('[exception] ' + (m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text));
    }
  };
  const send = (method, params) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params: params || {} })); });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  // console messages from the iframe too
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
  const t0 = Date.now();
  await send('Page.navigate', { url });
  let title = '';
  while (Date.now() - t0 < timeout) {
    const r = await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
    title = r.result.value;
    if (title === until) break;
    await new Promise(r => setTimeout(r, 500));
  }
  console.log('title "' + title + '" after ' + (Date.now() - t0) + ' ms' + (title === until ? '' : ' (TIMEOUT waiting for "' + until + '")'));
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('screenshot ' + out);
  exitCode = title === until ? 0 : 3;
  ws.close();
  cleanup();
})().catch(e => { console.error('headless error:', e.message); cleanup(); });
