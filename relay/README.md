# main Phone Remote relay

A Cloudflare Worker + Durable Object that passes the Phone Remote's messages
between the main desktop app and a phone, so the phone works from anywhere —
not just on the PC's Wi-Fi.

It is deliberately dumb. Each pairing gets a room; the PC ("host") and up to
four phones join it over WebSockets, and the relay forwards sealed envelopes
between them. Everything is end-to-end encrypted with a key derived from the
pairing secret (see the desktop app's `renderer/remote-protocol.js`), which the
relay never sees — it can't read what's playing or forge a command. It stores
nothing, and idle rooms cost nothing (WebSocket Hibernation: keep-alive pings
are answered without waking the object).

| Path | |
|---|---|
| `GET /v1/room/<room>?role=host&lt=<license token>` | the PC — needs a valid license token |
| `GET /v1/room/<room>?role=phone` | a phone |
| `GET /health` | `main phone relay` |

The PC must present the license token the website signed for it
(`website/src/lib/licenseToken.ts`); the relay checks it with the same Ed25519
public key the app checks its own unlock with (`main/license.js`). A desktop
test fails if the two copies of that key drift apart.

## Test

```bash
npm test
```

## Deploy

Needs a (free) Cloudflare account.

```bash
npx wrangler@4 login     # once: opens Cloudflare in the browser, click Allow
npx wrangler@4 deploy
```

The deploy prints the URL, `https://main-phone-relay.<your-subdomain>.workers.dev`.
Put that host — without `https://` — into `RELAY_HOST_DEFAULT` in the desktop
app's `main/phoneRemote.js`, and ship a new build. Until then the Phone Remote
panel says it isn't set up yet.

For a dev run of the desktop app against a relay without rebuilding, set
`MAIN_PHONE_RELAY` (honoured only when the app is not packaged):

```bash
MAIN_PHONE_RELAY=main-phone-relay.<your-subdomain>.workers.dev npm start
```

The phone page itself is static and ships with the website
(`website/public/remote/`), so the website must be deployed too.

## Rotating the license key

If the website's license-signing key is ever rotated, update
`LICENSE_PUBLIC_KEY_HEX` in `src/rules.js` together with `main/license.js`,
and redeploy.
