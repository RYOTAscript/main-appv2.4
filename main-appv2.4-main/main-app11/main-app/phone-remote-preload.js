// Phone Remote socket — the preload of a hidden window that holds the relay
// WebSocket for main/phoneRemote.js. It lives in a Chromium window, not Node,
// so the connection goes through the OS certificate store and proxy.
//
// Exposes NOTHING to the page (there is no page script): main sends it
// connect / send / close, and it reports open / message / close back. Every
// message main gets from here is checked against this window's webContents.
const { ipcRenderer } = require('electron');

const PING_MS = 25000;   // the relay answers these without waking up
let ws = null;
let pingTimer = null;

function report(ev) {
    ipcRenderer.send('phone-remote:socket-event', ev);
}

function shut() {
    clearInterval(pingTimer);
    pingTimer = null;
    if (!ws) return;
    const old = ws;
    ws = null;
    try { old.close(1000, 'bye'); } catch (e) { /* already closing */ }
}

function open(url) {
    shut();
    let sock;
    try {
        sock = new WebSocket(url);
    } catch (e) {
        report({ type: 'close', code: 0, reason: 'bad url' });
        return;
    }
    ws = sock;
    sock.onopen = () => {
        if (ws !== sock) return;
        report({ type: 'open' });
        pingTimer = setInterval(() => {
            if (sock.readyState === WebSocket.OPEN) sock.send('{"t":"ping"}');
        }, PING_MS);
    };
    sock.onmessage = (ev) => {
        if (ws === sock && typeof ev.data === 'string') report({ type: 'message', data: ev.data });
    };
    sock.onclose = (ev) => {
        if (ws !== sock) return;
        clearInterval(pingTimer);
        pingTimer = null;
        ws = null;
        report({ type: 'close', code: ev.code, reason: ev.reason });
    };
    // An error is always followed by a close, which is what gets reported.
    sock.onerror = () => {};
}

ipcRenderer.on('phone-remote:socket', (_event, cmd) => {
    if (!cmd || typeof cmd !== 'object') return;
    if (cmd.op === 'connect' && typeof cmd.url === 'string') open(cmd.url);
    else if (cmd.op === 'send' && typeof cmd.text === 'string') {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(cmd.text);
    } else if (cmd.op === 'close') shut();
});

window.addEventListener('DOMContentLoaded', () => ipcRenderer.send('phone-remote:socket-ready'));
