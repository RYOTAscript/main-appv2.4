const { ipcMain } = require('electron');
const os = require('os');
const { isWindows } = require('./platform');
// runFile, not runCmd: runCmd takes a COMMAND STRING plus a timeout, while
// this needs an explicit argv array (the script is one argument containing
// newlines and quotes). Both resolve { ok, stdout, stderr, code }.
const { runFile } = require('./shellUtils');

function sampleCpu() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    for (const type in cpu.times) total += cpu.times[type];
    idle += cpu.times.idle;
  }
  return { idle, total };
}

function getCpuUsagePercent() {
  return new Promise((resolve) => {
    const start = sampleCpu();
    setTimeout(() => {
      const end = sampleCpu();
      const idleDiff = end.idle - start.idle;
      const totalDiff = end.total - start.total;
      const usage = totalDiff > 0 ? Math.round((1 - idleDiff / totalDiff) * 100) : 0;
      resolve(Math.min(100, Math.max(0, usage)));
    }, 150);
  });
}

// ── Battery and disk ─────────────────────────────────────────────────────────
// Deliberately NOT part of get-system-stats. That handler is polled about once a
// second by the dashboard, and these need PowerShell — putting a process spawn
// on that path would be a performance disaster. Separate handler, and cached,
// because neither number changes meaningfully second to second.
let extraCache = null;
let extraCachedAt = 0;
const EXTRA_TTL_MS = 30000;

async function readExtra() {
  if (!isWindows) return { battery: null, disk: null };
  // One PowerShell call for both: two spawns cost more than the query does.
  // -ErrorAction SilentlyContinue because a desktop simply has no battery, and
  // that is a normal answer here rather than a failure.
  const script = [
    '$b = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1',
    // Get-PSDrive rather than a Win32_LogicalDisk filter: the filter needs
    // nested quotes ("DeviceID='C:'") inside an already-quoted argument, and
    // that quoting is a reliable way to break the command later.
    '$d = Get-PSDrive -Name C -ErrorAction SilentlyContinue',
    '$o = [ordered]@{',
    '  percent = if ($b) { [int]$b.EstimatedChargeRemaining } else { $null }',
    '  charging = if ($b) { [bool]($b.BatteryStatus -eq 2) } else { $false }',
    '  minutesLeft = if ($b -and $b.EstimatedRunTime -and $b.EstimatedRunTime -lt 71582788) { [int]$b.EstimatedRunTime } else { $null }',
    '  freeGb = if ($d) { [math]::Round($d.Free / 1GB, 1) } else { $null }',
    '  totalGb = if ($d) { [math]::Round(($d.Free + $d.Used) / 1GB, 1) } else { $null }',
    '}',
    'ConvertTo-Json -InputObject $o -Compress'
    // Newlines, NOT '; '. A semicolon straight after `[ordered]@{` closes the
    // hash literal and the whole script fails to parse.
  ].join('\n');

  try {
    const res = await runFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], 8000);
    if (!res || !res.ok || !res.stdout) return { battery: null, disk: null };
    const parsed = JSON.parse(String(res.stdout).trim());
    return {
      battery: parsed.percent === null || parsed.percent === undefined ? null : {
        percent: Number(parsed.percent),
        charging: !!parsed.charging,
        minutesLeft: parsed.minutesLeft === null ? null : Number(parsed.minutesLeft)
      },
      disk: parsed.freeGb === null || parsed.freeGb === undefined ? null : {
        freeGb: Number(parsed.freeGb),
        totalGb: Number(parsed.totalGb)
      }
    };
  } catch (e) {
    // A machine that cannot answer is not an error worth surfacing; the caller
    // reports "couldn't read" and the assistant says so.
    return { battery: null, disk: null };
  }
}

function init() {
  ipcMain.handle('get-system-stats', async () => {
    const cpu = await getCpuUsagePercent();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const ram = Math.round(((totalMem - freeMem) / totalMem) * 100);
    return { cpu, ram };
  });

  ipcMain.handle('get-system-extra', async () => {
    const now = Date.now();
    if (extraCache && now - extraCachedAt < EXTRA_TTL_MS) return extraCache;
    extraCache = await readExtra();
    extraCachedAt = now;
    return extraCache;
  });
}

module.exports = { init };
