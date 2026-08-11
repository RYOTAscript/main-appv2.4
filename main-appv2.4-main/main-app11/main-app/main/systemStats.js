const { ipcMain } = require('electron');
const os = require('os');

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

function init() {
  ipcMain.handle('get-system-stats', async () => {
    const cpu = await getCpuUsagePercent();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const ram = Math.round(((totalMem - freeMem) / totalMem) * 100);
    return { cpu, ram };
  });
}

module.exports = { init };
