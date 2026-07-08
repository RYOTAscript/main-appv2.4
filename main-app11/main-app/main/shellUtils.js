const { exec, execSync } = require('child_process');

// timeoutMs (optional): kill the child and resolve with ok:false if it runs
// longer than this. Left unset (0) means wait indefinitely, preserving the
// original behaviour for existing callers.
function runCmd(cmd, timeoutMs = 0) {
  return new Promise((resolve) => {
    exec(cmd, { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 * 8 }, (err, stdout, stderr) => {
      const ok = !err;
      resolve({ ok, stdout, stderr, code: err ? err.code : 0 });
    });
  });
}

function runCmdSync(cmd) {
  try {
    const out = execSync(cmd, { windowsHide: true, encoding: 'utf-8' });
    return { ok: true, stdout: out };
  } catch (e) {
    return { ok: false, stdout: e.stdout || '', stderr: e.stderr || '', code: e.status };
  }
}

module.exports = { runCmd, runCmdSync };
