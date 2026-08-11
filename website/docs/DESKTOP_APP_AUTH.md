# Desktop app — "Sign in with Google" (native OAuth)

This is the desktop-app half of the account link. The **app** runs its own
Google OAuth (PKCE + loopback redirect), gets a Google **`id_token`**, and posts
it to the website, which verifies it and returns the signed-in user's license.
No key to copy — signing in with the same Google account you bought with unlocks
the app.

- Website endpoint: **`POST /api/app/session`** (already built here).
- App code: drop the module below into `main-app11/main-app` (Electron **main**
  process) and wire one IPC handler + a renderer button.

---

## 1. Google Cloud setup (one-time)

In the **same** Google Cloud project as the website:

1. APIs & Services → Credentials → **Create credentials → OAuth client ID**.
2. Application type: **Desktop app**. Name it e.g. `main desktop`.
3. Copy the **Client ID** and **Client secret**.
   - The website needs the id as `GOOGLE_DESKTOP_CLIENT_ID` (in `.env`). The
     endpoint accepts tokens minted for either this id **or** the web
     `GOOGLE_CLIENT_ID`.
   - The app needs both the id and secret. Google's desktop "client secret" is
     **not treated as confidential** — it's expected to ship inside installed
     apps — and PKCE is what actually protects the exchange.

No redirect URI to configure: the "Desktop app" client type allows any
`http://127.0.0.1:<port>` loopback redirect automatically.

---

## 2. The endpoint contract

```
POST https://YOUR_SITE/api/app/session
Content-Type: application/json

{ "idToken": "<google id_token>" }
```

Response (200):

```jsonc
{
  "authenticated": true,
  "email": "you@example.com",
  "name": "You",
  "picture": "https://…",
  "purchased": true,
  "license": { "key": "MAIN-XXXX-XXXX-XXXX-XXXX", "issuedAt": "2026-…Z" }
}
```

- `purchased: false` + `license: null` → signed in, but no purchase on that
  Google account yet. Send them to `YOUR_SITE/#pricing`.
- `401` → invalid/expired token. `503` → server not configured.

For **ongoing** checks you don't need to re-run OAuth every launch: cache the
returned `license.key` and periodically call the existing
`GET /api/app/session`-free endpoint `GET /api/license/verify?key=…`
(add a grace period so brief offline spells don't lock the app).

---

## 3. App code — `renderer/google-auth.js` (main process)

> Node/Electron **main** process. Uses only built-ins + Electron's `shell`.

```js
// main-app11/main-app/google-auth.js  (require it from your main process)
const http = require("http");
const crypto = require("crypto");
const { shell } = require("electron");

// From your Google "Desktop app" OAuth client (not confidential — see docs).
const GOOGLE_DESKTOP_CLIENT_ID = process.env.GOOGLE_DESKTOP_CLIENT_ID || "<client-id>";
const GOOGLE_DESKTOP_CLIENT_SECRET = process.env.GOOGLE_DESKTOP_CLIENT_SECRET || "<client-secret>";
const SITE = process.env.MAIN_SITE_URL || "https://YOUR_SITE";

const b64url = (buf) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * Runs the full desktop Google sign-in and returns the website's entitlement
 * response: { authenticated, email, name, picture, purchased, license }.
 * Rejects on user-cancel / error.
 */
function signInWithGoogle() {
  return new Promise((resolve, reject) => {
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));

    // Loopback server on an ephemeral port catches Google's redirect.
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, `http://127.0.0.1`);
        if (!url.searchParams.get("code") && !url.searchParams.get("error")) {
          res.writeHead(204).end();
          return;
        }
        // Respond in the browser, then finish in the app.
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body style='background:#080808;color:#fff;font-family:sans-serif;display:grid;place-items:center;height:100vh'><p>You can close this tab and return to main.</p></body></html>");

        const err = url.searchParams.get("error");
        if (err) throw new Error(`Google returned: ${err}`);
        if (url.searchParams.get("state") !== state) throw new Error("State mismatch");

        const code = url.searchParams.get("code");
        const redirectUri = `http://127.0.0.1:${server.address().port}`;

        // Exchange the code for tokens (PKCE).
        const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id: GOOGLE_DESKTOP_CLIENT_ID,
            client_secret: GOOGLE_DESKTOP_CLIENT_SECRET,
            redirect_uri: redirectUri,
            grant_type: "authorization_code",
            code_verifier: verifier,
          }),
        });
        const tokens = await tokenRes.json();
        if (!tokens.id_token) throw new Error(tokens.error_description || "No id_token");

        // Hand the id_token to the website; get back the license.
        const siteRes = await fetch(`${SITE}/api/app/session`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idToken: tokens.id_token }),
        });
        const data = await siteRes.json();
        if (!siteRes.ok) throw new Error(data.error || "Sign-in failed");

        server.close();
        resolve(data); // { authenticated, email, purchased, license, ... }
      } catch (e) {
        server.close();
        reject(e);
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const redirectUri = `http://127.0.0.1:${server.address().port}`;
      const authUrl =
        "https://accounts.google.com/o/oauth2/v2/auth?" +
        new URLSearchParams({
          client_id: GOOGLE_DESKTOP_CLIENT_ID,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: "openid email profile",
          code_challenge: challenge,
          code_challenge_method: "S256",
          state,
          access_type: "offline",
          prompt: "select_account",
        });
      shell.openExternal(authUrl); // opens the system browser
    });

    // Safety timeout.
    setTimeout(() => { try { server.close(); } catch {} reject(new Error("Sign-in timed out")); }, 5 * 60 * 1000);
  });
}

module.exports = { signInWithGoogle };
```

## 4. Wire it up (main + renderer)

**Main process** (where your other `ipcMain.handle`s live):

```js
const { signInWithGoogle } = require("./google-auth");

ipcMain.handle("account:signIn", async () => {
  const result = await signInWithGoogle();
  // Persist result.license?.key + email in your settings store for reuse.
  return result;
});
```

**Preload** (expose it safely):

```js
contextBridge.exposeInMainWorld("mainAccount", {
  signIn: () => ipcRenderer.invoke("account:signIn"),
});
```

**Renderer** (a "Sign in with Google" button):

```js
const res = await window.mainAccount.signIn();
if (res.purchased) {
  // Unlock: store res.license.key, show res.email in the UI.
} else {
  // Signed in but not bought — open the pricing page.
  shell.openExternal(`${SITE}/#pricing`);
}
```

## 5. Re-checking later (no re-OAuth)

Cache `res.license.key`. On subsequent launches, verify quietly:

```js
const r = await fetch(`${SITE}/api/license/verify`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${YOUR_SECRET}`,
  },
  body: JSON.stringify({ key }),
});
const { valid } = await r.json();
// valid === true → stay unlocked. Keep the last-good result for an offline grace window.
```

Set `LICENSE_VERIFY_SECRET` on the site and send it as
`Authorization: Bearer <secret>` to lock the verify endpoint down.
