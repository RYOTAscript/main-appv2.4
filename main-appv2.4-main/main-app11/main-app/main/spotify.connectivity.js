// Pure classifier for Spotify request failures — extracted from spotify.js so it
// can be unit-tested (see test/spotify-connectivity.test.js).
//
// An always-on launcher polls Spotify every ~2.5s. Two failure classes are
// EXPECTED environmental conditions, not app defects, and must never be logged
// as a full ERROR+stack on every poll (that buries real errors and churns the
// 2 MB log rotation):
//   • network  — PC offline, DNS down, firewall blocking while gaming, timeouts.
//   • tls      — a TLS-inspecting proxy or antivirus (common on managed /
//                corporate / school PCs) re-signs HTTPS with a private root CA
//                that Node's bundled cert store does not trust, so every request
//                throws a certificate-chain error.
// Both take a quiet "log once, retry until it clears" path; genuine faults
// (bad JSON, unexpected shapes) return null and stay loud ERRORs.

const SPOTIFY_NETWORK_CODES = new Set([
  'ENOTFOUND', 'EACCES', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN',
  'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'
]);

const SPOTIFY_TLS_CODES = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_ISSUER_CERT', 'CERT_UNTRUSTED', 'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID'
]);

// Returns 'tls' | 'network' | null. Recurses through aggregated (`e.errors`) and
// wrapped (`e.cause`) errors, then falls back to matching the message text — the
// error that floods in the wild ("self signed certificate in certificate chain")
// sometimes arrives with no `.code`, so the message check is load-bearing.
function classifySpotifyConnectivity(e) {
  if (!e) return null;
  if (SPOTIFY_TLS_CODES.has(e.code)) return 'tls';
  if (SPOTIFY_NETWORK_CODES.has(e.code)) return 'network';
  if (Array.isArray(e.errors)) {
    for (const inner of e.errors) {
      const kind = classifySpotifyConnectivity(inner);
      if (kind) return kind;
    }
  }
  if (e.cause && e.cause !== e) {
    const kind = classifySpotifyConnectivity(e.cause);
    if (kind) return kind;
  }
  const msg = e.message || '';
  if (/self[- ]signed cert|certificate chain|unable to (verify|get).*cert|cert(ificate)?.*(expired|untrusted)/i.test(msg)) return 'tls';
  if (/ENOTFOUND|ECONN|ETIMEDOUT|EACCES|network|fetch failed|request timeout|timed? ?out/i.test(msg)) return 'network';
  return null;
}

module.exports = { classifySpotifyConnectivity, SPOTIFY_NETWORK_CODES, SPOTIFY_TLS_CODES };
