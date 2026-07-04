// ── SPARKLINE HISTORY ──
const HISTORY = { cpu: new Array(20).fill(0), gpu: new Array(20).fill(0), ram: new Array(20).fill(0), disk: new Array(20).fill(0) };

// ── PAGE NAVIGATION ──
let currentPage = 'dashboard';
const navItems = document.querySelectorAll('.nav-item');
const pages = document.querySelectorAll('.page');

navItems.forEach(item => {
  item.addEventListener('click', () => {
    const target = item.dataset.page;
    if (target === currentPage) return;
    navItems.forEach(n => n.classList.remove('active'));
    item.classList.add('active');
    pages.forEach(p => p.classList.remove('active'));
    document.getElementById(`page-${target}`).classList.add('active');
    currentPage = target;
  });
});

// ── METRICS UPDATE ──
window.electronAPI.onMetrics((data) => {
  updateSpark('cpu', data.cpu, '%');
  updateSpark('gpu', data.gpu, '%');
  updateSpark('ram', data.ram, '%');
  updateSpark('disk', data.disk, '%');

  document.getElementById('valAvail').textContent = data.memAvail.toFixed(1);
  document.getElementById('valProcs').textContent = data.activeProcs ?? '–';
  document.getElementById('valNetDown').textContent = data.netRecv.toFixed(0);
  document.getElementById('valNetUp').textContent = data.netSent.toFixed(0);
  document.getElementById('valPlan').textContent = data.powerPlan;
  document.getElementById('valGameMode').textContent = data.gameMode ? '✓ ON' : '✗ OFF';
  document.getElementById('valUptime').textContent = data.uptime;

  if (data.gameMode) {
    document.getElementById('gmSwitch').classList.add('on');
    document.getElementById('gmDesc').textContent = 'Currently ON';
  } else {
    document.getElementById('gmSwitch').classList.remove('on');
    document.getElementById('gmDesc').textContent = 'Currently OFF';
  }
});

function updateSpark(key, val, suffix) {
  const el = document.getElementById(`val${key.charAt(0).toUpperCase() + key.slice(1)}`);
  if (el) el.textContent = val.toFixed(1);
  HISTORY[key].push(val);
  HISTORY[key] = HISTORY[key].slice(-20);
  drawSpark(`spark${key.charAt(0).toUpperCase() + key.slice(1)}`, HISTORY[key], getColor(key));
}

function getColor(key) {
  const map = { cpu: '#4d9eff', gpu: '#d14dff', ram: '#00ffa3', disk: '#ffab4d' };
  return map[key] || '#fff';
}

function drawSpark(canvasId, data, color) {
  const c = document.getElementById(canvasId);
  if (!c) return;
  const ctx = c.getContext('2d');
  const w = c.width, h = c.height;
  ctx.clearRect(0, 0, w, h);
  if (data.length < 2) return;

  const mn = Math.min(...data), mx = Math.max(...data);
  const rng = mx - mn || 1;

  ctx.beginPath();
  ctx.lineWidth = 1.5;
  for (let i = 0; i < data.length; i++) {
    const x = (i / (data.length - 1)) * w;
    const y = h - 4 - ((data[i] - mn) / rng) * (h - 8);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = color;
  ctx.stroke();

  const lastX = w, lastY = h - 4 - ((data[data.length - 1] - mn) / rng) * (h - 8);
  ctx.beginPath();
  ctx.arc(lastX, lastY, 3, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

// ── PROGRESS & LOGS ──
window.electronAPI.onProgress((data) => {
  document.getElementById('progLabel').textContent = data.msg;
  document.getElementById('progPct').textContent = Math.round(data.pct * 100) + '%';
  document.getElementById('progFill').style.width = (data.pct * 100) + '%';
  document.getElementById('statusText').textContent = data.msg;
});

const logBox = document.getElementById('logBox');
window.electronAPI.onLog((data) => {
  const line = document.createElement('div');
  line.textContent = `[${new Date().toLocaleTimeString()}] ${data.msg}`;
  line.className = data.level === 'error' ? 'log-error' : data.level === 'warn' ? 'log-warn' : 'log-info';
  logBox.appendChild(line);
  logBox.scrollTop = logBox.scrollHeight;
});

// ── ACTIONS ──
async function runBoost(type) {
  document.getElementById('statusText').textContent = 'Running boost...';
  const result = await window.electronAPI.runBoost(type);
  showBoostResult(result);
}

async function runAction(action) {
  document.getElementById('statusText').textContent = 'Running...';
  await window.electronAPI.runAction(action);
  document.getElementById('statusText').textContent = 'Done';
}

async function toggleGameMode() {
  const on = await window.electronAPI.toggleGameMode();
  document.getElementById('gmSwitch').classList.toggle('on', on);
  document.getElementById('gmDesc').textContent = on ? 'Currently ON' : 'Currently OFF';
}

async function batterySave() { await window.electronAPI.batterySave(); }
async function batteryRevert() { await window.electronAPI.batteryRevert(); }

async function toggleOverlay() {
  const active = await window.electronAPI.toggleOverlay();
  const btn = document.getElementById('overlayBtn');
  if (active) { btn.textContent = '● Close Overlay'; btn.style.color = 'var(--red)'; }
  else { btn.textContent = '● FPS Overlay'; btn.style.color = 'var(--green)'; }
}

// ── KILL CONFIRMATION ──
let confirmTimer = null;
function confirmKill(type) {
  if (confirmTimer) { clearTimeout(confirmTimer); confirmTimer = null; }
  const ok = confirm(`Are you sure you want to run ${type} kill? This will close background applications.`);
  if (!ok) return;
  if (type === 'standard') window.electronAPI.killStandard();
  if (type === 'discord') window.electronAPI.killDiscord();
  if (type === 'nuke') window.electronAPI.killNuke();
}

// ── BOOST RESULT ──
function showBoostResult({ before, after, label }) {
  const panel = document.getElementById('resultPanel');
  const fpsBefore = calculateFps(before.gpu, before.cpu, before.disk, before.ram);
  const fpsAfter = calculateFps(after.gpu, after.cpu, after.disk, after.ram);

  const rows = [
    { name: 'CPU', b: before.cpu, a: after.cpu, unit: '%', lower: true, color: '#4d9eff' },
    { name: 'RAM', b: before.ram, a: after.ram, unit: '%', lower: true, color: '#00ffa3' },
    { name: 'Disk', b: before.disk, a: after.disk, unit: '%', lower: true, color: '#ffab4d' },
    { name: 'FPS', b: fpsBefore, a: fpsAfter, unit: ' fps', lower: false, color: '#8cffb3' }
  ];

  let html = `<div class="card" style="margin:16px 0"><div style="height:2px;background:var(--green)"></div><div style="padding:10px 14px"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><span style="font-size:9px;font-weight:700;color:var(--green)">⚡ BOOST RESULT</span><span style="font-size:7px;color:var(--dim)">${new Date().toLocaleTimeString()}</span></div>`;
  for (const r of rows) {
    const delta = r.a - r.b;
    const improved = r.lower ? (delta < 0) : (delta > 0);
    const neutral = Math.abs(delta) < 0.5;
    const deltaCol = neutral ? 'var(--dim)' : improved ? 'var(--green)' : 'var(--red)';
    const deltaStr = neutral ? '= no change' : (delta < 0 ? `▼ ${Math.abs(delta).toFixed(1)}${r.unit}` : `▲ ${Math.abs(delta).toFixed(1)}${r.unit}`);
    html += `<div style="display:flex;align-items:center;gap:8px;padding:3px 0;font-size:9px;font-family:Consolas,monospace"><div style="width:3px;height:16px;background:${r.color}"></div><span style="width:40px;color:var(--dim);font-weight:700">${r.name}</span><span style="color:var(--dim)">${r.b.toFixed(1)}${r.unit}</span><span style="color:var(--dim2)">→</span><span style="color:var(--white);font-weight:700">${r.a.toFixed(1)}${r.unit}</span><span style="color:${deltaCol};font-weight:700">${deltaStr}</span></div>`;
  }
  html += '</div></div>';
  panel.innerHTML = html;
}

function calculateFps(gpu, cpu, disk, ram) {
  const weighted = (gpu * 0.4 + cpu * 0.3 + disk * 0.2 + ram * 0.1);
  const factor = Math.max(0, (100 - weighted) / 100);
  return Math.max(0, Math.min(160, Math.round(30 + factor * 130)));
}

// ── STARTUP CHECKUP ──
(async function init() {
  const checks = await window.electronAPI.startupCheck();
  const box = document.getElementById('readinessBox');
  if (!checks || !checks.length) { box.textContent = 'Diagnostics unavailable.'; return; }
  const colorMap = { green: 'var(--green)', yellow: 'var(--yellow)', red: 'var(--red)' };
  box.innerHTML = checks.map(c => `<div style="display:flex;justify-content:space-between"><span style="color:var(--dim)">${c.label}</span><span style="color:${colorMap[c.color] || 'var(--dim)'};font-weight:700">${c.text}</span></div>`).join('');
})();

// Initial sparkline draws
['cpu', 'gpu', 'ram', 'disk'].forEach(k => drawSpark(`spark${k.charAt(0).toUpperCase() + k.slice(1)}`, HISTORY[k], getColor(k)));
