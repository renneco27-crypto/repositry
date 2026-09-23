const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 10000;

// ---- config ----
const SPEECH_THRESHOLD     = 0.5;
const MIN_SPEECH_MS        = 200;
const OPEN_MIC_DEBOUNCE_MS = 1500;

// ---- state for UI ----
const state = {
  startedAt: Date.now(),
  extension: { connected: false, since: null, deviceLabel: null, lastAudioAt: null, audioCount: 0 },
  wrappers: new Map(), // ws -> { since, ip }
  events: [],          // ring of last 100 events
};

function pushEvent(type, detail) {
  state.events.push({ ts: Date.now(), type, detail });
  if (state.events.length > 100) state.events.shift();
}

// ---- HTTP server (serves the UI) ----
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
      events: state.events.slice(-40).reverse()
    }));
    return;
  }
  res.writeHead(404); res.end('not found');
});

// ---- WebSocket server on the same HTTP server ----
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  ws.role = null;
  ws.lastOpenMicAt = 0;
  const ip = req.socket.remoteAddress;
  pushEvent('ws_open', { ip });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // role registration
    if (msg.role) {
      ws.role = msg.role;
      if (msg.role === 'extension') {
        state.extension.connected = true;
        state.extension.since = Date.now();
        state.extension.deviceLabel = msg.deviceLabel || null;
        pushEvent('extension_connected', { deviceLabel: msg.deviceLabel });
      } else if (msg.role === 'wrapper') {
        state.wrappers.set(ws, { since: Date.now(), ip });
        pushEvent('wrapper_connected', { ip });
      }
      return;
    }

    // audio from extension
    if (ws.role === 'extension' && msg.type === 'audio') {
      state.extension.lastAudioAt = Date.now();
      state.extension.audioCount++;
      if (!msg.speech) return;

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
      pushEvent('extension_disconnected', {});
    } else if (ws.role === 'wrapper') {
      state.wrappers.delete(ws);
      pushEvent('wrapper_disconnected', { ip });
    }
    pushEvent('ws_close', { ip });
  });

  ws.on('error', (e) => pushEvent('ws_error', { msg: e.message }));
});

server.listen(PORT, () => console.log('[vad-bridge] http+ws on', PORT));

// ---- the UI ----
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
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid #21262d; }
  th { color:#8b949e; font-weight:500; }
  .evt { font-size:12px; }
  .evt .t { color:#8b949e; }
  .evt .k { color:#79c0ff; }
  .evt .d { color:#a5d6ff; }
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
    </div>

    <div class="card">
      <h2>Wrappers (phones)</h2>
      <div class="big"><span class="dot" id="wrapDot"></span><span id="wrapCount">0</span> connected</div>
      <div class="muted" id="wrapList" style="margin-top:8px">—</div>
    </div>
  </div>

  <div class="card">
    <h2>Events (last 40)</h2>
    <table>
      <thead><tr><th>time</th><th>event</th><th>detail</th></tr></thead>
      <tbody id="events"><tr><td colspan="3" class="muted">waiting…</td></tr></tbody>
    </table>
  </div>

<script>
function fmtTs(ts){ const d=new Date(ts); return d.toTimeString().slice(0,8); }
function fmtAgo(ts){ if(!ts) return '—'; const s=Math.floor((Date.now()-ts)/1000);
  if(s<60) return s+'s ago'; const m=Math.floor(s/60); if(m<60) return m+'m ago';
  return Math.floor(m/60)+'h ago'; }
function fmtUptime(ms){ const s=Math.floor(ms/1000); const h=Math.floor(s/3600), m=Math.floor((s%3600)/60);
  return h+'h '+m+'m '+(s%60)+'s'; }

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

    document.getElementById('wrapDot').className = 'dot' + (s.wrapperCount>0?' on':'');
    document.getElementById('wrapCount').textContent = s.wrapperCount;
    document.getElementById('wrapList').innerHTML = s.wrappers.length
      ? s.wrappers.map(w => w.ip + ' <span class="muted">(' + fmtAgo(w.since) + ')</span>').join('<br>')
      : '—';

    const rows = s.events.map(ev =>
      '<tr class="evt"><td class="t">'+fmtTs(ev.ts)+'</td><td class="k">'+ev.type+'</td>'+
      '<td class="d">'+ (ev.detail ? JSON.stringify(ev.detail) : '') +'</td></tr>'
    ).join('');
    document.getElementById('events').innerHTML = rows || '<tr><td colspan="3" class="muted">no events</td></tr>';
  } catch (err) {
    document.getElementById('uptime').textContent = 'connection to server failed';
  }
}
tick();
setInterval(tick, 2000);
</script>
</body>
</html>`;