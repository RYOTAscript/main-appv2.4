// One relay room: one PC ("host") and up to four phones, connected through the
// WebSocket Hibernation API so an idle room costs nothing while it waits —
// keep-alive pings are answered by the runtime without waking the object.
//
// What it does, and all it does:
//   • passes sealed envelopes PC → every phone, and phone → PC;
//   • tells the PC how many phones are watching ({"t":"peers","phones":n}),
//     because the PC only streams while someone is;
//   • tells each phone whether the PC is there ({"t":"host","online":bool});
//   • keeps it fair: one PC, four phones, 64 KiB messages, a rate limit.
// It stores nothing.

import { LIMITS, CLOSE, TokenBucket, isEnvelope, replyCloseCode } from './rules.js';

function safeSend(ws, text) {
  try { ws.send(text); } catch { /* already gone */ }
}

function safeClose(ws, code, reason) {
  try { ws.close(code, reason); } catch { /* already gone */ }
}

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.buckets = new Map();   // per socket; in memory only, so a wake starts fresh
    if (typeof WebSocketRequestResponsePair === 'function') {
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
    }
  }

  async fetch(request) {
    const role = new URL(request.url).searchParams.get('role') === 'host' ? 'host' : 'phone';
    const [client, server] = Object.values(new WebSocketPair());
    this.accept(server, role);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Takes a socket in (split from fetch so the rules run without the runtime). */
  accept(ws, role) {
    if (role === 'host') {
      for (const old of this.sockets('host')) safeClose(old, CLOSE.replaced, 'Another PC took over this room');
    } else if (this.sockets('phone').length >= LIMITS.maxPhones) {
      this.ctx.acceptWebSocket(ws, ['refused']);
      safeClose(ws, CLOSE.roomFull, 'Too many phones');
      return;
    }
    this.ctx.acceptWebSocket(ws, [role]);
    this.announce();
  }

  sockets(role, except) {
    return this.ctx.getWebSockets(role).filter((w) => w !== except);
  }

  announce(leaving) {
    const phones = this.sockets('phone', leaving);
    const hosts = this.sockets('host', leaving);
    const peers = JSON.stringify({ t: 'peers', phones: phones.length });
    const host = JSON.stringify({ t: 'host', online: hosts.length > 0 });
    for (const h of hosts) safeSend(h, peers);
    for (const p of phones) safeSend(p, host);
  }

  webSocketMessage(ws, message) {
    const role = this.ctx.getTags(ws)[0];
    if (role !== 'host' && role !== 'phone') return;
    if (typeof message !== 'string' || message.length > LIMITS.maxMessageBytes) {
      safeClose(ws, CLOSE.tooBig, 'Message too big');
      return;
    }
    let bucket = this.buckets.get(ws);
    if (!bucket) {
      bucket = new TokenBucket(LIMITS.ratePerSecond, LIMITS.burst, Date.now());
      this.buckets.set(ws, bucket);
    }
    if (!bucket.take(Date.now())) {
      safeClose(ws, CLOSE.rateLimited, 'Slow down');
      return;
    }
    if (!isEnvelope(message)) return;
    for (const peer of this.sockets(role === 'host' ? 'phone' : 'host')) safeSend(peer, message);
  }

  webSocketClose(ws, code, reason) {
    this.buckets.delete(ws);
    safeClose(ws, replyCloseCode(code), reason);   // finish the closing handshake
    this.announce(ws);
  }

  webSocketError(ws) {
    this.buckets.delete(ws);
    this.announce(ws);
  }
}
