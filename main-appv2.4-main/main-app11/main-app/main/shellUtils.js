const { exec, execSync, execFile } = require('child_process');

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

// Run an executable with an explicit argv array (no shell) — the injection-safe
// counterpart to runCmd. Prefer this whenever any argument is dynamic (e.g. the
// macOS `defaults`/`blueutil`/`displayplacer` helpers), so values never need
// shell-escaping. Same resolve-only { ok, stdout, stderr, code } contract.
function runFile(file, args = [], timeoutMs = 0) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 * 8 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', code: err ? err.code : 0 });
    });
  });
}

module.exports = { runCmd, runCmdSync, runFile };
