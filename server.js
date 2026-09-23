const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 10000;
const OPEN_MIC_DEBOUNCE_MS = 4000;

const state = {
  startedAt: Date.now(),
  extension: { connected: false, since: null, deviceLabel: null, lastAudioAt: null, audioCount: 0, speechCount: 0 },
  wrappers: new Map(),
  events: [],
};

function pushEvent(type, detail) {
  state.events.push({ ts: Date.now(), type, detail: detail || null });
  if (state.events.length > 500) state.events.shift();
  console.log('[evt]', type, detail ? JSON.stringify(detail) : '');
}

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(INDEX_HTML);
    return;
  }
  if (req.url === '/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      uptimeMs: Date.now() - state.startedAt,
      extension: state.extension,
      wrapperCount: state.wrappers.size,
      wrappers: [...state.wrappers.values()],
      events: state.events.slice(-200).reverse()
    }));
    return;
  }
  if (req.url === '/clear' && req.method === 'POST') {
    state.events.length = 0;
    pushEvent('log_cleared', {});
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  res.writeHead(404); res.end('not found');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  ws.role = null;
  ws.lastOpenMicAt = 0;
  const ip = req.socket.remoteAddress;
  pushEvent('ws_open', { ip });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.role) {
      ws.role = msg.role;
      if (msg.role === 'extension') {
        state.extension.connected = true;
        state.extension.since = Date.now();
        pushEvent('extension_connected', { ip });
      } else if (msg.role === 'wrapper') {
        state.wrappers.set(ws, { since: Date.now(), ip });
        pushEvent('wrapper_connected', { ip });
      }
      return;
    }

    if (ws.role === 'extension' && msg.type === 'ping') return;

    if (ws.role === 'extension' && msg.type === 'audio') {
      state.extension.lastAudioAt = Date.now();
      state.extension.audioCount++;
      if (!msg.speech) return;
      state.extension.speechCount++;

      const now = Date.now();
      if (now - ws.lastOpenMicAt < OPEN_MIC_DEBOUNCE_MS) return;
      ws.lastOpenMicAt = now;

      let delivered = 0;
      for (const c of wss.clients) {
        if (c.role === 'wrapper' && c.readyState === WebSocket.OPEN) {
          c.send(JSON.stringify({ type: 'open_mic', ts: now }));
          delivered++;
        }
      }
      pushEvent('open_mic', { delivered, b64Len: (msg.pcmBase64 || '').length });
    }
  });

  ws.on('close', () => {
    if (ws.role === 'extension') {
      state.extension.connected = false;
      state.extension.since = null;
      pushEvent('extension_disconnected', { ip });
    } else if (ws.role === 'wrapper') {
      state.wrappers.delete(ws);
      pushEvent('wrapper_disconnected', { ip });
    }
    pushEvent('ws_close', { ip });
  });

  ws.on('error', (e) => pushEvent('ws_error', { msg: e.message }));
});

server.listen(PORT, () => console.log('[vad-bridge] http+ws on', PORT));

const INDEX_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>VAD Bridge</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { color-scheme: dark; }
  body { font: 14px ui-monospace, Menlo, Consolas, monospace; background:#0e1116; color:#e6edf3; margin:0; padding:24px; }
  h1 { font-size:16px; margin:0 0 4px; }
  .muted { color:#8b949e; }
  .grid { display:grid; grid-template-columns: 1fr 1fr; gap:16px; margin:16px 0 24px; }
  .card { background:#161b22; border:1px solid #30363d; border-radius:8px; padding:16px; }
  .card h2 { font-size:12px; letter-spacing:.08em; text-transform:uppercase; color:#8b949e; margin:0 0 8px; }
  .big { font-size:22px; font-weight:600; }
  .dot { display:inline-block; width:9px; height:9px; border-radius:50%; margin-right:6px; vertical-align:middle; background:#f85149; }
  .dot.on { background:#3fb950; box-shadow:0 0 8px #3fb95088; }
  .toolbar { display:flex; gap:8px; align-items:center; margin-bottom:8px; flex-wrap:wrap; }
  .toolbar button, .toolbar select {
    background:#21262d; color:#e6edf3; border:1px solid #30363d; border-radius:6px;
    padding:6px 10px; font: inherit; cursor:pointer;
  }
  .toolbar button:hover { background:#30363d; }
  .logbox {
    background:#0b0f14; border:1px solid #21262d; border-radius:6px;
    max-height:420px; overflow:auto; padding:8px;
  }
  .row { display:grid; grid-template-columns: 84px 170px 1fr; gap:10px; padding:3px 4px; border-radius:4px; font-size:13px; }
  .row:hover { background:#161b22; }
  .t { color:#8b949e; }
  .k { color:#79c0ff; }
  .d { color:#a5d6ff; word-break:break-all; }
  .row.open_mic .k { color:#3fb950; font-weight:600; }
  .row.ws_open .k, .row.ws_close .k { color:#6e7681; }
  .row.extension_connected .k, .row.wrapper_connected .k { color:#d2a8ff; }
  .row.extension_disconnected .k, .row.wrapper_disconnected .k { color:#ffa657; }
  .row.ws_error .k { color:#f85149; }
</style>
</head>
<body>
  <h1>VAD Bridge <span class="muted">— live</span></h1>
  <div class="muted" id="uptime">uptime —</div>

  <div class="grid">
    <div class="card">
      <h2>Extension (PC capture)</h2>
      <div class="big"><span class="dot" id="extDot"></span><span id="extStatus">connecting…</span></div>
      <div class="muted" id="extDevice" style="margin-top:6px">device: —</div>
      <div class="muted" id="extLast" style="margin-top:2px">last audio: —</div>
      <div class="muted" id="extCount" style="margin-top:2px">chunks: 0</div>
      <div class="muted" id="extSpeech" style="margin-top:2px">speech: 0</div>
    </div>

    <div class="card">
      <h2>Wrappers (phones)</h2>
      <div class="big"><span class="dot" id="wrapDot"></span><span id="wrapCount">0</span> connected</div>
      <div class="muted" id="wrapList" style="margin-top:8px">—</div>
    </div>
  </div>

  <div class="card">
    <div class="toolbar">
      <strong>Logs</strong>
      <select id="filter">
        <option value="">all events</option>
        <option value="open_mic">open_mic only</option>
        <option value="extension_connected">extension connect</option>
        <option value="wrapper_connected">wrapper connect</option>
        <option value="ws_error">errors only</option>
      </select>
      <label class="muted"><input type="checkbox" id="autoscroll" checked> auto-scroll</label>
      <button id="clear">Clear log</button>
      <span class="muted" id="countLabel"></span>
    </div>
    <div class="logbox" id="logbox">
      <div class="muted">waiting for events…</div>
    </div>
  </div>

<script>
function fmtTs(ts){ const d=new Date(ts); return d.toTimeString().slice(0,8); }
function fmtAgo(ts){ if(!ts) return '—'; const s=Math.floor((Date.now()-ts)/1000);
  if(s<60) return s+'s ago'; const m=Math.floor(s/60); if(m<60) return m+'m ago';
  return Math.floor(m/60)+'h ago'; }
function fmtUptime(ms){ const s=Math.floor(ms/1000); const h=Math.floor(s/3600), m=Math.floor((s%3600)/60);
  return h+'h '+m+'m '+(s%60)+'s'; }

document.getElementById('clear').onclick = async () => {
  await fetch('/clear', { method: 'POST' });
};

let lastEventCount = 0;

async function tick(){
  try {
    const r = await fetch('/state'); const s = await r.json();

    document.getElementById('uptime').textContent = 'uptime ' + fmtUptime(s.uptimeMs);

    const e = s.extension;
    document.getElementById('extDot').className = 'dot' + (e.connected?' on':'');
    document.getElementById('extStatus').textContent = e.connected ? 'connected' : 'disconnected';
    document.getElementById('extDevice').textContent = 'device: ' + (e.deviceLabel || '—');
    document.getElementById('extLast').textContent = 'last audio: ' + fmtAgo(e.lastAudioAt);
    document.getElementById('extCount').textContent = 'chunks: ' + e.audioCount;
    document.getElementById('extSpeech').textContent = 'speech: ' + e.speechCount;

    document.getElementById('wrapDot').className = 'dot' + (s.wrapperCount>0?' on':'');
    document.getElementById('wrapCount').textContent = s.wrapperCount;
    document.getElementById('wrapList').innerHTML = s.wrappers.length
      ? s.wrappers.map(w => w.ip + ' <span class="muted">(' + fmtAgo(w.since) + ')</span>').join('<br>')
      : '—';

    const filter = document.getElementById('filter').value;
    let rows = s.events;
    if (filter) rows = rows.filter(ev => ev.type === filter);
    const total = rows.length;
    rows = rows.slice(0, 200);

    document.getElementById('countLabel').textContent = total + ' event' + (total===1?'':'s');
    document.getElementById('logbox').innerHTML = rows.length
      ? rows.map(ev =>
          '<div class="row ' + ev.type + '">' +
          '<span class="t">' + fmtTs(ev.ts) + '</span>' +
          '<span class="k">' + ev.type + '</span>' +
          '<span class="d">' + (ev.detail ? JSON.stringify(ev.detail) : '') + '</span>' +
          '</div>').join('')
      : '<div class="muted">no events</div>';

    if (document.getElementById('autoscroll').checked && s.events.length !== lastEventCount) {
      document.getElementById('logbox').scrollTop = 0;
    }
    lastEventCount = s.events.length;

  } catch (err) {
    document.getElementById('uptime').textContent = 'connection to server failed';
  }
}
tick();
setInterval(tick, 1500);
</script>
</body>
</html>`;