// Phone Remote — the PC's half of a session, with no Electron in it: what to
// tell the phones and what to do with their commands. main/phoneRemote.js feeds
// it relay messages and gives it a send(); test/phone-remote-host.test.js
// drives it directly.
//
// It only does work while a phone is watching. The relay reports how many
// phones are in the room; at zero nothing is polled and nothing is sent.
// While one is, Spotify is polled through the same functions the launcher's
// own IPC uses (main/spotify.js), and the phone gets:
//   state  — the track, position, play/shuffle/repeat/volume/like, the look
//   lyrics — once per song (they are big), as soon as main/lyrics.js has them
//   queue  — only when the phone asks (its Up next tab)
// Everything goes out sealed (renderer/remote-protocol.js). Commands are
// opened with the other direction's key binding, checked, de-duplicated and
// rate-limited before anything touches Spotify.
'use strict';

const POLL_PLAYING_MS = 2500;
const POLL_IDLE_MS = 6000;
const POLL_OFFLINE_MS = 30000;
const REPOLL_MS = 400;           // after a command, look again soon
const HOLD_MS = 2500;            // a command's result outlives a poll that hasn't caught up
const COMMANDS_PER_SECOND = 8;
const QUEUE_MIN_GAP_MS = 3000;   // the queue endpoint is rate-limited
const HTTPS_IMAGE = /^https:\/\/[^\s"'<>\\]+$/i;
const REPEAT_MODES = ['off', 'context', 'track'];

const str = (x, n = 300) => (typeof x === 'string' ? x.slice(0, n) : '');
const image = (x) => (typeof x === 'string' && HTTPS_IMAGE.test(x) ? x : '');

function trackKey(track) {
  if (!track) return '';
  return track.id || `${track.name}|${track.artist}`;
}

function emptySample() {
  return {
    connected: false, playing: false, progressMs: 0, at: 0, durationMs: 0,
    track: null, volume: null, shuffle: false, repeat: 'off', device: '', deviceType: '',
  };
}

class RemoteHost {
  constructor(opts) {
    this.P = opts.protocol;
    this.spotify = opts.spotify || {};
    this.lyrics = opts.lyrics || null;
    this.sendRaw = opts.send;
    this.getSettings = opts.getSettings || (() => ({ look: 'glass', lead: 700 }));
    this.logger = opts.logger || { warn() {} };
    this.now = opts.now || Date.now;
    this.setTimer = opts.setTimer || setTimeout;
    this.clearTimer = opts.clearTimer || clearTimeout;

    this.key = null;
    this.guard = new this.P.ReplayGuard();
    this.phones = 0;
    this.sid = '';
    this.seq = 0;
    this.polling = false;
    this.pollTimer = null;
    this.inFlight = false;
    this.again = false;
    this.commandTimes = [];
    this.sample = emptySample();
    this.holds = {};
    this.liked = null;
    this.lyricsState = { key: '', status: 'none', synced: false, lines: [] };
    this.lastQueue = null;
    this.lastQueueAt = 0;
  }

  /** A new pairing (or none). A fresh replay guard goes with a fresh key. */
  async setSecret(secret) {
    this.key = secret ? await this.P.deriveKey(secret) : null;
    this.guard = new this.P.ReplayGuard();
  }

  /** Connected to the relay: a new session, so the phone resets its ordering. */
  onOpen() {
    this.sid = this.P.newSecret().slice(0, 16);
    this.seq = 0;
  }

  onClose() {
    this.setPhones(0);
  }

  async onMessage(text) {
    if (typeof text !== 'string') return;
    let frame;
    try { frame = JSON.parse(text); } catch (e) { return; }
    if (!frame || typeof frame !== 'object') return;
    if (frame.t === 'peers') { this.setPhones(frame.phones); return; }
    if (frame.t !== 'e' || !this.key) return;
    const cmd = this.P.sanitizeCommand(await this.P.open(this.key, this.P.TO_HOST, text));
    if (!cmd || !this.guard.accept(cmd, this.now()) || !this.allowCommand()) return;
    await this.handle(cmd);
  }

  setPhones(n) {
    this.phones = Math.max(0, Math.min(16, Math.floor(Number(n) || 0)));
    if (this.phones > 0 && !this.polling) {
      this.polling = true;
      this.poll();
    } else if (this.phones === 0 && this.polling) {
      this.polling = false;
      this.clearTimer(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** The launcher's look or lyric timing changed. */
  settingsChanged() {
    if (this.phones > 0) this.publishState();
  }

  allowCommand() {
    const now = this.now();
    this.commandTimes = this.commandTimes.filter((t) => now - t < 1000);
    if (this.commandTimes.length >= COMMANDS_PER_SECOND) return false;
    this.commandTimes.push(now);
    return true;
  }

  // ── Polling ─────────────────────────────────────────────────────────────

  async poll() {
    if (this.inFlight) { this.again = true; return; }
    this.clearTimer(this.pollTimer);
    this.pollTimer = null;
    if (!this.polling) return;
    this.inFlight = true;
    let delay = POLL_IDLE_MS;
    try {
      if (this.spotify.isConnected && !this.spotify.isConnected()) {
        this.applySample({ connected: false });
        delay = POLL_OFFLINE_MS;
      } else {
        this.applySample(await this.spotify.getCurrentTrack());
        if (!this.sample.connected) delay = POLL_OFFLINE_MS;
        else if (this.sample.playing) delay = POLL_PLAYING_MS;
      }
    } catch (e) {
      this.logger.warn('Phone Remote: Spotify poll failed', { error: e && e.message });
    } finally {
      this.inFlight = false;
    }
    if (!this.polling) return;
    await this.publishState();
    if (this.again) { this.again = false; delay = REPOLL_MS; }
    this.pollTimer = this.setTimer(() => this.poll(), delay);
  }

  repoll() {
    if (!this.polling) return;
    if (this.inFlight) { this.again = true; return; }
    this.clearTimer(this.pollTimer);
    this.pollTimer = this.setTimer(() => this.poll(), REPOLL_MS);
  }

  applySample(data) {
    const now = this.now();
    const t = data && data.connected && data.track ? data.track : null;
    const before = trackKey(this.sample.track);
    const s = {
      connected: !!(data && data.connected),
      playing: !!(t && data.is_playing),
      progressMs: t ? Math.max(0, Number(t.progress_ms) || 0) : 0,
      at: now,
      durationMs: t ? Math.max(0, Number(t.duration_ms) || 0) : 0,
      track: t ? {
        id: str(t.id, 64), name: str(t.name), artist: str(t.artist), album: str(t.album), image: image(t.image),
      } : null,
      volume: data && Number.isFinite(data.volume_percent) ? data.volume_percent : this.sample.volume,
      shuffle: !!(data && data.shuffle_state),
      repeat: data && REPEAT_MODES.includes(data.repeat_state) ? data.repeat_state : 'off',
      device: str(data && data.device, 80),
      deviceType: str(data && data.device_type, 20),
    };
    for (const [field, hold] of Object.entries(this.holds)) {
      if (now >= hold.until || trackKey(s.track) !== hold.track) { delete this.holds[field]; continue; }
      if (field === 'progressMs') s.progressMs = hold.value + (s.playing ? now - hold.at : 0);
      else s[field] = hold.value;
    }
    this.sample = s;
    if (trackKey(s.track) !== before) this.trackChanged();
  }

  hold(field, value) {
    const now = this.now();
    this.holds[field] = { value, at: now, until: now + HOLD_MS, track: trackKey(this.sample.track) };
    this.sample[field] = value;
  }

  // A new song: its heart, and its lyrics — both fetched once, then sent.
  trackChanged() {
    const track = this.sample.track;
    const key = trackKey(track);
    this.liked = null;
    this.lyricsState = { key, status: track ? 'loading' : 'none', synced: false, lines: [] };
    this.publishLyrics();
    if (!track) return;

    if (track.id && this.spotify.isSaved) {
      Promise.resolve(this.spotify.isSaved(track.id))
        .then((res) => {
          if (trackKey(this.sample.track) !== key || !res || !res.ok) return;
          this.liked = !!res.saved;
          this.publishState();
        })
        .catch(() => {});
    }

    const done = (state) => {
      if (this.lyricsState.key !== key) return;   // a newer song took over meanwhile
      this.lyricsState = state;
      this.publishLyrics();
    };
    if (!this.lyrics || !this.lyrics.getLyrics) { done({ key, status: 'none', synced: false, lines: [] }); return; }
    Promise.resolve(this.lyrics.getLyrics(track.name, track.artist, track.album, this.sample.durationMs))
      .then((res) => {
        if (res && res.success && Array.isArray(res.lyrics)) {
          done({
            key,
            status: 'ready',
            synced: !!res.synced,
            lines: res.lyrics.slice(0, 400).map((l) => ({
              t: Number.isFinite(l.time) ? l.time : null,
              text: str(String(l.text == null ? '' : l.text)),
            })),
          });
        } else {
          done({ key, status: 'none', synced: false, lines: [] });
        }
      })
      .catch((e) => {
        this.logger.warn('Phone Remote: lyrics lookup failed', { error: e && e.message });
        done({ key, status: 'none', synced: false, lines: [] });
      });
  }

  // ── Sending ─────────────────────────────────────────────────────────────

  stateMessage() {
    const s = this.sample;
    const now = this.now();
    const settings = this.getSettings() || {};
    const position = s.track ? s.progressMs + (s.playing ? now - s.at : 0) : 0;
    return {
      k: 'state',
      sid: this.sid,
      seq: ++this.seq,
      ts: now,
      connected: s.connected,
      playing: s.playing,
      progressMs: Math.round(s.durationMs ? Math.min(s.durationMs, position) : position),
      durationMs: s.durationMs,
      track: s.track,
      volume: Number.isFinite(s.volume) ? s.volume : null,
      shuffle: s.shuffle,
      repeat: s.repeat,
      liked: this.liked,
      look: settings.look === 'white' ? 'white' : 'glass',
      lead: Number.isFinite(settings.lead) ? settings.lead : 700,
      device: s.device,
      deviceType: s.deviceType,
    };
  }

  async publish(payload) {
    if (!this.key || this.phones === 0) return;
    try {
      this.sendRaw(await this.P.seal(this.key, this.P.TO_PHONE, payload));
    } catch (e) {
      this.logger.warn('Phone Remote: could not send', { error: e && e.message });
    }
  }

  publishState() { return this.publish(this.stateMessage()); }

  publishLyrics() {
    const l = this.lyricsState;
    return this.publish({ k: 'lyrics', key: l.key, status: l.status, synced: l.synced, lines: l.lines });
  }

  async publishQueue() {
    const now = this.now();
    if (this.lastQueue && now - this.lastQueueAt < QUEUE_MIN_GAP_MS) return this.publish(this.lastQueue);
    this.lastQueueAt = now;
    let res = null;
    try { res = this.spotify.getQueue ? await this.spotify.getQueue() : null; } catch (e) { res = null; }
    const ok = !!(res && res.ok);
    this.lastQueue = {
      k: 'queue',
      ok,
      items: ok ? (res.queue || []).filter(Boolean).slice(0, 20).map((t) => ({
        name: str(t.name), artist: str(t.artist), image: image(t.image), durationMs: Number(t.duration_ms) || 0,
      })) : [],
    };
    return this.publish(this.lastQueue);
  }

  // ── Commands ────────────────────────────────────────────────────────────

  async handle(cmd) {
    const sp = this.spotify;
    const s = this.sample;
    switch (cmd.a) {
      case 'hello':
        await this.publishState();
        await this.publishLyrics();
        return;
      case 'queue':
        await this.publishQueue();
        return;
      case 'toggle': {
        if (!s.track || !sp.control) return;
        const play = !s.playing;
        // Freeze the position where it is, so the bar stops (or starts) right there.
        const now = this.now();
        s.progressMs += s.playing ? now - s.at : 0;
        s.at = now;
        this.hold('playing', play);
        await this.publishState();
        await sp.control(play ? 'play' : 'pause');
        this.repoll();
        return;
      }
      case 'next':
      case 'previous':
        if (!sp.control) return;
        this.lastQueue = null;   // the queue moves on with the song
        await sp.control(cmd.a);
        this.repoll();
        return;
      case 'seek':
        if (!s.track || !sp.seek) return;
        this.hold('progressMs', Math.min(cmd.v, s.durationMs || cmd.v));
        s.at = this.now();
        await this.publishState();
        await sp.seek(cmd.v);
        this.repoll();
        return;
      case 'volume':
        if (!sp.setVolume) return;
        this.hold('volume', cmd.v);
        await this.publishState();
        await sp.setVolume(cmd.v);
        return;
      case 'like': {
        if (!s.track || !s.track.id || !sp.setSaved) return;
        const before = this.liked;
        this.liked = cmd.v;
        await this.publishState();
        const res = await sp.setSaved(s.track.id, cmd.v);
        if (!res || !res.ok) {
          this.liked = before;
          await this.publishState();
        }
        return;
      }
      case 'shuffle':
      case 'repeat': {
        if (!sp.control) return;
        const field = cmd.a;
        this.hold(field, cmd.v);
        await this.publishState();
        const res = await sp.control(field === 'shuffle' ? (cmd.v ? 'shuffle-on' : 'shuffle-off') : `repeat-${cmd.v}`);
        if (!res || !res.success) {
          delete this.holds[field];
          this.repoll();
        }
        if (field === 'shuffle') this.lastQueue = null;
        return;
      }
      default:
        return;
    }
  }
}

module.exports = {
  RemoteHost,
  POLL_PLAYING_MS, POLL_IDLE_MS, POLL_OFFLINE_MS, HOLD_MS, COMMANDS_PER_SECOND, QUEUE_MIN_GAP_MS,
};
