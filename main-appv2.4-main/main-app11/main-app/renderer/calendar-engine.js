// Calendar engine — the pure logic behind the Calendar mini widget.
//
// No DOM, no Electron, no Node built-ins, so every rule here is unit-tested
// directly (test/calendar-engine.test.js). Loaded two ways, like
// widget-platform.js:
//   • renderer — a <script> before renderer/calendar.js → window.CalendarEngine
//   • main     — require('../renderer/calendar-engine') from main/calendar.js,
//                which owns the data and fires the reminders
// Both halves MUST agree on what an occurrence is and when a reminder is due,
// which is why this is one file rather than two copies that could drift.
//
// ── Time model ──────────────────────────────────────────────────────────────
// Every stored time is a LOCAL WALL-CLOCK string: 'YYYY-MM-DD' for all-day,
// 'YYYY-MM-DDTHH:mm' for timed. Never a UTC instant. A weekly 10:00 class stays
// at 10:00 across a daylight-saving change, which an instant-based model gets
// wrong twice a year. Date arithmetic runs on a day number computed in UTC
// space, where every day is exactly 24 hours, and durations run on a linear
// "wall minute" scale — so no DST transition can stretch or shrink an event.
// Only reminders convert to real instants (they have to fire at a moment).
(function (root) {
  'use strict';

  const MS_MIN = 60000;
  const MS_HOUR = 3600000;
  const MS_DAY = 86400000;
  // The longest reminder offset accepted: four weeks. Also bounds how far ahead
  // the scheduler expands recurrences when looking for the next due reminder.
  const MAX_OFFSET = 40320;
  // The scheduler never sleeps longer than this. A cheap re-check every 15 min
  // also absorbs a changed system clock or time zone without any hook.
  const WAKE_CAP = 15 * MS_MIN;
  // A gap longer than this between scans means main was not running (closed,
  // asleep) — reminders that came due inside it and are no longer useful get
  // reported as "missed" rather than silently dropped.
  const AWAY_MS = 2 * MS_MIN;
  // Hard ceiling on loop iterations in recurrence expansion — a safety net
  // against a malformed rule, never reached by a real one.
  const MAX_ITER = 20000;

  const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  const DT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
  const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // ── Date primitives ─────────────────────────────────────────────────────

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(y, m, d) { return y + '-' + pad2(m) + '-' + pad2(d); }

  function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

  function isDate(s) {
    if (typeof s !== 'string') return false;
    const m = DATE_RE.exec(s);
    if (!m) return false;
    const y = +m[1], mo = +m[2], d = +m[3];
    return y >= 1900 && y <= 2200 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
  }

  function isDateTime(s) {
    if (typeof s !== 'string') return false;
    const m = DT_RE.exec(s);
    return !!m && isDate(s.slice(0, 10)) && +m[4] <= 23 && +m[5] <= 59;
  }

  function isTime(s) { return typeof s === 'string' && TIME_RE.test(s); }

  // Days since 1970-01-01 for a 'YYYY-MM-DD' (or the date part of a datetime).
  function dayNum(d) {
    return Math.round(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / MS_DAY);
  }

  function fromDayNum(n) {
    const dt = new Date(n * MS_DAY);
    return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }

  function addDays(d, n) { return fromDayNum(dayNum(d) + n); }
  function diffDays(a, b) { return dayNum(b) - dayNum(a); }
  // 0 = Sunday. 1970-01-01 was a Thursday.
  function dow(d) { return (((dayNum(d) + 4) % 7) + 7) % 7; }

  function addMonths(d, n) {
    const y = +d.slice(0, 4), m = +d.slice(5, 7), day = +d.slice(8, 10);
    const total = (m - 1) + n;
    const ny = y + Math.floor(total / 12);
    const nm = ((total % 12) + 12) % 12 + 1;
    return ymd(ny, nm, Math.min(day, daysInMonth(ny, nm)));
  }

  function startOfWeek(d, weekStart) {
    const ws = weekStart === 0 ? 0 : (weekStart || 1);
    return addDays(d, -((dow(d) - ws + 7) % 7));
  }

  function startOfMonth(d) { return d.slice(0, 8) + '01'; }
  function endOfMonth(d) { return d.slice(0, 8) + pad2(daysInMonth(+d.slice(0, 4), +d.slice(5, 7))); }

  // ISO-8601 week number (weeks start Monday; week 1 holds the first Thursday).
  function isoWeek(d) {
    const thursday = addDays(d, 3 - ((dow(d) + 6) % 7));
    const jan1 = thursday.slice(0, 4) + '-01-01';
    return Math.floor(diffDays(jan1, thursday) / 7) + 1;
  }

  function datePart(s) { return s.slice(0, 10); }
  function timePart(s) { return s && s.length > 10 ? s.slice(11, 16) : null; }
  function minutesOf(t) { return +t.slice(0, 2) * 60 + +t.slice(3, 5); }
  function hhmm(min) {
    const m = ((min % 1440) + 1440) % 1440;
    return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
  }

  // The linear wall-minute scale: every day is 1440 minutes, always.
  function wall(s) {
    return dayNum(s) * 1440 + (s.length > 10 ? minutesOf(timePart(s)) : 0);
  }
  function fromWall(w) {
    const d = Math.floor(w / 1440);
    return fromDayNum(d) + 'T' + hhmm(w - d * 1440);
  }

  // Wall-clock string → real instant (ms) in the machine's own time zone.
  function instant(s) {
    const t = timePart(s);
    return new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10),
      t ? +t.slice(0, 2) : 0, t ? +t.slice(3, 5) : 0, 0, 0).getTime();
  }

  function todayStr(ms) {
    const d = new Date(ms);
    return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }

  function nowDateTime(ms) {
    const d = new Date(ms);
    return todayStr(ms) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function minuteOfDay(ms) {
    const d = new Date(ms);
    return d.getHours() * 60 + d.getMinutes();
  }

  // ── Formatting (shared by the UI and the notifications main sends) ──────

  function fmtTime(t, clock24) {
    if (!t) return '';
    if (clock24) return t;
    let h = +t.slice(0, 2);
    const mm = t.slice(3, 5);
    const ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return (mm === '00' ? String(h) : h + ':' + mm) + ' ' + ap;
  }

  // "10 – 11 AM" style ranges collapse the shared meridiem, like Apple/Google.
  function fmtTimeRange(a, b, clock24) {
    if (!b || a === b) return fmtTime(a, clock24);
    if (clock24) return a + ' – ' + b;
    const am = +a.slice(0, 2) < 12, bm = +b.slice(0, 2) < 12;
    if (am === bm) return fmtTime(a, false).replace(/ (AM|PM)$/, '') + ' – ' + fmtTime(b, false);
    return fmtTime(a, false) + ' – ' + fmtTime(b, false);
  }

  function fmtDateShort(d) {
    return WEEKDAYS_SHORT[dow(d)] + ', ' + MONTHS_SHORT[+d.slice(5, 7) - 1] + ' ' + (+d.slice(8, 10));
  }
  function fmtDateLong(d) {
    return WEEKDAYS[dow(d)] + ', ' + MONTHS[+d.slice(5, 7) - 1] + ' ' + (+d.slice(8, 10));
  }
  function fmtMonthYear(d) { return MONTHS[+d.slice(5, 7) - 1] + ' ' + d.slice(0, 4); }

  // "Today" / "Tomorrow" / "Yesterday" / "Fri, Sep 12" relative to `today`.
  function fmtDayLabel(d, today) {
    const n = diffDays(today, d);
    if (n === 0) return 'Today';
    if (n === 1) return 'Tomorrow';
    if (n === -1) return 'Yesterday';
    if (n > 1 && n < 7) return WEEKDAYS[dow(d)];
    return fmtDateShort(d);
  }

  function fmtDuration(min) {
    if (min < 60) return min + ' min';
    const h = Math.floor(min / 60), m = min % 60;
    if (h >= 24 && m === 0 && h % 24 === 0) return (h / 24) + (h === 24 ? ' day' : ' days');
    return h + ' h' + (m ? ' ' + m + ' min' : '');
  }

  // Reminder offsets, spoken the way people say them: "10 min", "1 hour",
  // "1 day", "At start". `allDay` reads 0 as "On the day".
  function fmtOffset(min, allDay) {
    if (min === 0) return allDay ? 'On the day' : 'At start';
    if (min % 10080 === 0) { const w = min / 10080; return w + (w === 1 ? ' week' : ' weeks'); }
    if (min % 1440 === 0) { const d = min / 1440; return d + (d === 1 ? ' day' : ' days'); }
    if (min % 60 === 0) { const h = min / 60; return h + (h === 1 ? ' hour' : ' hours'); }
    return min + ' min';
  }

  // ── Event shape helpers (they work on events AND occurrences) ───────────

  function evStartDate(ev) { return datePart(ev.start); }

  // Inclusive last date the item touches. A timed event ending exactly at
  // midnight does not touch the next day.
  function evEndDate(ev) {
    if (ev.allDay) return datePart(ev.end || ev.start);
    if (!ev.end || ev.kind === 'task') return datePart(ev.start);
    if (timePart(ev.end) === '00:00' && wall(ev.end) > wall(ev.start)) return addDays(datePart(ev.end), -1);
    return datePart(ev.end);
  }

  function spanDays(ev) { return Math.max(0, diffDays(evStartDate(ev), evEndDate(ev))); }

  function durationMinutes(ev) {
    if (ev.allDay || ev.kind === 'task' || !ev.end) return 0;
    return Math.max(0, wall(ev.end) - wall(ev.start));
  }

  // ── Recurrence ──────────────────────────────────────────────────────────
  // rrule: { freq: 'daily'|'weekly'|'monthly'|'yearly', interval, byDay[] (weekly),
  //          monthMode: 'day'|'nth' (monthly/yearly), nth (1..4 | -1),
  //          until: 'YYYY-MM-DD' | null, count | null, wkst }
  //
  // Occurrences are identified by their ORIGINAL start date (the "occKey").
  // Semantics follow RFC 5545: COUNT counts the instances the rule generates,
  // EXDATE removes instances afterwards (so an exception never shifts COUNT),
  // and impossible dates (the 31st of April, Feb 29 in 2027) are skipped and
  // do not count.

  const FREQS = ['daily', 'weekly', 'monthly', 'yearly'];

  // Which "nth weekday" a date is: the 2nd Tuesday, or the last (-1) Friday
  // when it falls in the fifth week.
  function nthOfMonth(d) {
    const n = Math.ceil(+d.slice(8, 10) / 7);
    return n >= 5 ? -1 : n;
  }

  function nthWeekdayOfMonth(y, m, wd, nth) {
    const dim = daysInMonth(y, m);
    if (nth === -1) {
      const lastDow = dow(ymd(y, m, dim));
      return dim - ((lastDow - wd + 7) % 7);
    }
    const firstDow = dow(ymd(y, m, 1));
    const day = 1 + ((wd - firstDow + 7) % 7) + (nth - 1) * 7;
    return day <= dim ? day : 0;
  }

  // Every occKey whose occurrence STARTS within [from, to] (inclusive dates),
  // honouring count/until and excluding exdates.
  function occurrenceKeys(ev, from, to) {
    const start = evStartDate(ev);
    const ex = ev.exdates && ev.exdates.length ? new Set(ev.exdates) : null;
    const r = ev.rrule;
    if (!r) return (start >= from && start <= to && !(ex && ex.has(start))) ? [start] : [];

    const out = [];
    const until = r.until && r.until < to ? r.until : to;
    const count = r.count > 0 ? r.count : 0;
    const interval = Math.max(1, r.interval || 1);
    if (from < start) from = start;
    if (from > until) return out;
    let guard = 0;

    if (r.freq === 'daily') {
      let k = Math.max(0, Math.ceil(diffDays(start, from) / interval));
      for (; ; k++) {
        if (++guard > MAX_ITER) break;
        if (count && k >= count) break;
        const d = addDays(start, k * interval);
        if (d > until) break;
        if (!ex || !ex.has(d)) out.push(d);
      }
      return out;
    }

    if (r.freq === 'weekly') {
      const wkst = typeof r.wkst === 'number' ? r.wkst : 1;
      const days = r.byDay && r.byDay.length ? r.byDay : [dow(start)];
      const offs = Array.from(new Set(days.map(d => (d - wkst + 7) % 7))).sort((a, b) => a - b);
      const anchor = startOfWeek(start, wkst);
      const startOff = diffDays(anchor, start);
      const firstCount = offs.filter(o => o >= startOff).length;
      let n = Math.max(0, Math.floor(diffDays(anchor, from) / (7 * interval)));
      outer:
      for (; ; n++) {
        if (++guard > MAX_ITER) break;
        const wkStart = addDays(anchor, n * 7 * interval);
        if (wkStart > until) break;
        for (let j = 0; j < offs.length; j++) {
          if (n === 0 && offs[j] < startOff) continue;
          const idx = n === 0 ? j - (offs.length - firstCount) : firstCount + (n - 1) * offs.length + j;
          if (count && idx >= count) break outer;
          const d = addDays(wkStart, offs[j]);
          if (d > until) break outer;
          if (d >= from && (!ex || !ex.has(d))) out.push(d);
        }
      }
      return out;
    }

    if (r.freq === 'monthly' || r.freq === 'yearly') {
      const sy = +start.slice(0, 4), sm = +start.slice(5, 7), sd = +start.slice(8, 10);
      const nthMode = r.monthMode === 'nth';
      const wd = dow(start);
      const nth = r.nth === -1 || (r.nth >= 1 && r.nth <= 4) ? r.nth : nthOfMonth(start);
      const monthly = r.freq === 'monthly';
      let k = 0;
      let idx = 0;
      // Without COUNT the index is irrelevant, so jump close to the range
      // instead of walking every month since the series began.
      if (!count) {
        if (monthly) {
          const monthsToFrom = (+from.slice(0, 4) - sy) * 12 + (+from.slice(5, 7) - sm);
          k = Math.max(0, Math.floor(monthsToFrom / interval) - 1);
        } else {
          k = Math.max(0, Math.floor((+from.slice(0, 4) - sy) / interval) - 1);
        }
      }
      for (; ; k++) {
        if (++guard > MAX_ITER) break;
        let y, m;
        if (monthly) {
          const total = sm - 1 + k * interval;
          y = sy + Math.floor(total / 12);
          m = total % 12 + 1;
        } else {
          y = sy + k * interval;
          m = sm;
        }
        if (ymd(y, m, 1) > until) break;
        const day = nthMode ? nthWeekdayOfMonth(y, m, wd, nth) : (sd <= daysInMonth(y, m) ? sd : 0);
        if (!day) continue;
        const d = ymd(y, m, day);
        if (d < start) continue;
        if (count && idx >= count) break;
        idx++;
        if (d > until) break;
        if (d >= from && (!ex || !ex.has(d))) out.push(d);
      }
      return out;
    }
    return out;
  }

  // Is `key` an occurrence the rule generates (ignoring exdates)?
  function isOccurrence(ev, key) {
    if (!isDate(key)) return false;
    if (!ev.rrule) return key === evStartDate(ev);
    return occurrenceKeys(Object.assign({}, ev, { exdates: [] }), key, key).length === 1;
  }

  function buildOccurrence(ev, key, ov) {
    let allDay = !!ev.allDay;
    let start, end;
    if (ov && ov.start) {
      if (typeof ov.allDay === 'boolean') allDay = ov.allDay;
      start = ov.start;
      end = ov.end || ov.start;
    } else {
      const shift = diffDays(evStartDate(ev), key);
      if (allDay) {
        start = key;
        end = addDays(datePart(ev.end || ev.start), shift);
      } else {
        start = key + 'T' + timePart(ev.start);
        end = ev.end ? fromWall(wall(ev.end) + shift * 1440) : start;
      }
    }
    const kind = ev.kind === 'task' ? 'task' : 'event';
    if (kind === 'task') end = start;
    const pick = (f) => (ov && typeof ov[f] === 'string' ? ov[f] : (ev[f] || ''));
    return {
      uid: ev.id + '|' + key,
      eventId: ev.id,
      occKey: key,
      calendarId: ev.calendarId,
      kind,
      title: pick('title'),
      location: pick('location'),
      notes: pick('notes'),
      url: ev.url || '',
      important: !!ev.important,
      allDay,
      start,
      end,
      recurring: !!ev.rrule,
      overridden: !!ov,
      done: kind === 'task' ? (ev.rrule ? (ev.doneDates || []).indexOf(key) !== -1 : !!ev.done) : false,
      source: ev.source || null
    };
  }

  function overlapsRange(occ, from, to) {
    return evStartDate(occ) <= to && evEndDate(occ) >= from;
  }

  // Occurrences of one event that overlap [from, to] (inclusive dates).
  function expandEvent(ev, from, to) {
    const out = [];
    const ov = (ev.rrule && ev.overrides) || null;
    const ovKeys = ov ? Object.keys(ov) : [];
    const keys = occurrenceKeys(ev, addDays(from, -spanDays(ev)), to);
    for (const key of keys) {
      if (ov && ov[key]) continue;
      const occ = buildOccurrence(ev, key, null);
      if (overlapsRange(occ, from, to)) out.push(occ);
    }
    // A moved occurrence can land far from its original date, so overrides
    // are checked on their own rather than only where the rule would put them.
    for (const key of ovKeys) {
      if (ev.exdates && ev.exdates.indexOf(key) !== -1) continue;
      const occ = buildOccurrence(ev, key, ov[key]);
      if (!overlapsRange(occ, from, to)) continue;
      if (!isOccurrence(ev, key)) continue;
      out.push(occ);
    }
    return out;
  }

  function compareOccurrences(a, b) {
    const ad = evStartDate(a), bd = evStartDate(b);
    if (ad !== bd) return ad < bd ? -1 : 1;
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    if (a.start !== b.start) return a.start < b.start ? -1 : 1;
    const al = durationMinutes(a), bl = durationMinutes(b);
    if (al !== bl) return bl - al;
    return String(a.title).localeCompare(String(b.title));
  }

  // All occurrences of `events` overlapping [from, to], sorted. `include`
  // (optional) filters events first — e.g. hidden calendars.
  function expandAll(events, from, to, include) {
    const out = [];
    for (const ev of events || []) {
      if (include && !include(ev)) continue;
      const occs = expandEvent(ev, from, to);
      for (let i = 0; i < occs.length; i++) out.push(occs[i]);
    }
    return out.sort(compareOccurrences);
  }

  function occurrencesOnDay(occs, d) {
    return occs.filter(o => evStartDate(o) <= d && evEndDate(o) >= d);
  }

  // The occurrence of `ev` identified by occKey, as it currently stands (with
  // any override), or null when it no longer exists. A non-recurring event
  // that was moved since the key was taken still resolves — it has only one.
  function occurrenceFor(ev, occKey) {
    if (!ev) return null;
    if (!ev.rrule) return buildOccurrence(ev, evStartDate(ev), null);
    if (ev.exdates && ev.exdates.indexOf(occKey) !== -1) return null;
    const ov = ev.overrides && ev.overrides[occKey];
    if (ov) return buildOccurrence(ev, occKey, ov);
    return isOccurrence(ev, occKey) ? buildOccurrence(ev, occKey, null) : null;
  }

  // The first occurrence still running or yet to come on/after `fromDate`.
  function nextOccurrence(ev, fromDate, horizonDays) {
    const horizon = horizonDays || 1100;
    if (!ev.rrule) {
      const occ = buildOccurrence(ev, evStartDate(ev), null);
      return evEndDate(occ) >= fromDate ? occ : null;
    }
    for (let off = 0; off < horizon; off += 120) {
      const a = addDays(fromDate, off);
      const occs = expandEvent(ev, a, addDays(a, 119)).sort(compareOccurrences);
      const hit = occs.find(o => evEndDate(o) >= fromDate);
      if (hit) return hit;
      if (ev.rrule.until && ev.rrule.until < a) break;
    }
    return null;
  }

  // ── Mutations (pure: each returns a new event) ──────────────────────────

  function clone(ev) { return JSON.parse(JSON.stringify(ev)); }

  // Edit ONE occurrence of a series: stored as an override keyed by occKey.
  function editOccurrence(ev, occKey, patch) {
    const next = clone(ev);
    const base = occurrenceFor(ev, occKey) || buildOccurrence(ev, occKey, null);
    const ov = {
      start: patch.start || base.start,
      end: patch.end || base.end,
      allDay: typeof patch.allDay === 'boolean' ? patch.allDay : base.allDay
    };
    for (const f of ['title', 'location', 'notes']) {
      const v = typeof patch[f] === 'string' ? patch[f] : base[f];
      if (v !== (ev[f] || '')) ov[f] = v;
    }
    next.overrides = Object.assign({}, next.overrides, { [occKey]: ov });
    return next;
  }

  // Delete ONE occurrence of a series.
  function removeOccurrence(ev, occKey) {
    const next = clone(ev);
    next.exdates = Array.from(new Set((next.exdates || []).concat(occKey))).sort();
    if (next.overrides) delete next.overrides[occKey];
    if (next.doneDates) next.doneDates = next.doneDates.filter(d => d !== occKey);
    return next;
  }

  // "This and following": end the series the day before occKey and start a
  // second series at occKey. Exceptions, overrides and done-marks go with
  // whichever half they belong to; a COUNT is split so the total is unchanged.
  // Returns { before, after } — `before` is null when occKey is the very first
  // occurrence (the whole series is "following").
  function splitSeries(ev, occKey, newId) {
    const start = evStartDate(ev);
    if (!ev.rrule || occKey <= start) return { before: null, after: clone(ev) };
    const r = ev.rrule;
    const generatedBefore = occurrenceKeys(Object.assign({}, ev, { exdates: [] }), start, addDays(occKey, -1)).length;
    const before = clone(ev);
    const after = clone(ev);
    before.rrule = Object.assign({}, r, { until: addDays(occKey, -1), count: null });
    if (r.count) before.rrule = Object.assign({}, r, { until: null, count: generatedBefore });

    after.id = newId;
    const shift = diffDays(start, occKey);
    if (ev.allDay) {
      after.start = occKey;
      after.end = addDays(datePart(ev.end || ev.start), shift);
    } else {
      after.start = occKey + 'T' + timePart(ev.start);
      after.end = ev.end ? fromWall(wall(ev.end) + shift * 1440) : after.start;
    }
    if (ev.kind === 'task') after.end = after.start;
    after.rrule = Object.assign({}, r);
    if (r.count) after.rrule.count = Math.max(1, r.count - generatedBefore);
    // A weekly series anchored on a new week keeps its weekday set; a monthly
    // "nth weekday" keeps its nth (occKey is itself such a weekday).
    const part = (list, keep) => (list || []).filter(keep);
    before.exdates = part(ev.exdates, d => d < occKey);
    after.exdates = part(ev.exdates, d => d >= occKey);
    before.doneDates = part(ev.doneDates, d => d < occKey);
    after.doneDates = part(ev.doneDates, d => d >= occKey);
    before.overrides = {};
    after.overrides = {};
    for (const k of Object.keys(ev.overrides || {})) {
      (k < occKey ? before.overrides : after.overrides)[k] = ev.overrides[k];
    }
    return { before, after };
  }

  function setTaskDone(ev, occKey, done) {
    const next = clone(ev);
    if (next.rrule) {
      const set = new Set(next.doneDates || []);
      if (done) set.add(occKey); else set.delete(occKey);
      next.doneDates = Array.from(set).sort();
    } else {
      next.done = !!done;
    }
    return next;
  }

  // Where an occurrence lands after a drag: moved by whole days and/or wall
  // minutes, or (resize) with only its end changed. Never shorter than 15 min.
  function movedTimes(occ, dayDelta, minuteDelta, resizeOnly) {
    if (occ.allDay) {
      const end = evEndDate(occ);
      if (resizeOnly) {
        const ne = addDays(end, dayDelta);
        return { start: occ.start, end: ne < occ.start ? occ.start : ne };
      }
      return { start: addDays(occ.start, dayDelta), end: addDays(end, dayDelta) };
    }
    const s = wall(occ.start);
    const e = occ.kind === 'task' ? s : wall(occ.end || occ.start);
    const delta = dayDelta * 1440 + minuteDelta;
    if (resizeOnly) return { start: occ.start, end: fromWall(Math.max(s + 15, e + delta)) };
    const ns = fromWall(s + delta);
    return { start: ns, end: occ.kind === 'task' ? ns : fromWall(e + delta) };
  }

  // ── Reminders & the scheduler ───────────────────────────────────────────
  // A reminder is `offset` minutes before a BASE time: the start of a timed
  // item, or `allDayReminderTime` (09:00 by default) on the day of an all-day
  // one — so "1 day before" an all-day exam means 09:00 the day before, not
  // midnight.

  function effectiveReminders(ev, cal) {
    if (Array.isArray(ev.reminders)) return ev.reminders;
    if (cal) {
      const list = ev.allDay ? cal.defaultAllDayReminders : cal.defaultReminders;
      if (Array.isArray(list)) return list;
    }
    return ev.allDay ? [0] : [10];
  }

  function reminderBaseMs(occ, settings) {
    if (occ.allDay) return instant(datePart(occ.start) + 'T' + ((settings && settings.allDayReminderTime) || '09:00'));
    return instant(occ.start);
  }

  function occStartMs(occ) { return instant(occ.allDay ? datePart(occ.start) : occ.start); }

  function occEndMs(occ) {
    if (occ.allDay) return instant(addDays(evEndDate(occ), 1));
    if (occ.kind === 'task' || !occ.end) return instant(occ.start);
    return instant(occ.end);
  }

  // A reminder that comes late is still worth showing until this moment: ten
  // minutes after a timed start, or the end of an all-day item's last day.
  function relevantUntil(occ) {
    if (occ.allDay) return occEndMs(occ);
    return instant(occ.start) + 10 * MS_MIN;
  }

  function calendarMap(state) {
    const m = new Map();
    for (const c of (state && state.calendars) || []) m.set(c.id, c);
    return m;
  }

  // Every reminder instance with fireAt in [fromMs, toMs].
  function collectReminderInstances(state, fromMs, toMs) {
    const out = [];
    if (!state || toMs < fromMs) return out;
    const settings = state.settings || {};
    const cals = calendarMap(state);
    const fromDate = addDays(todayStr(fromMs), -1);
    const toDate = addDays(todayStr(toMs + MAX_OFFSET * MS_MIN), 1);
    for (const ev of state.events || []) {
      const cal = cals.get(ev.calendarId);
      if (cal && cal.notify === false) continue;
      if (ev.kind === 'task' && !ev.rrule && ev.done) continue;
      const offs = effectiveReminders(ev, cal);
      if (!offs.length) continue;
      // Cheap reject for one-off items nowhere near the window.
      if (!ev.rrule && (evEndDate(ev) < fromDate || evStartDate(ev) > toDate)) continue;
      for (const occ of expandEvent(ev, fromDate, toDate)) {
        if (occ.done) continue;
        const base = reminderBaseMs(occ, settings);
        for (const off of offs) {
          const fireAt = base - off * MS_MIN;
          if (fireAt >= fromMs && fireAt <= toMs) {
            out.push({ key: 'r|' + occ.uid + '|' + fireAt, type: 'reminder', fireAt, offset: off, occ });
          }
        }
      }
    }
    return out;
  }

  function digestTimeMs(settings, date) {
    const dg = settings && settings.digest;
    if (!dg || !dg.enabled || !isTime(dg.time)) return null;
    return instant(date + 'T' + dg.time);
  }

  // When the scheduler should next wake: the earliest future reminder, snooze
  // or daily digest — but never later than WAKE_CAP from now.
  function nextWakeAt(state, snoozes, now) {
    let next = now + WAKE_CAP;
    for (const it of collectReminderInstances(state, now + 1, next)) {
      if (it.fireAt < next) next = it.fireAt;
    }
    for (const s of snoozes || []) {
      if (s.fireAt > now && s.fireAt < next) next = s.fireAt;
    }
    const settings = (state && state.settings) || {};
    const today = todayStr(now);
    for (const d of [today, addDays(today, 1)]) {
      const t = digestTimeMs(settings, d);
      if (t !== null && t > now && t < next) next = t;
    }
    return next;
  }

  // One scheduler pass. Pure: given the data, the runtime record and the time,
  // it says what to announce and what to remember.
  //
  //   watermark — the moment of the previous pass. Reminders are due when their
  //               fireAt falls in (watermark, now]. Anything at or before the
  //               watermark was already handled, which is also why an event
  //               created with its reminder time already past never pings.
  //   fire      — due and still useful (the event hasn't started >10 min ago).
  //               Several due reminders for one occurrence collapse into the
  //               latest, so opening the laptop never fires "in 1 day",
  //               "in 1 hour" and "in 10 min" for the same exam at once.
  //   missed    — due, no longer useful, and main was away when they came due.
  //               Main shows these as one summary instead of a burst.
  function scan(state, runtime, now) {
    const rt = runtime || {};
    const settings = (state && state.settings) || {};
    const wm = typeof rt.watermark === 'number' && rt.watermark <= now ? rt.watermark : now;
    const lookFrom = Math.max(wm, now - 7 * MS_DAY);
    const away = now - wm > AWAY_MS;
    const due = lookFrom < now ? collectReminderInstances(state, lookFrom + 1, now) : [];

    const latest = new Map();
    for (const it of due) {
      const prev = latest.get(it.occ.uid);
      if (!prev || it.fireAt > prev.fireAt) latest.set(it.occ.uid, it);
    }
    const fire = [];
    const missed = [];
    for (const it of latest.values()) {
      if (now < relevantUntil(it.occ)) fire.push(it);
      else if (away) missed.push(it);
    }

    const events = new Map(((state && state.events) || []).map(e => [e.id, e]));
    const snoozes = [];
    for (const s of rt.snoozes || []) {
      if (!s || typeof s.fireAt !== 'number') continue;
      if (s.fireAt > now) { snoozes.push(s); continue; }
      const occ = occurrenceFor(events.get(s.eventId), s.occKey);
      if (!occ || occ.done) continue;
      if (fire.some(f => f.occ.uid === occ.uid)) continue;
      fire.push({ key: 's|' + occ.uid + '|' + s.fireAt, type: 'snooze', fireAt: s.fireAt, offset: null, occ });
    }

    let digest = null;
    const today = todayStr(now);
    const t = digestTimeMs(settings, today);
    if (t !== null && t > wm && t <= now && now < t + 3 * MS_HOUR) {
      digest = { key: 'd|' + today, type: 'digest', fireAt: t, date: today };
    }

    fire.sort((a, b) => a.fireAt - b.fireAt);
    missed.sort((a, b) => a.fireAt - b.fireAt);
    return { fire, missed, digest, snoozes, watermark: now, nextAt: nextWakeAt(state, snoozes, now) };
  }

  function inQuietHours(settings, now) {
    const q = settings && settings.quietHours;
    if (!q || !q.enabled || !isTime(q.start) || !isTime(q.end)) return false;
    const m = minuteOfDay(now);
    const a = minutesOf(q.start), b = minutesOf(q.end);
    if (a === b) return false;
    return a < b ? (m >= a && m < b) : (m >= a || m < b);
  }

  // "in 10 min" / "now" / "started 4 min ago" / "tomorrow at 9 AM" ...
  function relativePhrase(occ, now, clock24) {
    const today = todayStr(now);
    const d = evStartDate(occ);
    const days = diffDays(today, d);
    if (occ.allDay) {
      if (days === 0) return 'today';
      if (days === 1) return 'tomorrow';
      if (days > 1) return days < 7 ? 'on ' + WEEKDAYS[dow(d)] : 'in ' + days + ' days';
      return days === -1 ? 'yesterday' : Math.abs(days) + ' days ago';
    }
    const diffMin = Math.round((instant(occ.start) - now) / MS_MIN);
    if (diffMin === 0) return 'now';
    if (diffMin < 0) {
      const ago = -diffMin;
      return ago < 60 ? ago + ' min ago' : fmtDuration(ago) + ' ago';
    }
    if (diffMin < 60) return 'in ' + diffMin + ' min';
    if (days === 0) return 'in ' + fmtDuration(diffMin);
    const at = fmtTime(timePart(occ.start), clock24);
    if (days === 1) return 'tomorrow at ' + at;
    if (days < 7) return WEEKDAYS[dow(d)] + ' at ' + at;
    return 'in ' + days + ' days';
  }

  function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  // The words for a reminder: { title, headline, when, body }.
  //   title    — the event's name
  //   headline — "In 10 min", "Due in 2 h", "Starting now", "Tomorrow"
  //   when     — "10 – 11 AM" (+ the date when it isn't today)
  //   body     — headline · when · location, for a native notification
  function describeAlert(occ, now, opts) {
    const clock24 = !!(opts && opts.clock24);
    const today = todayStr(now);
    const d = evStartDate(occ);
    const rel = relativePhrase(occ, now, clock24);
    let headline;
    if (occ.kind === 'task') {
      if (occ.allDay) headline = rel === 'today' ? 'Due today' : (rel === 'tomorrow' ? 'Due tomorrow' : 'Due ' + rel);
      else if (rel === 'now') headline = 'Due now';
      else if (/ago$/.test(rel)) headline = 'Overdue by ' + rel.replace(/ ago$/, '');
      else headline = 'Due ' + rel;
    } else if (occ.allDay) {
      headline = capitalize(rel);
    } else if (rel === 'now') {
      headline = 'Starting now';
    } else if (/ago$/.test(rel)) {
      headline = 'Started ' + rel;
    } else {
      headline = capitalize(rel);
    }
    let when;
    if (occ.allDay) {
      const end = evEndDate(occ);
      when = end !== d ? fmtDateShort(d) + ' – ' + fmtDateShort(end) : (d === today ? 'All day' : fmtDateShort(d) + ' · all day');
    } else {
      const t = occ.kind === 'task'
        ? fmtTime(timePart(occ.start), clock24)
        : fmtTimeRange(timePart(occ.start), occ.end && datePart(occ.end) === d ? timePart(occ.end) : timePart(occ.start), clock24);
      when = d === today ? t : fmtDateShort(d) + ' · ' + t;
    }
    const title = occ.title || (occ.kind === 'task' ? 'Untitled task' : 'Untitled event');
    const body = [headline, when, occ.location].filter(Boolean).join(' · ');
    return { title, headline, when, body };
  }

  function greeting(now) {
    const h = new Date(now).getHours();
    return h < 12 ? 'Good morning' : (h < 18 ? 'Good afternoon' : 'Good evening');
  }

  // The daily digest: what today holds, in one notification.
  function digestSummary(state, date, now, opts) {
    const clock24 = !!(opts && opts.clock24);
    const cals = calendarMap(state);
    const include = (ev) => { const c = cals.get(ev.calendarId); return !c || c.notify !== false; };
    const occs = expandAll((state && state.events) || [], date, date, include);
    const events = occs.filter(o => o.kind !== 'task');
    const tasks = occs.filter(o => o.kind === 'task' && !o.done);
    const overdue = expandAll((state && state.events) || [], addDays(date, -30), addDays(date, -1), include)
      .filter(o => o.kind === 'task' && !o.done && evEndDate(o) < date).length;
    const parts = [];
    if (events.length) parts.push(events.length + (events.length === 1 ? ' event' : ' events'));
    if (tasks.length) parts.push(tasks.length + ' due');
    if (overdue) parts.push(overdue + ' overdue');
    const title = greeting(now) + ' — ' + (parts.length ? parts.join(', ') : 'a clear day');
    let body;
    if (!events.length && !tasks.length) {
      body = overdue ? 'Nothing scheduled — a good day to catch up on what\'s overdue.' : 'Nothing scheduled today. Enjoy it.';
    } else {
      const firstTimed = events.find(o => !o.allDay) || null;
      const lines = [];
      if (firstTimed) lines.push('First up: ' + fmtTime(timePart(firstTimed.start), clock24) + ' ' + (firstTimed.title || 'Untitled'));
      const allDay = events.filter(o => o.allDay);
      if (allDay.length) lines.push(allDay.map(o => o.title).slice(0, 2).join(', ') + (allDay.length > 2 ? ' +' + (allDay.length - 2) : ''));
      if (tasks.length) lines.push('Due: ' + tasks.map(o => o.title).slice(0, 2).join(', ') + (tasks.length > 2 ? ' +' + (tasks.length - 2) : ''));
      body = lines.join(' · ');
    }
    return { title, body, events: events.length, tasks: tasks.length, overdue };
  }

  function missedSummary(items, opts) {
    const clock24 = !!(opts && opts.clock24);
    const names = items.map(it => {
      const o = it.occ;
      const t = o.allDay ? '' : ' (' + fmtTime(timePart(o.start), clock24) + ')';
      return (o.title || 'Untitled') + t;
    });
    const title = items.length === 1 ? 'Missed reminder' : items.length + ' missed reminders';
    const body = names.slice(0, 3).join(', ') + (names.length > 3 ? ' +' + (names.length - 3) + ' more' : '') + ' — while main wasn\'t running.';
    return { title, body };
  }

  // ── Week-view layout ────────────────────────────────────────────────────
  // Overlapping timed blocks share a day column side by side. Items are
  // grouped into clusters of transitively-overlapping blocks; each takes the
  // first free sub-column and the cluster's width is its widest point.
  function layoutDayColumns(items) {
    const sorted = items.map(it => Object.assign({}, it, { endMin: Math.max(it.endMin, it.startMin + 20) }))
      .sort((a, b) => a.startMin - b.startMin || (b.endMin - b.startMin) - (a.endMin - a.startMin));
    const out = [];
    let cluster = [];
    let columns = [];
    let clusterEnd = -Infinity;
    const flush = () => {
      for (const it of cluster) it.cols = columns.length;
      cluster = [];
      columns = [];
    };
    for (const it of sorted) {
      if (it.startMin >= clusterEnd) { flush(); clusterEnd = -Infinity; }
      let col = columns.findIndex(end => end <= it.startMin);
      if (col === -1) { col = columns.length; columns.push(it.endMin); } else columns[col] = it.endMin;
      it.col = col;
      cluster.push(it);
      out.push(it);
      clusterEnd = Math.max(clusterEnd, it.endMin);
    }
    flush();
    return out;
  }

  // ── Links ───────────────────────────────────────────────────────────────
  const MEETING_HOST = /(^|\.)(zoom\.us|zoom\.com|teams\.microsoft\.com|teams\.live\.com|meet\.google\.com|webex\.com|gotomeeting\.com|gotomeet\.me|whereby\.com|meet\.jit\.si|chime\.aws|discord\.gg|discord\.com|slack\.com|facetime\.apple\.com)$/i;
  const URL_IN_TEXT = /https?:\/\/[^\s<>"'`)\]]+/gi;

  function safeHttpUrl(s) {
    try {
      const u = new URL(String(s).replace(/[.,;:!?]+$/, ''));
      return (u.protocol === 'https:' || u.protocol === 'http:') ? u.href : null;
    } catch (e) { return null; }
  }

  // The video-call link in an event, if it has one: its own URL field first,
  // then any Zoom/Teams/Meet/... link in the location or notes.
  function findMeetingLink(occ) {
    const candidates = [];
    if (occ.url) candidates.push(occ.url);
    for (const text of [occ.location, occ.notes]) {
      if (!text) continue;
      const found = String(text).match(URL_IN_TEXT);
      if (found) candidates.push.apply(candidates, found);
    }
    for (const c of candidates) {
      const href = safeHttpUrl(c);
      if (!href) continue;
      try { if (MEETING_HOST.test(new URL(href).hostname)) return href; } catch (e) { /* skip */ }
    }
    return null;
  }

  // ── Search ──────────────────────────────────────────────────────────────
  // Each event that matches every query word (in title, location or notes),
  // shown at its next occurrence — or its most recent one if it's all past.
  function searchEvents(events, query, today, include) {
    const tokens = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return [];
    const hits = [];
    for (const ev of events || []) {
      if (include && !include(ev)) continue;
      const hay = (ev.title + ' ' + (ev.location || '') + ' ' + (ev.notes || '')).toLowerCase();
      if (!tokens.every(t => hay.indexOf(t) !== -1)) continue;
      const occ = nextOccurrence(ev, today) || buildOccurrence(ev, evStartDate(ev), null);
      const titleHit = tokens.every(t => String(ev.title).toLowerCase().indexOf(t) !== -1);
      hits.push({ occ, upcoming: evEndDate(occ) >= today, titleHit });
    }
    return hits.sort((a, b) => {
      if (a.upcoming !== b.upcoming) return a.upcoming ? -1 : 1;
      if (a.titleHit !== b.titleHit) return a.titleHit ? -1 : 1;
      return a.upcoming ? compareOccurrences(a.occ, b.occ) : compareOccurrences(b.occ, a.occ);
    }).map(h => h.occ);
  }

  // ── Defaults & sanitising ───────────────────────────────────────────────
  // Everything reaching main from the renderer (or from an imported file) goes
  // through these, so the store can never hold a shape the engine can't read.

  const PALETTE = ['#8b5cf6', '#38bdf8', '#f59e0b', '#f43f5e', '#10b981', '#ec4899',
    '#f97316', '#14b8a6', '#6366f1', '#84cc16', '#eab308', '#94a3b8'];

  const DEFAULT_CALENDARS = [
    { id: 'personal', name: 'Personal', color: '#8b5cf6', defaultReminders: [10], defaultAllDayReminders: [0] },
    { id: 'school', name: 'School', color: '#38bdf8', defaultReminders: [10], defaultAllDayReminders: [0] },
    { id: 'work', name: 'Work', color: '#f59e0b', defaultReminders: [10], defaultAllDayReminders: [0] },
    { id: 'deadlines', name: 'Deadlines & Exams', color: '#f43f5e', defaultReminders: [1440, 60], defaultAllDayReminders: [1440, 0] }
  ].map(c => Object.assign({ visible: true, notify: true, source: 'local' }, c));

  const DEFAULT_SETTINGS = {
    weekStart: 1,
    defaultView: 'month',
    defaultDuration: 60,
    allDayReminderTime: '09:00',
    clock24: false,
    showWeekNumbers: false,
    headerChip: true,
    notifications: { desktop: true, inApp: true, sound: true },
    quietHours: { enabled: false, start: '22:00', end: '07:00', allowImportant: true },
    digest: { enabled: false, time: '07:30' },
    // What a right-click on an event does. Deliberately 'none' by default:
    // a destructive action on a stray click has to be opted into.
    rightClick: 'none',
    // Show each term's first and last day in the calendar itself.
    termMarkers: false,
    // Count week numbers from January, or from each term's first week.
    weekNumbersFrom: 'year',
    // School/university terms: [{ id, name, start, end }].
    terms: []
  };

  const VIEWS = ['month', 'week', 'agenda', 'year'];
  const RIGHT_CLICK = ['none', 'delete', 'done'];
  const WEEK_NUMBERS_FROM = ['year', 'term'];
  const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

  // RegExp.test COERCES its argument: ID_RE.test(null) is TRUE, because the
  // string "null" matches the pattern. That let an event saved with id:null
  // keep null as its id, after which nothing could ever find it again — delete
  // and edit both looked for an id that no longer existed. Check the type.
  function isId(v) { return typeof v === 'string' && ID_RE.test(v); }

  function cleanText(s, max, singleLine) {
    if (typeof s !== 'string') return '';
    let t = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
    if (singleLine) t = t.replace(/[\r\n\t]+/g, ' ').trim();
    return t.slice(0, max);
  }

  function genId(prefix) {
    return (prefix || 'e') + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function sanitizeReminders(list) {
    if (!Array.isArray(list)) return null;
    const set = new Set();
    for (const v of list) {
      const n = Math.round(Number(v));
      if (Number.isFinite(n) && n >= 0 && n <= MAX_OFFSET) set.add(n);
    }
    return Array.from(set).sort((a, b) => a - b).slice(0, 6);
  }

  function sanitizeRRule(r, startDate) {
    if (!r || typeof r !== 'object' || FREQS.indexOf(r.freq) === -1) return null;
    const out = { freq: r.freq, interval: Math.min(99, Math.max(1, Math.round(Number(r.interval)) || 1)) };
    if (r.freq === 'weekly') {
      const days = Array.isArray(r.byDay) ? r.byDay.map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6) : [];
      out.byDay = Array.from(new Set(days.length ? days : [dow(startDate)])).sort((a, b) => a - b);
      out.wkst = Number.isInteger(r.wkst) && r.wkst >= 0 && r.wkst <= 6 ? r.wkst : 1;
    }
    if (r.freq === 'monthly' || r.freq === 'yearly') {
      out.monthMode = r.monthMode === 'nth' ? 'nth' : 'day';
      if (out.monthMode === 'nth') out.nth = (r.nth === -1 || (r.nth >= 1 && r.nth <= 4)) ? r.nth : nthOfMonth(startDate);
    }
    out.until = isDate(r.until) && r.until >= startDate ? r.until : null;
    const c = Math.round(Number(r.count));
    out.count = !out.until && Number.isFinite(c) && c >= 1 && c <= 999 ? c : null;
    return out;
  }

  function sanitizeTimes(allDay, kind, start, end, defaultDuration) {
    if (allDay) {
      const s = isDate(start) ? start : (isDateTime(start) ? datePart(start) : null);
      if (!s) return null;
      let e = isDate(end) ? end : (isDateTime(end) ? datePart(end) : s);
      if (e < s || kind === 'task') e = s;
      if (diffDays(s, e) > 366) e = addDays(s, 366);
      return { start: s, end: e };
    }
    let s = isDateTime(start) ? start : (isDate(start) ? start + 'T09:00' : null);
    if (!s) return null;
    if (kind === 'task') return { start: s, end: s };
    let e = isDateTime(end) ? end : null;
    const dur = defaultDuration > 0 ? defaultDuration : 60;
    if (!e || wall(e) <= wall(s)) e = fromWall(wall(s) + dur);
    if (wall(e) - wall(s) > 60 * 1440) e = fromWall(wall(s) + 60 * 1440);
    return { start: s, end: e };
  }

  // → { ok: true, event } | { ok: false, error }
  function sanitizeEvent(input, ctx) {
    const c = ctx || {};
    if (!input || typeof input !== 'object') return { ok: false, error: 'No event' };
    const kind = input.kind === 'task' ? 'task' : 'event';
    const allDay = !!input.allDay;
    const times = sanitizeTimes(allDay, kind, input.start, input.end, c.defaultDuration);
    if (!times) return { ok: false, error: 'That date isn\'t valid' };
    const ids = c.calendarIds || [];
    const calendarId = ids.indexOf(input.calendarId) !== -1 ? input.calendarId : (c.defaultCalendarId || ids[0] || 'personal');
    const now = typeof c.now === 'number' ? c.now : Date.now();
    const ev = {
      id: isId(input.id) ? input.id : genId('e'),
      calendarId,
      kind,
      title: cleanText(input.title, 200, true) || (kind === 'task' ? 'Untitled task' : 'Untitled event'),
      location: cleanText(input.location, 300, true),
      notes: cleanText(input.notes, 5000, false),
      url: input.url ? (safeHttpUrl(input.url) || '') : '',
      allDay,
      start: times.start,
      end: times.end,
      reminders: input.reminders === null || input.reminders === undefined ? null : sanitizeReminders(input.reminders),
      important: !!input.important,
      rrule: sanitizeRRule(input.rrule, datePart(times.start)),
      exdates: [],
      overrides: {},
      done: kind === 'task' && !input.rrule ? !!input.done : false,
      doneDates: [],
      createdAt: Number.isFinite(input.createdAt) ? input.createdAt : now,
      updatedAt: now
    };
    if (ev.url.length > 1000) ev.url = '';
    if (ev.rrule) {
      ev.exdates = Array.from(new Set((Array.isArray(input.exdates) ? input.exdates : []).filter(isDate))).sort().slice(0, 1000);
      ev.doneDates = kind === 'task' ? Array.from(new Set((Array.isArray(input.doneDates) ? input.doneDates : []).filter(isDate))).sort().slice(-2000) : [];
      const ov = input.overrides && typeof input.overrides === 'object' ? input.overrides : {};
      let n = 0;
      for (const key of Object.keys(ov)) {
        if (n >= 500 || !isDate(key)) continue;
        const o = ov[key];
        if (!o || typeof o !== 'object') continue;
        const oAllDay = typeof o.allDay === 'boolean' ? o.allDay : allDay;
        const t = sanitizeTimes(oAllDay, kind, o.start, o.end, c.defaultDuration);
        if (!t) continue;
        const clean = { start: t.start, end: t.end, allDay: oAllDay };
        if (typeof o.title === 'string') clean.title = cleanText(o.title, 200, true);
        if (typeof o.location === 'string') clean.location = cleanText(o.location, 300, true);
        if (typeof o.notes === 'string') clean.notes = cleanText(o.notes, 5000, false);
        ev.overrides[key] = clean;
        n++;
      }
    }
    if (typeof input.source === 'string' && /^ics:[A-Za-z0-9_-]{1,64}$/.test(input.source)) ev.source = input.source;
    if (typeof input.uid === 'string') ev.uid = cleanText(input.uid, 300, true);
    return { ok: true, event: ev };
  }

  function sanitizeCalendar(input, existing) {
    const base = existing || {};
    const out = {
      id: isId(base.id) ? base.id : (isId(input && input.id) ? input.id : genId('c')),
      name: cleanText(input && input.name, 40, true) || base.name || 'Calendar',
      color: COLOR_RE.test(input && input.color) ? input.color.toLowerCase() : (base.color || PALETTE[0]),
      visible: input && typeof input.visible === 'boolean' ? input.visible : (base.visible !== false),
      notify: input && typeof input.notify === 'boolean' ? input.notify : (base.notify !== false),
      defaultReminders: sanitizeReminders(input && input.defaultReminders) || base.defaultReminders || [10],
      defaultAllDayReminders: sanitizeReminders(input && input.defaultAllDayReminders) || base.defaultAllDayReminders || [0],
      source: base.source === 'ics' ? 'ics' : 'local'
    };
    if (out.source === 'ics') {
      out.url = base.url;
      out.refreshHours = base.refreshHours || 6;
      out.lastSync = base.lastSync || null;
      out.lastError = base.lastError || null;
      out.readOnly = true;
    }
    return out;
  }

  function sanitizeSettings(input, base) {
    const b = mergeSettings(base);
    const i = input && typeof input === 'object' ? input : {};
    const out = mergeSettings(b);
    if (i.weekStart === 0 || i.weekStart === 1 || i.weekStart === 6) out.weekStart = i.weekStart;
    if (VIEWS.indexOf(i.defaultView) !== -1) out.defaultView = i.defaultView;
    if (RIGHT_CLICK.indexOf(i.rightClick) !== -1) out.rightClick = i.rightClick;
    if (WEEK_NUMBERS_FROM.indexOf(i.weekNumbersFrom) !== -1) out.weekNumbersFrom = i.weekNumbersFrom;
    if (Array.isArray(i.terms)) out.terms = sanitizeTerms(i.terms);
    if ([15, 30, 45, 60, 90, 120].indexOf(Number(i.defaultDuration)) !== -1) out.defaultDuration = Number(i.defaultDuration);
    if (isTime(i.allDayReminderTime)) out.allDayReminderTime = i.allDayReminderTime;
    for (const k of ['clock24', 'showWeekNumbers', 'headerChip', 'termMarkers']) if (typeof i[k] === 'boolean') out[k] = i[k];
    if (i.notifications && typeof i.notifications === 'object') {
      for (const k of ['desktop', 'inApp', 'sound']) if (typeof i.notifications[k] === 'boolean') out.notifications[k] = i.notifications[k];
    }
    if (i.quietHours && typeof i.quietHours === 'object') {
      const q = i.quietHours;
      if (typeof q.enabled === 'boolean') out.quietHours.enabled = q.enabled;
      if (typeof q.allowImportant === 'boolean') out.quietHours.allowImportant = q.allowImportant;
      if (isTime(q.start)) out.quietHours.start = q.start;
      if (isTime(q.end)) out.quietHours.end = q.end;
    }
    if (i.digest && typeof i.digest === 'object') {
      if (typeof i.digest.enabled === 'boolean') out.digest.enabled = i.digest.enabled;
      if (isTime(i.digest.time)) out.digest.time = i.digest.time;
    }
    return out;
  }

  // Defaults, deep-merged under whatever shape was stored (older files may
  // lack newer keys).
  function mergeSettings(stored) {
    const s = stored && typeof stored === 'object' ? stored : {};
    const d = DEFAULT_SETTINGS;
    return {
      weekStart: s.weekStart === 0 || s.weekStart === 1 || s.weekStart === 6 ? s.weekStart : d.weekStart,
      defaultView: VIEWS.indexOf(s.defaultView) !== -1 ? s.defaultView : d.defaultView,
      defaultDuration: Number(s.defaultDuration) > 0 ? Number(s.defaultDuration) : d.defaultDuration,
      allDayReminderTime: isTime(s.allDayReminderTime) ? s.allDayReminderTime : d.allDayReminderTime,
      clock24: typeof s.clock24 === 'boolean' ? s.clock24 : d.clock24,
      showWeekNumbers: typeof s.showWeekNumbers === 'boolean' ? s.showWeekNumbers : d.showWeekNumbers,
      headerChip: typeof s.headerChip === 'boolean' ? s.headerChip : d.headerChip,
      notifications: Object.assign({}, d.notifications, pickBools(s.notifications, ['desktop', 'inApp', 'sound'])),
      quietHours: Object.assign({}, d.quietHours, pickBools(s.quietHours, ['enabled', 'allowImportant']),
        s.quietHours && isTime(s.quietHours.start) ? { start: s.quietHours.start } : {},
        s.quietHours && isTime(s.quietHours.end) ? { end: s.quietHours.end } : {}),
      rightClick: RIGHT_CLICK.indexOf(s.rightClick) !== -1 ? s.rightClick : d.rightClick,
      termMarkers: typeof s.termMarkers === 'boolean' ? s.termMarkers : d.termMarkers,
      weekNumbersFrom: WEEK_NUMBERS_FROM.indexOf(s.weekNumbersFrom) !== -1 ? s.weekNumbersFrom : d.weekNumbersFrom,
      terms: sanitizeTerms(s.terms),
      digest: Object.assign({}, d.digest, pickBools(s.digest, ['enabled']),
        s.digest && isTime(s.digest.time) ? { time: s.digest.time } : {})
    };
  }

  // ── School terms ──────────────────────────────────────────────────────
  // A short list of dated stretches ("Term 3", "Semester 1"). They give the
  // calendar something the school year cares about: which term a day is in,
  // which week OF that term it is, and a date to end a weekly class on.

  function sanitizeTerms(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const t of list) {
      if (!t || typeof t !== 'object') continue;
      if (!isDate(t.start) || !isDate(t.end) || t.end < t.start) continue;
      out.push({
        id: isId(t.id) ? t.id : genId('t'),
        name: cleanText(t.name, 40, true) || 'Term',
        start: t.start,
        end: t.end
      });
      if (out.length >= 12) break;
    }
    return out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  }

  function currentTerm(terms, date) {
    for (const t of terms || []) if (date >= t.start && date <= t.end) return t;
    return null;
  }

  function nextTerm(terms, date) {
    for (const t of terms || []) if (t.start > date) return t;   // sorted by start
    return null;
  }

  // Which week of the term a date falls in, counting whole weeks from the week
  // the term started — so every day of the first week reads "Week 1".
  function termWeek(term, date, weekStart) {
    if (!term || date < term.start || date > term.end) return 0;
    const ws = weekStart === 0 || weekStart === 6 ? weekStart : 1;
    return Math.floor(diffDays(startOfWeek(term.start, ws), date) / 7) + 1;
  }

  // { name, week } for the term a date sits in, or null.
  function termLabel(terms, date, weekStart) {
    const t = currentTerm(terms, date);
    return t ? { name: t.name, week: termWeek(t, date, weekStart), term: t } : null;
  }

  // What the week column shows. Counting from January (ISO) is the default;
  // counting from a term makes the first week of term Week 1, which is how a
  // school year is actually spoken about. A week that straddles the start of a
  // term belongs to that term — the row the term starts in IS week 1 — and a
  // week that touches no term shows a dash rather than a misleading number.
  function weekNumberLabel(rowStart, settings) {
    const s = settings || {};
    if (s.weekNumbersFrom === 'term') {
      const terms = s.terms || [];
      for (let i = 0; i < 7; i++) {
        const d = addDays(rowStart, i);
        const t = currentTerm(terms, d);
        if (t) return { text: String(termWeek(t, d, s.weekStart)), term: t, inTerm: true };
      }
      return { text: '–', term: null, inTerm: false };
    }
    return { text: String(isoWeek(rowStart)), term: null, inTerm: false };
  }

  function pickBools(obj, keys) {
    const out = {};
    if (!obj || typeof obj !== 'object') return out;
    for (const k of keys) if (typeof obj[k] === 'boolean') out[k] = obj[k];
    return out;
  }

  // ── Natural-language quick add ──────────────────────────────────────────
  // "Math test fri 10am @room204 !", "Standup every weekday 9:30-9:45 #work",
  // "History essay due next thursday", "Gym mondays and thursdays 6pm for 1h".
  //
  // Recognised phrases are consumed from a working copy (replaced by spaces,
  // so match offsets stay aligned with the original text) and whatever is left
  // becomes the title. Each consumed piece is reported in `spans`, which lets
  // the UI show exactly what it understood. Order matters: recurrence runs
  // before dates so "every monday until dec 20" can't read "dec 20" as the
  // start, and dates run before times so "2026-09-25" never looks like a
  // "9-25" time range.

  const NUM_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
    eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, couple: 2 };
  const NUM = '(\\d+(?:\\.\\d+)?|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';
  const WD = '(?:sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)';
  const WDP = '(?:sundays|mondays|tuesdays|wednesdays|thursdays|fridays|saturdays)';
  const MON = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
  const ORD = '(?:st|nd|rd|th)';
  const MER = '(?:am|pm|a\\.m\\.|p\\.m\\.)';
  const TIME = '(?:\\d{1,2}\\.\\d{2}\\s*' + MER + '|\\d{1,2}(?::\\d{2})?(?:\\s*' + MER + ')?|noon|midday|midnight)';
  const CONN = '(?:(?:on|by|due|for|starting|from)\\s+)?';
  const DATE_EXPR = '(?:\\d{4}-\\d{2}-\\d{2}|' + MON + '\\s+\\d{1,2}' + ORD + '?(?:,?\\s+\\d{4})?|\\d{1,2}' + ORD +
    '?\\s+(?:of\\s+)?' + MON + '(?:,?\\s+\\d{4})?|\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?|tomorrow|next\\s+(?:week|month)|' +
    '(?:next\\s+|this\\s+)?' + WD + '|(?:the\\s+)?end\\s+of\\s+(?:the\\s+)?(?:month|year|term))';

  function num(s) { return NUM_WORDS[s] !== undefined ? NUM_WORDS[s] : parseFloat(s); }
  function wdIndex(w) { return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(w.slice(0, 3)); }
  function monIndex(m) {
    return ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m.slice(0, 3)) + 1;
  }

  function parseTimeText(raw) {
    const t = raw.trim();
    if (t === 'noon' || t === 'midday') return { min: 720, mer: 'p', colon: true, lead0: false };
    if (t === 'midnight') return { min: 0, mer: 'a', colon: true, lead0: false };
    const m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/.exec(t);
    if (!m) return null;
    let h = +m[1];
    const mi = m[2] ? +m[2] : 0;
    const mer = m[3] ? m[3][0] : null;
    if (mi > 59) return null;
    if (mer) {
      if (h < 1 || h > 12) return null;
      if (mer === 'p' && h !== 12) h += 12;
      if (mer === 'a' && h === 12) h = 0;
    } else if (h > 23) {
      return null;
    }
    return { min: h * 60 + mi, mer, colon: !!m[2], lead0: m[1].length === 2 && m[1][0] === '0', raw: +m[1] };
  }

  // A clock time written without am/pm: 1–6 almost always means afternoon
  // ("at 3", "2:30"); 7–12 is read as written. A leading zero ("07:30") is
  // deliberate 24-hour notation and is never adjusted.
  function withoutMeridiem(t) {
    if (t.mer || t.lead0) return t.min;
    const h = Math.floor(t.min / 60);
    return h >= 1 && h <= 6 ? t.min + 720 : t.min;
  }

  function resolveMonthDay(month, day, year, today) {
    if (!month || day < 1 || day > 31) return null;
    if (year) {
      const y = year < 100 ? 2000 + year : year;
      return day <= daysInMonth(y, month) ? ymd(y, month, day) : null;
    }
    let y = +today.slice(0, 4);
    for (let i = 0; i < 9; i++, y++) {
      if (day > daysInMonth(y, month)) continue;
      const d = ymd(y, month, day);
      if (d >= today) return d;
    }
    return null;
  }

  // The date forms, in the order they are tried. Each returns a resolver that
  // runs once the time is known (a bare weekday that matches today means
  // today only if the time hasn't already passed).
  function dateRules(o) {
    const { today, dmy, weekStart, terms } = o;
    // Shared by every numeric form (9/25, 23/6/27, 22.4.27): the locale decides
    // which number is the day, a two-digit year means this century.
    const numericDate = (m) => {
      const a = +m[1], b = +m[2];
      const month = dmy ? b : a, day = dmy ? a : b;
      if (month < 1 || month > 12) return null;
      const d = resolveMonthDay(month, day, m[3] ? +m[3] : 0, today);
      return d ? () => d : null;
    };
    return [
      { re: new RegExp('\\b' + CONN + '(\\d{4})-(\\d{2})-(\\d{2})\\b'),
        get: (m) => { const d = m[1] + '-' + m[2] + '-' + m[3]; return isDate(d) ? () => d : null; } },
      { re: new RegExp('\\b' + CONN + '(?:the\\s+)?day\\s+after\\s+tomorrow\\b'), get: () => () => addDays(today, 2) },
      { re: new RegExp('\\b' + CONN + '(' + MON + ')\\s+(\\d{1,2})' + ORD + '?(?:,?\\s+(\\d{4}))?\\b'),
        get: (m) => { const d = resolveMonthDay(monIndex(m[1]), +m[2], m[3] ? +m[3] : 0, today); return d ? () => d : null; } },
      { re: new RegExp('\\b' + CONN + '(?:the\\s+)?(\\d{1,2})' + ORD + '?\\s+(?:of\\s+)?(' + MON + ')(?:,?\\s+(\\d{4}))?\\b'),
        get: (m) => { const d = resolveMonthDay(monIndex(m[2]), +m[1], m[3] ? +m[3] : 0, today); return d ? () => d : null; } },
      { re: new RegExp('\\b' + CONN + '(\\d{1,2})\\/(\\d{1,2})(?:\\/(\\d{4}|\\d{2}))?\\b'),
        get: (m) => {
          const a = +m[1], b = +m[2];
          const month = dmy ? b : a, day = dmy ? a : b;
          if (month < 1 || month > 12) return null;
          const d = resolveMonthDay(month, day, m[3] ? +m[3] : 0, today);
          return d ? () => d : null;
        } },
      // Dotted dates ("22.4.27"), same locale order as the slashed form. The
      // year is REQUIRED here: without it a plain "2.5" in a title ("chapter
      // 2.5") would silently become a date.
      { re: /\b(?:(?:on|by|due|for|starting|from)\s+)?(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})\b/,
        get: numericDate },
      // ...unless a word marks it as one: "due 22.4", "on 22.4".
      { re: /\b(?:on|by|due|from)\s+(\d{1,2})\.(\d{1,2})(?!\d)/,
        get: numericDate },
      { re: new RegExp('\\b(?:(?:on|by|due)\\s+)?the\\s+(\\d{1,2})' + ORD + '\\b|\\b(?:on|by|due)\\s+(\\d{1,2})' + ORD + '\\b'),
        get: (m) => {
          const day = +(m[1] || m[2]);
          if (day < 1 || day > 31) return null;
          let cur = startOfMonth(today);
          for (let i = 0; i < 12; i++, cur = addMonths(cur, 1)) {
            if (day > daysInMonth(+cur.slice(0, 4), +cur.slice(5, 7))) continue;
            const d = cur.slice(0, 8) + pad2(day);
            if (d >= today) return () => d;
          }
          return null;
        } },
      { re: new RegExp('\\b' + CONN + '(today|tonight|tomorrow|tmrw|tmr|tomorow|tommorow|tommorrow)\\b'),
        get: (m) => (m[1] === 'today' || m[1] === 'tonight') ? () => today : () => addDays(today, 1),
        tonight: (m) => m[1] === 'tonight' },
      { re: new RegExp('\\bin\\s+' + NUM + '\\s+(days?|weeks?|months?|years?)\\b'),
        get: (m) => {
          const n = Math.round(num(m[1]));
          const u = m[2][0];
          const d = u === 'd' ? addDays(today, n) : u === 'w' ? addDays(today, 7 * n) : u === 'm' ? addMonths(today, n) : addMonths(today, 12 * n);
          return () => d;
        } },
      { re: new RegExp('\\b' + CONN + '(next|this)\\s+(week|weekend|month)\\b'),
        get: (m) => {
          const sow = startOfWeek(today, weekStart);
          if (m[2] === 'week') return m[1] === 'next' ? () => addDays(sow, 7) : null;
          if (m[2] === 'month') return m[1] === 'next' ? () => addMonths(startOfMonth(today), 1) : null;
          const sat = addDays(today, (6 - dow(today) + 7) % 7);
          if (m[1] === 'this') return () => (dow(today) === 0 ? today : sat);
          // "next weekend" is the Saturday of next week.
          return () => addDays(sow, 7 + ((6 - weekStart + 7) % 7));
        } },
      { re: new RegExp('\\b' + CONN + '(?:the\\s+)?end\\s+of\\s+(?:the\\s+)?(month|week|term)\\b'),
        get: (m) => {
          if (m[1] === 'month') return () => endOfMonth(today);
          if (m[1] === 'week') return () => addDays(today, (5 - dow(today) + 7) % 7);
          const t = currentTerm(terms, today) || nextTerm(terms, today);
          return t ? () => t.end : null;
        } },
      { re: new RegExp('\\b(?:(on|by|due|next|this|coming|this\\s+coming|until)\\s+)?(' + WD + ')\\b'),
        get: (m, ctx) => {
          const word = m[2];
          const conn = m[1] ? m[1].replace(/\s+/g, ' ') : '';
          // "sat" (SAT), "sun", "wed" are ordinary words too — the short forms
          // only count as a day when something marks them as one.
          if (!conn && word.length === 3 && ['sat', 'sun', 'wed', 'mon'].indexOf(word) !== -1) return null;
          const target = wdIndex(word);
          return (timeMin) => {
            let delta = (target - dow(today) + 7) % 7;
            if (conn === 'next') {
              if (delta === 0) delta = 7;
              let d = addDays(today, delta);
              if (d <= addDays(startOfWeek(today, weekStart), 6)) d = addDays(d, 7);
              return d;
            }
            if (delta === 0 && timeMin !== null && timeMin <= ctx.nowMin) delta = 7;
            return addDays(today, delta);
          };
        } }
    ];
  }

  function parseQuickAdd(text, options) {
    const o = options || {};
    const now = typeof o.now === 'number' ? o.now : Date.now();
    const today = todayStr(now);
    const nowMin = minuteOfDay(now);
    const weekStart = o.weekStart === 0 || o.weekStart === 6 ? o.weekStart : 1;
    const dmy = o.dateOrder === 'dmy';
    const defaultDuration = o.defaultDuration > 0 ? o.defaultDuration : 60;

    const src = String(text || '').slice(0, 300);
    let work = src.toLowerCase();
    const spans = [];

    function consume(start, end, type) {
      work = work.slice(0, start) + ' '.repeat(end - start) + work.slice(end);
      spans.push({ start, end, type, text: src.slice(start, end) });
    }
    // Run `re` against the working copy; `accept(m)` may veto a match.
    function take(re, type, accept) {
      const m = re.exec(work);
      if (!m) return null;
      if (accept && accept(m) === false) return null;
      consume(m.index, m.index + m[0].length, type);
      return m;
    }

    const out = {
      title: '', kind: 'event', allDay: true, start: null, end: null, hasDate: false, hasTime: false,
      rrule: null, reminders: undefined, important: false, calendarName: null, location: '', tags: [], spans
    };

    // Calendar (#work), location (@library / @"room 204"), importance (!).
    let m = take(/(?<!\S)#([\p{L}\p{N}_-]{1,40})/u, 'calendar');
    if (m) out.calendarName = src.slice(m.index + 1, m.index + m[0].length);
    m = take(/(?<!\S)@(?:"([^"]{1,120})"|(\S{1,80}))/, 'location');
    if (m) {
      const raw = src.slice(m.index + 1, m.index + m[0].length);
      out.location = raw.replace(/^"|"$/g, '').replace(/_/g, ' ');
    }
    if (take(/(?<!\S)!{1,3}(?!\S)|!{1,3}$|(?<!\S)!important\b/, 'important')) out.important = true;

    // Reminders.
    if (take(/\b(?:no|without)\s+reminders?\b/, 'reminder')) out.reminders = [];
    m = take(new RegExp('\\bremind(?:\\s+me)?\\s+(?:' + NUM + '\\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|wks?|w)|(the\\s+day|the\\s+night|a\\s+day))\\s+(?:before|early|earlier|ahead|prior)\\b'), 'reminder');
    if (m) {
      let mins = 1440;
      if (m[1]) {
        const n = num(m[1]);
        const u = m[2];
        mins = Math.round(u[0] === 'w' ? n * 10080 : u[0] === 'd' ? n * 1440 : u[0] === 'h' ? n * 60 : n);
      }
      out.reminders = [Math.min(MAX_OFFSET, Math.max(0, mins))];
    }

    // Recurrence.
    let rec = null;
    m = take(new RegExp('\\b(?:every|each)\\s+(other\\s+|(\\d+)\\s+|(second|third|fourth)\\s+)?(days?|weekdays?|weekends?|weeks?|months?|years?)\\b'), 'repeat');
    if (m) {
      const interval = m[1] && m[1].trim() === 'other' ? 2 : m[2] ? +m[2] : m[3] ? { second: 2, third: 3, fourth: 4 }[m[3]] : 1;
      const unit = m[4];
      if (/^weekday/.test(unit)) rec = { freq: 'weekly', interval: 1, byDay: [1, 2, 3, 4, 5] };
      else if (/^weekend/.test(unit)) rec = { freq: 'weekly', interval: 1, byDay: [0, 6] };
      else rec = { freq: unit[0] === 'd' ? 'daily' : unit[0] === 'w' ? 'weekly' : unit[0] === 'm' ? 'monthly' : 'yearly', interval };
    }
    if (!rec) {
      m = take(new RegExp('\\b(?:every|each)\\s+(other\\s+)?(' + WD + '(?:\\s*(?:,|and|&|\\/|\\+|or)\\s*' + WD + ')*)\\b'), 'repeat');
      if (!m) m = take(new RegExp('\\b(?:on\\s+)?()(' + WDP + '(?:\\s*(?:,|and|&|\\/|\\+)\\s*' + WDP + ')*)\\b'), 'repeat');
      if (m) {
        const days = (m[2].match(new RegExp(WD + 's?', 'g')) || []).map(w => wdIndex(w)).filter(d => d >= 0);
        rec = { freq: 'weekly', interval: m[1] ? 2 : 1, byDay: Array.from(new Set(days)).sort((a, b) => a - b) };
      }
    }
    if (!rec) {
      m = take(/\b(?:on\s+)?(daily|everyday|weekly|bi-?weekly|fortnightly|monthly|yearly|annually|weekdays|weekends)\b/, 'repeat');
      if (m) {
        const w = m[1];
        rec = w === 'daily' || w === 'everyday' ? { freq: 'daily', interval: 1 }
          : w === 'weekly' ? { freq: 'weekly', interval: 1 }
            : /bi-?weekly|fortnightly/.test(w) ? { freq: 'weekly', interval: 2 }
              : w === 'monthly' ? { freq: 'monthly', interval: 1 }
                : w === 'weekdays' ? { freq: 'weekly', interval: 1, byDay: [1, 2, 3, 4, 5] }
                  : w === 'weekends' ? { freq: 'weekly', interval: 1, byDay: [0, 6] }
                    : { freq: 'yearly', interval: 1 };
      }
    }
    let untilText = null;
    let forCount = null;
    if (rec) {
      m = take(new RegExp('\\b(?:until|till|til|through|thru|ending)\\s+(' + DATE_EXPR + ')'), 'repeat');
      if (m) untilText = m[1];
      m = take(new RegExp('\\bfor\\s+' + NUM + '\\s+(weeks?|months?|days?|years?|times|occurrences|sessions|classes|lessons)\\b'), 'repeat');
      if (m) forCount = { n: Math.max(1, Math.round(num(m[1]))), unit: m[2] };
    }

    // Duration ("for 2 hours", "for 90 min", "for half an hour", "for 1h30").
    let duration = null;
    m = take(new RegExp('\\bfor\\s+(?:(\\d+)\\s*h(?:ours?|rs?)?\\s*(\\d+)\\s*m(?:in(?:ute)?s?)?|(\\d+)h(\\d{2})|half\\s+an?\\s+hour|' + NUM + '\\s*(hours?|hrs?|h|minutes?|mins?|m)\\b)'), 'duration');
    if (m) {
      if (m[1]) duration = +m[1] * 60 + +m[2];
      else if (m[3]) duration = +m[3] * 60 + +m[4];
      else if (!m[5]) duration = 30;
      else duration = Math.round(num(m[5]) * (m[6][0] === 'h' ? 60 : 1));
      if (!(duration > 0)) duration = null;
    }

    // Dates.
    let dateResolver = null;
    let tonight = false;
    const ctx = { nowMin };
    outerDate:
    for (const rule of dateRules({ today, dmy, weekStart, terms: o.terms || [] })) {
      // Every match of a rule is tried, not just the first: in "SAT prep
      // tuesday" the first weekday-looking word is the exam, the date is the
      // second.
      const re = new RegExp(rule.re.source, 'g');
      let hit;
      while ((hit = re.exec(work))) {
        const resolver = rule.get(hit, ctx);
        if (!resolver) continue;
        consume(hit.index, hit.index + hit[0].length, 'date');
        dateResolver = resolver;
        if (rule.tonight && rule.tonight(hit)) tonight = true;
        break outerDate;
      }
    }

    // Times: a range first, then a single time, then a part of the day.
    let startMin = null;
    let endMin = null;
    m = take(new RegExp('\\b(from\\s+|between\\s+)?(' + TIME + ')\\s*(?:-|–|—|to|until|till|and)\\s*(' + TIME + ')(?![\\w:/])'), 'time', (mm) => {
      const a = parseTimeText(mm[2]), b = parseTimeText(mm[3]);
      if (!a || !b) return false;
      if (/\band\b/.test(mm[0]) && !/^between/.test(mm[1] || '')) return false;
      if (!mm[1] && !a.mer && !b.mer && !a.colon && !b.colon) return false;
      let s, e;
      if (!a.mer && b.mer) {
        e = b.min;
        const h = a.raw % 12;
        const pm = h * 60 + (a.min % 60) + 720, am = h * 60 + (a.min % 60);
        s = b.mer === 'p' ? (pm <= e ? pm : am) : am;
        if (a.lead0 || a.raw > 12) s = a.min;
      } else {
        s = a.mer ? a.min : withoutMeridiem(a);
        e = b.mer ? b.min : withoutMeridiem(b);
        if (!b.mer && e <= s && e + 720 > s && e + 720 < 1440) e += 720;
      }
      startMin = s;
      endMin = e;
      return true;
    });
    if (startMin === null) {
      m = take(new RegExp('\\b(at\\s+|@\\s*)?(' + TIME + ')(?![\\w:/])'), 'time', (mm) => {
        const t = parseTimeText(mm[2]);
        if (!t) return false;
        if (!mm[1] && !t.mer && !t.colon) return false;
        startMin = t.mer ? t.min : withoutMeridiem(t);
        return true;
      });
    }
    let partOfDay = null;
    m = take(/\b(?:(?:this|in\s+the)\s+)?(morning|afternoon|evening|tonight)\b/, 'time');
    if (m) {
      partOfDay = { morning: 540, afternoon: 840, evening: 1080, tonight: 1200 }[m[1]];
      if (m[1] === 'tonight') tonight = true;
    }
    if (startMin === null && partOfDay !== null) startMin = partOfDay;
    if (startMin === null && tonight) startMin = 1200;

    // Kind + tags — read from the full original text.
    const lower = src.toLowerCase();
    if (/\b(due|deadline|homework|hw|assignment|essay|submit|submission|hand\s+in|turn\s+in|todo|to-do|to\s+do|task|worksheet)\b/.test(lower) ||
        /^\s*(todo|task)\s*:/.test(lower)) out.kind = 'task';
    // SAT / ACT only count in capitals — lower-case "sat" is a Saturday.
    if (/\b(exam|exams|test|tests|quiz|midterm|midterms|final|finals|gcse|gcses|a-levels?|mock|mocks)\b/.test(lower) ||
        /\b(SAT|ACT|PSAT)\b/.test(src)) out.tags.push('exam');
    if (/\b(class|lecture|lesson|lab|seminar|tutorial|period|homeroom|homework|hw|assignment|essay|study|revision|revise)\b/.test(lower)) out.tags.push('school');
    if (/\b(meeting|standup|stand-up|sync|1:1|one-on-one|interview|shift|client|call|review|presentation|deploy|sprint|office)\b/.test(lower)) out.tags.push('work');

    // ── Assemble ──
    let date = dateResolver ? dateResolver(startMin) : null;
    if (!date && rec) {
      if (rec.byDay && rec.byDay.length) {
        for (let i = 0; i < 8; i++) {
          const d = addDays(today, i);
          if (rec.byDay.indexOf(dow(d)) === -1) continue;
          if (i === 0 && startMin !== null && startMin <= nowMin) continue;
          date = d;
          break;
        }
      } else {
        date = startMin !== null && startMin <= nowMin ? addDays(today, 1) : today;
      }
    }
    if (!date && startMin !== null) date = startMin > nowMin || tonight ? today : addDays(today, 1);

    if (rec) {
      const r = { freq: rec.freq, interval: rec.interval || 1 };
      if (rec.freq === 'weekly') r.byDay = rec.byDay && rec.byDay.length ? rec.byDay : (date ? [dow(date)] : undefined);
      if (untilText) {
        const sub = parseQuickAdd(untilText, Object.assign({}, o, { now }));
        const ud = sub.start ? datePart(sub.start) : null;
        if (ud) r.until = ud;
      }
      if (forCount && date) {
        if (/^(times|occurrences|sessions|classes|lessons)$/.test(forCount.unit)) r.count = forCount.n;
        else {
          const u = forCount.unit[0];
          const end = u === 'd' ? addDays(date, forCount.n) : u === 'w' ? addDays(date, 7 * forCount.n)
            : u === 'm' ? addMonths(date, forCount.n) : addMonths(date, 12 * forCount.n);
          r.until = addDays(end, -1);
        }
      }
      out.rrule = r;
    }

    if (date) {
      out.hasDate = true;
      out.hasTime = startMin !== null;
      out.allDay = startMin === null;
      if (out.allDay) {
        out.start = date;
        out.end = date;
      } else {
        const s = date + 'T' + hhmm(startMin);
        out.start = s;
        if (out.kind === 'task') out.end = s;
        else if (endMin !== null) {
          let ew = dayNum(date) * 1440 + endMin;
          if (ew <= wall(s)) ew += 1440;
          out.end = fromWall(ew);
        } else {
          out.end = fromWall(wall(s) + (duration || defaultDuration));
        }
      }
    }

    // What remains is the title.
    let title = '';
    for (let i = 0; i < src.length; i++) title += work[i] === ' ' && src[i] !== ' ' ? ' ' : src[i];
    title = title.replace(/\s+/g, ' ').trim();
    if (out.kind === 'task') title = title.replace(/^(todo|task)\s*:\s*/i, '');
    const DANGLING = /^(?:at|on|by|from|for|in|the|every|due|and|with|,|-|–|—|:)\s+|\s+(?:at|on|by|from|for|in|the|every|due|and|,|-|–|—|:)$/i;
    let prev;
    do { prev = title; title = title.replace(DANGLING, '').replace(/^[,;:\-–—\s]+|[,;:\-–—\s]+$/g, ''); } while (title !== prev);
    out.title = title;
    return out;
  }

  // ── Export ──────────────────────────────────────────────────────────────
  const api = {
    MS_MIN, MS_HOUR, MS_DAY, MAX_OFFSET, WAKE_CAP, AWAY_MS,
    WEEKDAYS, WEEKDAYS_SHORT, MONTHS, MONTHS_SHORT, PALETTE, DEFAULT_CALENDARS, DEFAULT_SETTINGS, FREQS,
    // dates
    pad2, ymd, isDate, isDateTime, isTime, daysInMonth, dayNum, fromDayNum, addDays, diffDays, dow, addMonths,
    startOfWeek, startOfMonth, endOfMonth, isoWeek, datePart, timePart, minutesOf, hhmm, wall, fromWall,
    instant, todayStr, nowDateTime, minuteOfDay,
    // formatting
    fmtTime, fmtTimeRange, fmtDateShort, fmtDateLong, fmtMonthYear, fmtDayLabel, fmtDuration, fmtOffset,
    // events & recurrence
    evStartDate, evEndDate, spanDays, durationMinutes, nthOfMonth, nthWeekdayOfMonth, occurrenceKeys,
    isOccurrence, buildOccurrence, expandEvent, expandAll, compareOccurrences, occurrencesOnDay,
    occurrenceFor, nextOccurrence,
    // mutations
    editOccurrence, removeOccurrence, splitSeries, setTaskDone, movedTimes,
    // reminders
    effectiveReminders, reminderBaseMs, occStartMs, occEndMs, relevantUntil, collectReminderInstances,
    nextWakeAt, scan, inQuietHours, relativePhrase, describeAlert, digestSummary, missedSummary,
    // misc
    layoutDayColumns, findMeetingLink, safeHttpUrl, searchEvents,
    // sanitising
    genId, sanitizeReminders, sanitizeRRule, sanitizeEvent, sanitizeCalendar, sanitizeSettings, mergeSettings,
    VIEWS, RIGHT_CLICK, WEEK_NUMBERS_FROM, sanitizeTerms, currentTerm, nextTerm, termWeek, termLabel, weekNumberLabel,
    // quick add
    parseQuickAdd, parseTimeText
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CalendarEngine = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
