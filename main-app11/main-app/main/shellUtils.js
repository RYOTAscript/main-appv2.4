const { exec, execSync } = require('child_process');

function runCmd(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { windowsHide: true }, (err, stdout, stderr) => {
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
