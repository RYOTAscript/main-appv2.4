// Calendar mini widget — main-process owner of the data and the reminders.
//
// Why main and not the renderer: a reminder has to fire while the launcher is
// minimised to the tray, and Chromium throttles timers in a hidden window
// (see CLAUDE.md on hidden-window throttling). Node timers here are not
// throttled, so the scheduler lives here and the renderer is purely the UI.
//
// Storage (userData):
//   calendar.json          calendars, events, settings, enabled — the user's data
//   calendar-runtime.json  watermark, snoozes, notification history — small and
//                          rewritten on every reminder, so it stays out of the
//                          (potentially large) data file
// Both are written atomically (temp file + rename) so a crash mid-write can
// never leave a half-written calendar.
//
// Scheduling is ONE timer aimed at the next due reminder (capped at 15 min),
// not a poll. Every rule about what is due, what collapses and what counts as
// missed lives in renderer/calendar-engine.js `scan()` and is unit-tested; this
// file just runs it, announces the result and remembers it.
//
// Subscribed calendars (an .ics URL) are fetched through netClient, which
// uses the OS certificate store — see main/netClient.js for why Node's own
// https would fail on machines behind a TLS-inspecting proxy.

const { ipcMain, Notification, dialog, powerMonitor, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const E = require('../renderer/calendar-engine');
const Ics = require('./calendarIcs');
const { netFetch } = require('./netClient');

const STORE_VERSION = 1;
const HISTORY_MAX = 40;
const MAX_EVENTS = 20000;
const MAX_CALENDARS = 24;
const SUB_CHECK_MS = 30 * 60 * 1000;

function init(ctx) {
  const { logger } = ctx;
  const STORE_PATH = path.join(ctx.userDataPath, 'calendar.json');
  const RUNTIME_PATH = path.join(ctx.userDataPath, 'calendar-runtime.json');

  let store = loadStore();
  const needsRepairSave = store.migrated;
  delete store.migrated;
  let runtime = loadRuntime();
  let timer = null;
  let timerTarget = 0;
  let subTimer = null;
  let saveTimer = null;
  let tornDown = false;
  const refreshing = new Set();
  // Electron garbage-collects a Notification that nothing references, and its
  // click/action handlers go with it — keep the recent ones alive.
  const liveNotes = [];

  // ── Persistence ─────────────────────────────────────────────────────────

  function readJson(file) {
    try {
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      logger.warn('Calendar: unreadable file, starting fresh from it', { file: path.basename(file), error: e.message });
      // Keep the damaged file for recovery instead of overwriting it.
      try { fs.copyFileSync(file, file + '.corrupt-' + Date.now()); } catch (err) { /* best effort */ }
      return null;
    }
  }

  function writeAtomic(file, data) {
    const tmp = path.join(path.dirname(file), '.' + path.basename(file) + '.tmp-' + crypto.randomBytes(4).toString('hex'));
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, file);
  }

  function loadStore() {
    const raw = readJson(STORE_PATH);
    const calendars = [];
    const seen = new Set();
    for (const c of (raw && Array.isArray(raw.calendars) ? raw.calendars : E.DEFAULT_CALENDARS)) {
      const clean = E.sanitizeCalendar(c, c);
      if (seen.has(clean.id)) continue;
      seen.add(clean.id);
      calendars.push(clean);
    }
    if (!calendars.length) E.DEFAULT_CALENDARS.forEach(c => calendars.push(E.sanitizeCalendar(c, c)));
    const settings = E.mergeSettings(raw && raw.settings);
    const ids = calendars.map(c => c.id);
    const events = [];
    // Set when sanitising had to repair something (an event saved with a
    // null id, from the bug where RegExp.test coerced it). Persisted below so
    // the repaired ids are stable across restarts.
    let migrated = false;
    for (const ev of (raw && Array.isArray(raw.events) ? raw.events : []).slice(0, MAX_EVENTS)) {
      const r = E.sanitizeEvent(ev, { calendarIds: ids, defaultDuration: settings.defaultDuration, now: ev && ev.updatedAt });
      if (!r.ok) continue;
      const clean = r.event;
      if (clean.id !== ev.id) migrated = true;
      clean.updatedAt = Number.isFinite(ev.updatedAt) ? ev.updatedAt : clean.updatedAt;
      events.push(clean);
    }
    return { version: STORE_VERSION, enabled: !!(raw && raw.enabled), calendars, events, settings, migrated };
  }

  function loadRuntime() {
    const raw = readJson(RUNTIME_PATH) || {};
    return {
      watermark: Number.isFinite(raw.watermark) ? raw.watermark : null,
      snoozes: Array.isArray(raw.snoozes) ? raw.snoozes.filter(s => s && typeof s.eventId === 'string' && E.isDate(s.occKey) && Number.isFinite(s.fireAt)).slice(0, 100) : [],
      history: Array.isArray(raw.history) ? raw.history.slice(0, HISTORY_MAX) : []
    };
  }

  function saveStoreSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveStoreNow, 200);
  }

  function saveStoreNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    try {
      writeAtomic(STORE_PATH, JSON.stringify(store));
    } catch (e) {
      logger.error('Calendar: failed to save calendar.json', e);
    }
  }

  function saveRuntime() {
    try {
      writeAtomic(RUNTIME_PATH, JSON.stringify(runtime));
    } catch (e) {
      logger.error('Calendar: failed to save calendar-runtime.json', e);
    }
  }

  // ── State out to the renderer ───────────────────────────────────────────

  function unreadCount() { return runtime.history.filter(h => !h.read).length; }

  function publicState() {
    return {
      enabled: store.enabled,
      calendars: store.calendars,
      events: store.events,
      settings: store.settings,
      history: runtime.history,
      unread: unreadCount(),
      snoozes: runtime.snoozes
    };
  }

  function send(channel, payload) {
    const win = ctx.getMainWindow && ctx.getMainWindow();
    if (win && !win.isDestroyed()) {
      try { win.webContents.send(channel, payload); } catch (e) { /* window going away */ }
    }
  }

  function broadcast() { send('calendar:changed', publicState()); }

  // Every mutation goes through here: first run a pass with the OLD data (so
  // anything legitimately due right now still fires and the watermark moves to
  // now), then apply the change, persist, reschedule and tell the renderer.
  // That ordering is what makes "an event created with its reminder already in
  // the past" never ping, independent of when the last pass happened.
  function mutate(fn) {
    if (store.enabled) tick(false);
    const result = fn();
    saveStoreSoon();
    reschedule();
    broadcast();
    return result;
  }

  function calendarIds() { return store.calendars.map(c => c.id); }
  function findCalendar(id) { return store.calendars.find(c => c.id === id) || null; }
  function findEvent(id) { return store.events.find(e => e.id === id) || null; }
  function isReadOnly(ev) { const c = ev && findCalendar(ev.calendarId); return !!(c && c.readOnly); }

  // ── Scheduler ───────────────────────────────────────────────────────────

  function reschedule() {
    clearTimeout(timer);
    timer = null;
    if (!store.enabled || tornDown) return;
    let next;
    try {
      next = E.nextWakeAt(store, runtime.snoozes, Date.now());
    } catch (e) {
      logger.error('Calendar: could not compute the next reminder', e);
      next = Date.now() + E.WAKE_CAP;
    }
    timerTarget = next;
    const delay = Math.max(250, Math.min(E.WAKE_CAP, next - Date.now()));
    timer = setTimeout(() => tick(true), delay);
  }

  function tick(fromTimer) {
    if (!store.enabled || tornDown) return;
    const now = Date.now();
    // Node may wake a hair early; never scan before the target, or a reminder
    // due at exactly `timerTarget` would slip to the next pass.
    if (fromTimer && now < timerTarget && timerTarget - now < E.WAKE_CAP) {
      clearTimeout(timer);
      timer = setTimeout(() => tick(true), timerTarget - now + 5);
      return;
    }
    let res;
    try {
      res = E.scan(store, runtime, now);
    } catch (e) {
      logger.error('Calendar: scheduler pass failed', e);
      runtime.watermark = now;
      if (fromTimer) reschedule();
      return;
    }
    const changed = res.fire.length || res.missed.length || res.digest || res.snoozes.length !== runtime.snoozes.length;
    runtime.watermark = res.watermark;
    runtime.snoozes = res.snoozes;
    for (const item of res.fire) deliverReminder(item, now);
    if (res.missed.length) deliverMissed(res.missed, now);
    if (res.digest) deliverDigest(res.digest, now);
    // The watermark must reach disk promptly after anything fired, so a crash
    // can't replay it; between firings a write per wake is plenty.
    saveRuntime();
    if (changed) broadcast();
    if (fromTimer) reschedule();
  }

  // ── Delivery ────────────────────────────────────────────────────────────

  function envOpts() { return { clock24: !!store.settings.clock24 }; }

  function pushHistory(entry) {
    runtime.history.unshift(entry);
    if (runtime.history.length > HISTORY_MAX) runtime.history.length = HISTORY_MAX;
  }

  function iconPath() {
    const ico = path.join(ctx.appRoot || path.join(__dirname, '..'), 'icons', 'main.ico');
    return fs.existsSync(ico) ? ico : undefined;
  }

  // One place decides how an alert is presented, so quiet hours and the
  // user's toggles are honoured identically for every kind.
  function present({ id, kind, title, body, occ, important, now }) {
    const s = store.settings;
    const quiet = E.inQuietHours(s, now) && !(important && s.quietHours.allowImportant);
    const entry = {
      id, kind, ts: now, title, body, read: false,
      eventId: occ ? occ.eventId : null, occKey: occ ? occ.occKey : null, important: !!important, quiet
    };
    pushHistory(entry);
    const link = occ ? E.findMeetingLink(occ) : null;

    if (s.notifications.desktop && !quiet) showNative(entry, link);
    // The renderer shows its own glass card and plays the chime (it decides
    // visibility; main decides whether this alert is allowed to make noise).
    send('calendar:alert', {
      id, kind, title, body, important: !!important, quiet,
      occ: occ || null, link,
      inApp: !!s.notifications.inApp && !quiet,
      sound: !!s.notifications.sound && !quiet
    });
  }

  function showNative(entry, link) {
    try {
      if (!Notification.isSupported()) return;
      // Actions render as buttons on the Windows toast / macOS banner.
      const actions = [];
      if (entry.eventId) actions.push({ type: 'button', text: 'Snooze 10 min' });
      if (link) actions.push({ type: 'button', text: 'Join call' });
      const n = new Notification({
        title: entry.title,
        body: entry.body,
        icon: iconPath(),
        // The renderer plays the widget's own chime, so the OS stays quiet
        // rather than doubling it.
        silent: true,
        timeoutType: entry.important ? 'never' : 'default',
        urgency: entry.important ? 'critical' : 'normal',
        actions
      });
      n.on('click', () => {
        try { ctx.focusMainWindow && ctx.focusMainWindow(); } catch (e) { /* ignore */ }
        markRead(entry.id);
        send('calendar:open', { eventId: entry.eventId, occKey: entry.occKey });
      });
      n.on('action', (event, legacyIndex) => {
        const idx = event && typeof event.actionIndex === 'number' ? event.actionIndex : legacyIndex;
        const act = actions[idx];
        if (!act) return;
        if (act.text.startsWith('Snooze')) snooze(entry.eventId, entry.occKey, 10);
        else if (act.text === 'Join call' && link) openLink(link);
        markRead(entry.id);
      });
      n.show();
      liveNotes.push(n);
      if (liveNotes.length > 12) liveNotes.shift();
    } catch (e) {
      logger.warn('Calendar: native notification failed', { error: e && e.message });
    }
  }

  function deliverReminder(item, now) {
    const a = E.describeAlert(item.occ, now, envOpts());
    present({
      id: 'n' + now.toString(36) + Math.random().toString(36).slice(2, 6),
      kind: item.type === 'snooze' ? 'snooze' : 'reminder',
      title: a.title,
      body: a.body,
      occ: item.occ,
      important: item.occ.important,
      now
    });
  }

  function deliverMissed(items, now) {
    const m = E.missedSummary(items, envOpts());
    present({ id: 'm' + now.toString(36), kind: 'missed', title: m.title, body: m.body, occ: items.length === 1 ? items[0].occ : null, important: false, now });
  }

  function deliverDigest(dg, now) {
    const d = E.digestSummary(store, dg.date, now, envOpts());
    present({ id: 'd' + now.toString(36), kind: 'digest', title: d.title, body: d.body, occ: null, important: false, now });
  }

  function markRead(id) {
    let hit = false;
    for (const h of runtime.history) if (!h.read && (id === '*' || h.id === id)) { h.read = true; hit = true; }
    if (hit) { saveRuntime(); broadcast(); }
  }

  function snooze(eventId, occKey, minutes) {
    const ev = findEvent(eventId);
    if (!ev || !E.occurrenceFor(ev, occKey)) return { ok: false, error: 'That event no longer exists' };
    const mins = Math.min(24 * 60, Math.max(1, Math.round(Number(minutes) || 10)));
    runtime.snoozes = runtime.snoozes.filter(s => !(s.eventId === eventId && s.occKey === occKey));
    runtime.snoozes.push({ eventId, occKey, fireAt: Date.now() + mins * 60000 });
    saveRuntime();
    reschedule();
    broadcast();
    return { ok: true, minutes: mins };
  }

  function openLink(url) {
    const href = E.safeHttpUrl(url);
    if (!href) return false;
    shell.openExternal(href).catch(() => {});
    return true;
  }

  // ── Event mutations ─────────────────────────────────────────────────────

  function sanitizeCtx() {
    return { calendarIds: calendarIds(), defaultCalendarId: writableCalendarId(), defaultDuration: store.settings.defaultDuration, now: Date.now() };
  }

  function writableCalendarId() {
    const c = store.calendars.find(x => !x.readOnly);
    return c ? c.id : null;
  }

  // scope: 'all' (default) | 'this' (one occurrence of a series) | 'following'
  function saveEvent(input, opts) {
    const o = opts || {};
    const existing = input && input.id ? findEvent(input.id) : null;
    if (existing && isReadOnly(existing)) return { ok: false, error: 'Subscribed calendars are read-only' };
    const target = findCalendar(input && input.calendarId);
    if (target && target.readOnly) return { ok: false, error: 'Subscribed calendars are read-only' };
    if (!existing && store.events.length >= MAX_EVENTS) return { ok: false, error: 'The calendar is full' };

    if (existing && existing.rrule && (o.scope === 'this' || o.scope === 'following') && E.isDate(o.occKey)) {
      if (o.scope === 'this') {
        return mutate(() => {
          let next = E.editOccurrence(existing, o.occKey, input);
          next.updatedAt = Date.now();
          const r = E.sanitizeEvent(next, sanitizeCtx());
          if (!r.ok) return r;
          r.event.createdAt = existing.createdAt;
          replaceEvent(r.event);
          return { ok: true, id: r.event.id, state: publicState() };
        });
      }
      return mutate(() => {
        const { before, after } = E.splitSeries(existing, o.occKey, E.genId('e'));
        // The edit applies to the new "following" half.
        const merged = Object.assign({}, after, pickEditable(input));
        merged.id = after.id;
        merged.exdates = after.exdates;
        merged.overrides = after.overrides;
        merged.doneDates = after.doneDates;
        if (!input.rrule) merged.rrule = null;
        const ra = E.sanitizeEvent(merged, sanitizeCtx());
        if (!ra.ok) return ra;
        if (before) {
          const rb = E.sanitizeEvent(before, sanitizeCtx());
          if (rb.ok) { rb.event.createdAt = existing.createdAt; replaceEvent(rb.event); }
        } else {
          store.events = store.events.filter(e => e.id !== existing.id);
        }
        store.events.push(ra.event);
        return { ok: true, id: ra.event.id, state: publicState() };
      });
    }

    // Series bookkeeping (exceptions, moved occurrences, done-marks) is main's
    // record, never the renderer's copy. It survives an edit that keeps the
    // same repeat rule; a new rule starts a new series with a clean slate.
    const keepSeries = existing && sameRule(existing, input);
    const r = E.sanitizeEvent(Object.assign({}, input, existing ? {
      exdates: keepSeries ? existing.exdates : [],
      overrides: keepSeries ? existing.overrides : {},
      doneDates: keepSeries ? existing.doneDates : [],
      createdAt: existing.createdAt,
      source: existing.source,
      uid: existing.uid
    } : {}), sanitizeCtx());
    if (!r.ok) return r;
    return mutate(() => {
      if (existing) replaceEvent(r.event); else store.events.push(r.event);
      return { ok: true, id: r.event.id, state: publicState() };
    });
  }

  function pickEditable(input) {
    const out = {};
    for (const k of ['calendarId', 'kind', 'title', 'location', 'notes', 'url', 'allDay', 'start', 'end', 'reminders', 'important', 'rrule']) {
      if (input[k] !== undefined) out[k] = input[k];
    }
    return out;
  }

  // Compared in sanitised form, anchored on the edited start date, so an
  // unchanged rule matches however the renderer happened to spell it.
  function sameRule(existing, input) {
    const s = input && typeof input.start === 'string' && E.isDate(input.start.slice(0, 10)) ? input.start.slice(0, 10) : E.evStartDate(existing);
    return JSON.stringify(E.sanitizeRRule(existing.rrule, s)) === JSON.stringify(E.sanitizeRRule(input && input.rrule, s));
  }

  function replaceEvent(ev) {
    const i = store.events.findIndex(e => e.id === ev.id);
    if (i === -1) store.events.push(ev); else store.events[i] = ev;
  }

  function deleteEvent(id, opts) {
    const o = opts || {};
    const ev = findEvent(id);
    if (!ev) return { ok: false, error: 'Not found' };
    if (isReadOnly(ev)) return { ok: false, error: 'Subscribed calendars are read-only' };
    return mutate(() => {
      if (ev.rrule && o.scope === 'this' && E.isDate(o.occKey)) {
        replaceEvent(E.removeOccurrence(ev, o.occKey));
      } else if (ev.rrule && o.scope === 'following' && E.isDate(o.occKey)) {
        const { before } = E.splitSeries(ev, o.occKey, 'tmp');
        if (before) replaceEvent(before); else store.events = store.events.filter(e => e.id !== id);
      } else {
        store.events = store.events.filter(e => e.id !== id);
      }
      runtime.snoozes = runtime.snoozes.filter(s => findEvent(s.eventId) && E.occurrenceFor(findEvent(s.eventId), s.occKey));
      return { ok: true, state: publicState() };
    });
  }

  function setDone(id, occKey, done) {
    const ev = findEvent(id);
    if (!ev || ev.kind !== 'task') return { ok: false, error: 'Not a task' };
    if (isReadOnly(ev)) return { ok: false, error: 'Subscribed calendars are read-only' };
    return mutate(() => {
      const next = E.setTaskDone(ev, E.isDate(occKey) ? occKey : E.evStartDate(ev), !!done);
      next.updatedAt = Date.now();
      replaceEvent(next);
      if (done) runtime.snoozes = runtime.snoozes.filter(s => !(s.eventId === id && s.occKey === occKey));
      return { ok: true, state: publicState() };
    });
  }

  // ── Calendars ───────────────────────────────────────────────────────────

  function saveCalendar(input) {
    const existing = input && input.id ? findCalendar(input.id) : null;
    if (!existing && store.calendars.length >= MAX_CALENDARS) return { ok: false, error: 'That\'s the maximum number of calendars' };
    return mutate(() => {
      const clean = E.sanitizeCalendar(input, existing);
      if (existing) store.calendars[store.calendars.indexOf(existing)] = clean;
      else store.calendars.push(clean);
      return { ok: true, id: clean.id, state: publicState() };
    });
  }

  function deleteCalendar(id, opts) {
    const cal = findCalendar(id);
    if (!cal) return { ok: false, error: 'Not found' };
    const local = store.calendars.filter(c => !c.readOnly);
    if (!cal.readOnly && local.length <= 1) return { ok: false, error: 'Keep at least one calendar' };
    const moveTo = opts && opts.moveTo && findCalendar(opts.moveTo) && !findCalendar(opts.moveTo).readOnly && opts.moveTo !== id ? opts.moveTo : null;
    return mutate(() => {
      store.calendars = store.calendars.filter(c => c.id !== id);
      if (moveTo) {
        for (const ev of store.events) if (ev.calendarId === id) { ev.calendarId = moveTo; ev.updatedAt = Date.now(); }
      } else {
        store.events = store.events.filter(e => e.calendarId !== id);
      }
      return { ok: true, state: publicState() };
    });
  }

  // ── Import / export / backup ────────────────────────────────────────────

  function importEvents(parsed, calendarId, source) {
    const ctxS = { calendarIds: calendarIds(), defaultCalendarId: calendarId, defaultDuration: store.settings.defaultDuration, now: Date.now() };
    const out = [];
    for (const item of parsed.events) {
      const r = E.sanitizeEvent(Object.assign({}, item, { calendarId, source }), ctxS);
      if (!r.ok) continue;
      // sanitizeEvent keeps series bookkeeping only for a real series;
      // imported exceptions are re-applied through it too.
      out.push(r.event);
    }
    return out;
  }

  async function importIcsFile() {
    const win = ctx.getMainWindow();
    const res = await dialog.showOpenDialog(win, {
      title: 'Import calendar (.ics)',
      properties: ['openFile'],
      filters: [{ name: 'iCalendar', extensions: ['ics', 'ical', 'ifb', 'icalendar'] }]
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    let text;
    try {
      const st = fs.statSync(res.filePaths[0]);
      if (st.size > Ics.MAX_BYTES) return { ok: false, error: 'That file is larger than 8 MB' };
      text = fs.readFileSync(res.filePaths[0], 'utf8');
    } catch (e) {
      return { ok: false, error: 'Could not read that file' };
    }
    const parsed = Ics.parseIcs(text, { allDayReminderTime: store.settings.allDayReminderTime });
    if (!parsed.events.length) return { ok: false, error: parsed.warnings[0] || 'No events found' };
    const room = MAX_EVENTS - store.events.length;
    if (room <= 0) return { ok: false, error: 'The calendar is full' };
    const baseName = parsed.name || path.basename(res.filePaths[0]).replace(/\.[^.]+$/, '');
    return mutate(() => {
      const cal = E.sanitizeCalendar({ name: baseName, color: parsed.color || pickColor() }, null);
      if (store.calendars.length < MAX_CALENDARS) store.calendars.push(cal);
      const targetId = findCalendar(cal.id) ? cal.id : writableCalendarId();
      const events = importEvents(parsed, targetId, null).slice(0, room);
      store.events.push(...events);
      logger.success('Calendar: imported .ics', { events: events.length, skipped: parsed.skipped });
      return { ok: true, added: events.length, calendarId: targetId, warnings: parsed.warnings.slice(0, 3), state: publicState() };
    });
  }

  function pickColor() {
    const used = new Set(store.calendars.map(c => c.color));
    return E.PALETTE.find(c => !used.has(c)) || E.PALETTE[store.calendars.length % E.PALETTE.length];
  }

  async function exportIcsFile(calendarId) {
    const cal = calendarId ? findCalendar(calendarId) : null;
    const events = cal ? store.events.filter(e => e.calendarId === cal.id) : store.events.filter(e => !isReadOnly(e));
    const win = ctx.getMainWindow();
    const name = cal ? cal.name : 'main calendar';
    const res = await dialog.showSaveDialog(win, {
      title: 'Export calendar (.ics)',
      defaultPath: name.replace(/[\\/:*?"<>|]+/g, '-') + '.ics',
      filters: [{ name: 'iCalendar', extensions: ['ics'] }]
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    try {
      const byId = {};
      for (const c of store.calendars) byId[c.id] = c;
      fs.writeFileSync(res.filePath, Ics.serializeIcs(events, { name, calendarsById: byId, allDayReminderTime: store.settings.allDayReminderTime }), 'utf8');
      return { ok: true, count: events.length };
    } catch (e) {
      logger.error('Calendar: export failed', e);
      return { ok: false, error: 'Could not write that file' };
    }
  }

  async function exportBackup() {
    const res = await dialog.showSaveDialog(ctx.getMainWindow(), {
      title: 'Back up calendar',
      defaultPath: 'main-calendar-backup.json',
      filters: [{ name: 'Calendar backup', extensions: ['json'] }]
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    try {
      const data = { kind: 'main-calendar-backup', version: STORE_VERSION, exportedAt: Date.now(),
        calendars: store.calendars, events: store.events.filter(e => !isReadOnly(e)), settings: store.settings };
      fs.writeFileSync(res.filePath, JSON.stringify(data, null, 2), 'utf8');
      return { ok: true, count: data.events.length };
    } catch (e) {
      logger.error('Calendar: backup failed', e);
      return { ok: false, error: 'Could not write that file' };
    }
  }

  async function importBackup() {
    const res = await dialog.showOpenDialog(ctx.getMainWindow(), {
      title: 'Restore calendar backup',
      properties: ['openFile'],
      filters: [{ name: 'Calendar backup', extensions: ['json'] }]
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    let data;
    try {
      if (fs.statSync(res.filePaths[0]).size > 30 * 1024 * 1024) return { ok: false, error: 'That file is too large' };
      data = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8'));
    } catch (e) {
      return { ok: false, error: 'That isn\'t a readable backup file' };
    }
    if (!data || data.kind !== 'main-calendar-backup' || !Array.isArray(data.events)) return { ok: false, error: 'That isn\'t a main calendar backup' };
    // Restoring MERGES: calendars and events are matched by id, so restoring
    // twice never duplicates, and nothing already here is thrown away.
    return mutate(() => {
      let added = 0;
      for (const c of Array.isArray(data.calendars) ? data.calendars : []) {
        if (!c || c.source === 'ics' || findCalendar(c.id) || store.calendars.length >= MAX_CALENDARS) continue;
        store.calendars.push(E.sanitizeCalendar(c, null));
      }
      const ctxS = sanitizeCtx();
      for (const ev of data.events.slice(0, MAX_EVENTS)) {
        if (store.events.length >= MAX_EVENTS) break;
        const r = E.sanitizeEvent(ev, ctxS);
        if (!r.ok) continue;
        if (findEvent(r.event.id)) replaceEvent(r.event); else { store.events.push(r.event); added++; }
      }
      if (data.settings) store.settings = E.sanitizeSettings(data.settings, store.settings);
      return { ok: true, added, state: publicState() };
    });
  }

  // ── Subscriptions ───────────────────────────────────────────────────────

  function normalizeFeedUrl(raw) {
    let s = String(raw || '').trim();
    if (/^webcals?:\/\//i.test(s)) s = 'https://' + s.replace(/^webcals?:\/\//i, '');
    const href = E.safeHttpUrl(s);
    if (!href) return null;
    // Only real network hosts — never a file:// or a local-machine address a
    // pasted link could use to probe the user's own services.
    const host = new URL(href).hostname;
    if (/^(localhost|127\.|0\.0\.0\.0|\[?::1\]?$)/i.test(host)) return null;
    return href;
  }

  async function fetchFeed(url) {
    const res = await netFetch(url, { headers: { Accept: 'text/calendar, text/plain, */*' }, timeout: 25000 });
    if (!res.ok) throw new Error('The server answered ' + res.status);
    const text = await res.text();
    if (text.length > Ics.MAX_BYTES) throw new Error('The calendar feed is larger than 8 MB');
    return text;
  }

  async function subscribe(input) {
    const url = normalizeFeedUrl(input && input.url);
    if (!url) return { ok: false, error: 'Paste an https:// or webcal:// calendar link' };
    if (store.calendars.some(c => c.url === url)) return { ok: false, error: 'You are already subscribed to that calendar' };
    if (store.calendars.length >= MAX_CALENDARS) return { ok: false, error: 'That\'s the maximum number of calendars' };
    let text;
    try {
      text = await fetchFeed(url);
    } catch (e) {
      logger.warn('Calendar: subscription fetch failed', { error: e.message });
      return { ok: false, error: 'Couldn\'t download that calendar — ' + e.message };
    }
    const parsed = Ics.parseIcs(text, { allDayReminderTime: store.settings.allDayReminderTime });
    if (!parsed.events.length && parsed.warnings.length) return { ok: false, error: parsed.warnings[0] };
    return mutate(() => {
      const base = E.sanitizeCalendar({ name: (input && input.name) || parsed.name || new URL(url).hostname, color: (input && input.color) || parsed.color || pickColor() }, null);
      const cal = Object.assign(base, { source: 'ics', url, refreshHours: 6, lastSync: Date.now(), lastError: null, readOnly: true, notify: input && typeof input.notify === 'boolean' ? input.notify : true });
      store.calendars.push(cal);
      const events = importEvents(parsed, cal.id, 'ics:' + cal.id).slice(0, Math.max(0, MAX_EVENTS - store.events.length));
      store.events.push(...events);
      ensureSubTimer();
      logger.success('Calendar: subscribed', { host: new URL(url).hostname, events: events.length });
      return { ok: true, id: cal.id, added: events.length, state: publicState() };
    });
  }

  async function refreshSubscription(id) {
    const cal = findCalendar(id);
    if (!cal || cal.source !== 'ics' || !cal.url) return { ok: false, error: 'Not a subscribed calendar' };
    if (refreshing.has(id)) return { ok: false, error: 'Already refreshing' };
    refreshing.add(id);
    try {
      const text = await fetchFeed(cal.url);
      const parsed = Ics.parseIcs(text, { allDayReminderTime: store.settings.allDayReminderTime });
      if (!findCalendar(id)) return { ok: false, error: 'Removed' };
      return mutate(() => {
        const events = importEvents(parsed, id, 'ics:' + id);
        // Keep ids stable across refreshes (by UID) so snoozes and the
        // history keep pointing at the same events.
        const oldByUid = new Map(store.events.filter(e => e.calendarId === id && e.uid).map(e => [e.uid, e.id]));
        for (const ev of events) if (ev.uid && oldByUid.has(ev.uid)) ev.id = oldByUid.get(ev.uid);
        const others = store.events.filter(e => e.calendarId !== id);
        store.events = others.concat(events.slice(0, Math.max(0, MAX_EVENTS - others.length)));
        const c = findCalendar(id);
        c.lastSync = Date.now();
        c.lastError = null;
        return { ok: true, count: events.length, state: publicState() };
      });
    } catch (e) {
      const c = findCalendar(id);
      if (c) {
        c.lastError = String(e.message || e).slice(0, 160);
        c.lastSync = c.lastSync || null;
        saveStoreSoon();
        broadcast();
      }
      logger.warn('Calendar: subscription refresh failed', { error: e.message });
      return { ok: false, error: 'Couldn\'t refresh — ' + (e.message || 'network error') };
    } finally {
      refreshing.delete(id);
    }
  }

  function ensureSubTimer() {
    clearInterval(subTimer);
    subTimer = null;
    if (!store.enabled || tornDown || !store.calendars.some(c => c.source === 'ics')) return;
    subTimer = setInterval(refreshDueSubscriptions, SUB_CHECK_MS);
  }

  function refreshDueSubscriptions() {
    const now = Date.now();
    for (const c of store.calendars) {
      if (c.source !== 'ics') continue;
      const due = !c.lastSync || now - c.lastSync > (c.refreshHours || 6) * 3600000;
      if (due) refreshSubscription(c.id).catch(() => {});
    }
  }

  // ── Enable / settings ───────────────────────────────────────────────────

  function setEnabled(enabled, env) {
    const on = !!enabled;
    if (env && typeof env.clock24 === 'boolean' && env.clock24 !== store.settings.clock24) {
      store.settings = E.sanitizeSettings({ clock24: env.clock24 }, store.settings);
      saveStoreSoon();
    }
    if (on === store.enabled) {
      if (on && !timer) reschedule();
      return { ok: true, state: publicState() };
    }
    store.enabled = on;
    if (on) {
      // Whatever came due while the widget was switched off is not "missed" —
      // the user turned reminders off. Start counting from now.
      runtime.watermark = Date.now();
      saveRuntime();
      reschedule();
      ensureSubTimer();
      setTimeout(refreshDueSubscriptions, 15000);
    } else {
      clearTimeout(timer);
      timer = null;
      clearInterval(subTimer);
      subTimer = null;
    }
    saveStoreNow();
    logger.log('Calendar ' + (on ? 'enabled' : 'disabled'));
    return { ok: true, state: publicState() };
  }

  function setSettings(patch) {
    return mutate(() => {
      store.settings = E.sanitizeSettings(patch, store.settings);
      return { ok: true, state: publicState() };
    });
  }

  function testNotification() {
    const now = Date.now();
    const occ = {
      uid: 'test|' + E.todayStr(now), eventId: null, occKey: E.todayStr(now), kind: 'event', title: 'Chemistry lab',
      location: 'Room 204', notes: '', url: '', important: false, allDay: false,
      start: E.fromWall(E.wall(E.nowDateTime(now)) + 10), end: E.fromWall(E.wall(E.nowDateTime(now)) + 70)
    };
    const a = E.describeAlert(occ, now, envOpts());
    present({ id: 't' + now.toString(36), kind: 'test', title: a.title, body: a.body + ' · (test)', occ: Object.assign(occ, { eventId: null }), important: false, now });
    saveRuntime();
    broadcast();
    return { ok: true, quiet: E.inQuietHours(store.settings, now) };
  }

  // ── IPC ─────────────────────────────────────────────────────────────────
  // Every handler catches: the renderer gets { ok:false, error } rather than a
  // rejected promise, and the failure is in the log.
  function handle(channel, fn) {
    ipcMain.handle(channel, async (_e, ...args) => {
      try {
        return await fn(...args);
      } catch (e) {
        logger.error('Calendar: ' + channel + ' failed', e);
        return { ok: false, error: 'Something went wrong' };
      }
    });
  }

  handle('calendar:get', () => publicState());
  handle('calendar:set-enabled', (enabled, env) => setEnabled(enabled, env));
  handle('calendar:save-event', (ev, opts) => saveEvent(ev, opts));
  handle('calendar:delete-event', (id, opts) => deleteEvent(String(id || ''), opts));
  handle('calendar:set-done', (id, occKey, done) => setDone(String(id || ''), occKey, done));
  handle('calendar:save-calendar', (cal) => saveCalendar(cal));
  handle('calendar:delete-calendar', (id, opts) => deleteCalendar(String(id || ''), opts));
  handle('calendar:set-settings', (patch) => setSettings(patch));
  handle('calendar:snooze', (eventId, occKey, minutes) => snooze(String(eventId || ''), occKey, minutes));
  handle('calendar:history-read', (id) => { markRead(typeof id === 'string' ? id : '*'); return { ok: true }; });
  handle('calendar:history-clear', () => { runtime.history = []; saveRuntime(); broadcast(); return { ok: true }; });
  handle('calendar:test-notify', () => testNotification());
  handle('calendar:open-link', (url) => ({ ok: openLink(url) }));
  handle('calendar:import-ics', () => importIcsFile());
  handle('calendar:export-ics', (calendarId) => exportIcsFile(typeof calendarId === 'string' ? calendarId : null));
  handle('calendar:backup-export', () => exportBackup());
  handle('calendar:backup-import', () => importBackup());
  handle('calendar:subscribe', (input) => subscribe(input));
  handle('calendar:refresh', (id) => refreshSubscription(String(id || '')));

  // Sleep and screen-lock pause Node timers. On the way back, run a pass
  // straight away so anything that came due while asleep is handled now
  // rather than at the next capped wake.
  const onWake = () => { if (store.enabled) setTimeout(() => { tick(false); reschedule(); }, 2500); };
  try {
    powerMonitor.on('resume', onWake);
    powerMonitor.on('unlock-screen', onWake);
  } catch (e) {
    logger.warn('Calendar: powerMonitor unavailable', { error: e.message });
  }

  if (store.enabled) {
    // Boot pass after the window has had a moment to load, so the renderer
    // is listening when any catch-up alert is announced.
    setTimeout(() => { tick(false); reschedule(); }, 4000);
    ensureSubTimer();
    setTimeout(refreshDueSubscriptions, 20000);
  }
  if (needsRepairSave) {
    saveStoreNow();
    logger.system('Calendar: repaired events that had no usable id');
  }
  logger.success('Calendar module ready', { events: store.events.length, enabled: store.enabled });

  function teardown() {
    tornDown = true;
    clearTimeout(timer);
    clearInterval(subTimer);
    if (saveTimer) saveStoreNow();
    try { powerMonitor.removeListener('resume', onWake); powerMonitor.removeListener('unlock-screen', onWake); } catch (e) { /* ignore */ }
  }

  return { teardown, getState: publicState };
}

module.exports = { init };
