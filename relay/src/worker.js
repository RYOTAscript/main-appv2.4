// main Phone Remote relay — Cloudflare Worker entry.
//
//   GET /v1/room/<room>?role=host&lt=<license token>   the PC
//   GET /v1/room/<room>?role=phone                     a phone
//
// Both upgrade to a WebSocket in the room's Durable Object (src/room.js). The
// PC must present a valid license token; a phone needs only the room id, which
// it derives from the pairing secret in its QR code.

import { parseRoomPath, verifyLicenseToken } from './rules.js';

export { Room } from './room.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response('main phone relay\n', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    const target = parseRoomPath(url);
    if (!target) return new Response('Not found', { status: 404 });
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket', { status: 426 });
    }
    if (target.role === 'host' && !(await verifyLicenseToken(url.searchParams.get('lt')))) {
      return new Response('A licensed copy of main is required', { status: 401 });
    }
    return env.ROOMS.get(env.ROOMS.idFromName(target.room)).fetch(request);
  },
};
