// iCalendar (.ics, RFC 5545) import and export for the Calendar mini widget.
//
// Pure — no Electron, no fs — so it is tested directly (test/calendar-ics.test.js)
// and used by main/calendar.js for three things: importing a file, keeping a
// subscribed calendar URL in sync (a school timetable, a work rota, a Google or
// Outlook "secret iCal address"), and exporting the user's own calendars.
//
// Imported data is untrusted. Everything parsed here is handed to
// CalendarEngine.sanitizeEvent before it reaches the store, and this module
// caps how much it will read, so a hostile or enormous feed can neither
// smuggle an odd shape in nor make main churn.
//
// Time zones. The widget stores local wall-clock time (see calendar-engine.js),
// so every DTSTART is converted into THIS machine's zone on the way in:
//   • `...Z` (UTC)            → exact conversion
//   • `TZID=Europe/Berlin`    → exact conversion via Intl (handles DST)
//   • `TZID=W. Europe Standard Time` (Outlook's Windows names) → mapped to IANA
//   • no zone ("floating")    → taken as local, which is what floating means
// A recurring event is anchored at its first occurrence's local time. If the
// source zone and this one change clocks on different dates, occurrences in
// the weeks between can sit an hour off — the same compromise most desktop
// calendar clients make for foreign-zone series.

const E = require('../renderer/calendar-engine');

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_EVENTS = 10000;

// Outlook/Exchange write Windows zone names; Intl only knows IANA ones.
const WINDOWS_ZONES = {
  'utc': 'UTC',
  'coordinated universal time': 'UTC',
  'gmt standard time': 'Europe/London',
  'greenwich standard time': 'Atlantic/Reykjavik',
  'w. europe standard time': 'Europe/Berlin',
  'central europe standard time': 'Europe/Budapest',
  'central european standard time': 'Europe/Warsaw',
  'romance standard time': 'Europe/Paris',
  'e. europe standard time': 'Europe/Chisinau',
  'fle standard time': 'Europe/Kiev',
  'gtb standard time': 'Europe/Bucharest',
  'russian standard time': 'Europe/Moscow',
  'turkey standard time': 'Europe/Istanbul',
  'israel standard time': 'Asia/Jerusalem',
  'south africa standard time': 'Africa/Johannesburg',
  'arabian standard time': 'Asia/Dubai',
  'india standard time': 'Asia/Kolkata',
  'china standard time': 'Asia/Shanghai',
  'singapore standard time': 'Asia/Singapore',
  'tokyo standard time': 'Asia/Tokyo',
  'korea standard time': 'Asia/Seoul',
  'aus eastern standard time': 'Australia/Sydney',
  'e. australia standard time': 'Australia/Brisbane',
  'cen. australia standard time': 'Australia/Adelaide',
  'w. australia standard time': 'Australia/Perth',
  'new zealand standard time': 'Pacific/Auckland',
  'eastern standard time': 'America/New_York',
  'central standard time': 'America/Chicago',
  'mountain standard time': 'America/Denver',
  'us mountain standard time': 'America/Phoenix',
  'pacific standard time': 'America/Los_Angeles',
  'alaskan standard time': 'America/Anchorage',
  'hawaiian standard time': 'Pacific/Honolulu',
  'atlantic standard time': 'America/Halifax',
  'newfoundland standard time': 'America/St_Johns',
  'canada central standard time': 'America/Regina',
  'mexico standard time': 'America/Mexico_City',
  'central standard time (mexico)': 'America/Mexico_City',
  'sa pacific standard time': 'America/Bogota',
  'e. south america standard time': 'America/Sao_Paulo',
  'argentina standard time': 'America/Buenos_Aires'
};

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

// ── Lines ─────────────────────────────────────────────────────────────────

function unfold(text) {
  return String(text).replace(/\r\n|\r/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

// "DTSTART;TZID=Europe/Berlin;VALUE=DATE-TIME:20260911T100000"
function parseLine(line) {
  let i = 0;
  let inQuote = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ':' && !inQuote) break;
  }
  if (i >= line.length) return null;
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const parts = [];
  let cur = '';
  inQuote = false;
  for (const c of head) {
    if (c === '"') { inQuote = !inQuote; continue; }
    if (c === ';' && !inQuote) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  const name = parts.shift().toUpperCase();
  const params = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
  }
  return { name, params, value };
}

function unescapeText(v) {
  return String(v).replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

function escapeText(v) {
  return String(v || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

// Lines longer than 75 octets are folded (RFC 5545 §3.1) without splitting a
// multi-byte character.
function fold(line) {
  const bytes = (s) => Buffer.byteLength(s, 'utf8');
  if (bytes(line) <= 75) return line;
  const out = [];
  let cur = '';
  let limit = 75;
  for (const ch of line) {
    if (bytes(cur + ch) > limit) {
      out.push(cur);
      cur = ch;
      limit = 74; // continuation lines start with a space
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out.join('\r\n ');
}

// ── Time zones ────────────────────────────────────────────────────────────

const zoneCache = new Map();

function resolveZone(tzid) {
  if (!tzid) return null;
  const raw = String(tzid).replace(/^"|"$/g, '').trim();
  if (zoneCache.has(raw)) return zoneCache.get(raw);
  let zone = WINDOWS_ZONES[raw.toLowerCase()] || null;
  if (!zone) {
    // Accept plain IANA names and the vendor-prefixed forms some exporters
    // write ("/mozilla.org/20050126_1/America/New_York").
    const m = /([A-Za-z]+(?:\/[A-Za-z0-9_+\-]+){1,2})$/.exec(raw);
    const candidate = m ? m[1] : raw;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: candidate });
      zone = candidate;
    } catch (e) {
      zone = null;
    }
  }
  zoneCache.set(raw, zone);
  return zone;
}

// How far `zone` is ahead of UTC at instant `ms`, in ms.
function zoneOffsetMs(zone, ms) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const p = {};
  for (const part of f.formatToParts(new Date(ms))) p[part.type] = part.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

// Wall time in `zone` → the real instant.
function zonedToInstant(y, mo, d, h, mi, s, zone) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const off1 = zoneOffsetMs(zone, guess);
  let t = guess - off1;
  const off2 = zoneOffsetMs(zone, t);
  if (off2 !== off1) t = guess - off2;
  return t;
}

// An ICS date/datetime value → { allDay, local } in THIS machine's wall time.
function parseIcsDate(value, params) {
  const v = String(value || '').trim();
  const p = params || {};
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m || p.VALUE === 'DATE') {
    if (!m) m = /^(\d{4})(\d{2})(\d{2})/.exec(v);
    if (!m) return null;
    const d = m[1] + '-' + m[2] + '-' + m[3];
    return E.isDate(d) ? { allDay: true, local: d } : null;
  }
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3], h = +m[4], mi = +m[5], s = +(m[6] || 0);
  let local;
  if (m[7]) {
    local = E.nowDateTime(Date.UTC(y, mo - 1, d, h, mi, s));
  } else if (p.TZID && resolveZone(p.TZID)) {
    local = E.nowDateTime(zonedToInstant(y, mo, d, h, mi, s, resolveZone(p.TZID)));
  } else {
    local = E.ymd(y, mo, d) + 'T' + E.pad2(h) + ':' + E.pad2(mi);
  }
  return E.isDateTime(local) ? { allDay: false, local } : null;
}

// "P1DT2H30M" / "-PT15M" / "P2W" → signed minutes.
function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(v || '').trim());
  if (!m) return null;
  const mins = (+(m[2] || 0)) * 10080 + (+(m[3] || 0)) * 1440 + (+(m[4] || 0)) * 60 + (+(m[5] || 0)) + Math.round((+(m[6] || 0)) / 60);
  return m[1] === '-' ? -mins : mins;
}

function fmtDuration(mins) {
  const neg = mins < 0;
  let n = Math.abs(mins);
  const d = Math.floor(n / 1440); n -= d * 1440;
  const h = Math.floor(n / 60); const mi = n - h * 60;
  let out = (neg ? '-' : '') + 'P' + (d ? d + 'D' : '');
  if (h || mi || !d) out += 'T' + (h ? h + 'H' : '') + (mi || (!h) ? mi + 'M' : '');
  return out;
}

// ── RRULE ─────────────────────────────────────────────────────────────────

function parseRRule(value, startLocal, warnings) {
  const parts = {};
  for (const kv of String(value || '').split(';')) {
    const eq = kv.indexOf('=');
    if (eq > 0) parts[kv.slice(0, eq).toUpperCase()] = kv.slice(eq + 1).toUpperCase();
  }
  const freq = { DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly', YEARLY: 'yearly' }[parts.FREQ];
  if (!freq) {
    if (parts.FREQ) warnings.push('Unsupported repeat rule FREQ=' + parts.FREQ + ' — imported as a single event');
    return null;
  }
  const startDate = startLocal.slice(0, 10);
  const r = { freq, interval: parts.INTERVAL ? +parts.INTERVAL : 1 };
  if (parts.COUNT) r.count = +parts.COUNT;
  if (parts.UNTIL) {
    const u = parseIcsDate(parts.UNTIL, {});
    if (u) r.until = u.local.slice(0, 10);
  }
  if (parts.WKST && DAY_CODES.indexOf(parts.WKST) !== -1) r.wkst = DAY_CODES.indexOf(parts.WKST);
  const byDay = (parts.BYDAY || '').split(',').filter(Boolean).map(tok => {
    const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(tok);
    return m ? { n: m[1] ? +m[1] : null, day: DAY_CODES.indexOf(m[2]) } : null;
  }).filter(Boolean);

  if (freq === 'daily' && byDay.length) {
    // FREQ=DAILY;BYDAY=MO,...,FR is how some exporters say "every weekday".
    r.freq = 'weekly';
    r.byDay = byDay.map(b => b.day);
  } else if (freq === 'weekly') {
    if (byDay.length) r.byDay = byDay.map(b => b.day);
  } else if (freq === 'monthly' || freq === 'yearly') {
    const withN = byDay.find(b => b.n !== null);
    const setpos = parts.BYSETPOS ? +parts.BYSETPOS : null;
    if (withN || (byDay.length === 1 && setpos)) {
      r.monthMode = 'nth';
      const n = withN ? withN.n : setpos;
      r.nth = n < 0 ? -1 : Math.min(4, Math.max(1, n));
    } else {
      r.monthMode = 'day';
    }
    if (parts.BYMONTHDAY && parts.BYMONTHDAY.indexOf(',') !== -1) {
      warnings.push('A repeat rule with several days of the month was simplified to its first');
    }
    if (parts.BYMONTH && parts.BYMONTH.indexOf(',') !== -1) {
      warnings.push('A repeat rule over several months was simplified');
    }
  }
  if (parts.BYHOUR || parts.BYMINUTE || parts.BYWEEKNO || parts.BYYEARDAY) {
    warnings.push('Part of a complex repeat rule was simplified');
  }
  return E.sanitizeRRule(r, startDate);
}

function rruleToIcs(ev) {
  const r = ev.rrule;
  const out = ['FREQ=' + r.freq.toUpperCase()];
  if (r.interval && r.interval > 1) out.push('INTERVAL=' + r.interval);
  const start = ev.start.slice(0, 10);
  const wd = E.dow(start);
  if (r.freq === 'weekly') {
    out.push('BYDAY=' + (r.byDay && r.byDay.length ? r.byDay : [wd]).map(d => DAY_CODES[d]).join(','));
    if (typeof r.wkst === 'number' && r.wkst !== 1) out.push('WKST=' + DAY_CODES[r.wkst]);
  }
  if ((r.freq === 'monthly' || r.freq === 'yearly') && r.monthMode === 'nth') {
    const nth = r.nth || E.nthOfMonth(start);
    if (r.freq === 'yearly') out.push('BYMONTH=' + (+start.slice(5, 7)));
    out.push('BYDAY=' + nth + DAY_CODES[wd]);
  }
  if (r.count) out.push('COUNT=' + r.count);
  else if (r.until) out.push('UNTIL=' + r.until.replace(/-/g, '') + (ev.allDay ? '' : 'T235959'));
  return out.join(';');
}

// ── Import ────────────────────────────────────────────────────────────────

function isHexColor(s) { return /^#[0-9a-f]{6}$/i.test(String(s || '').trim()); }

// → { name, color, events: [event inputs for sanitizeEvent], warnings, skipped }
function parseIcs(text, opts) {
  const warnings = [];
  const out = { name: null, color: null, events: [], warnings, skipped: 0 };
  const src = String(text || '');
  if (Buffer.byteLength(src, 'utf8') > MAX_BYTES) {
    warnings.push('The file is larger than 8 MB — nothing was imported');
    return out;
  }
  if (!/BEGIN:VCALENDAR/i.test(src)) {
    warnings.push('This doesn\'t look like an iCalendar (.ics) file');
    return out;
  }
  const allDayBase = E.minutesOf((opts && opts.allDayReminderTime) || '09:00');

  const comps = [];
  const stack = [];
  for (const raw of unfold(src)) {
    if (!raw) continue;
    const line = parseLine(raw);
    if (!line) continue;
    if (line.name === 'BEGIN') {
      const type = line.value.trim().toUpperCase();
      stack.push({ type, props: [], alarms: [] });
      continue;
    }
    if (line.name === 'END') {
      const done = stack.pop();
      if (!done) continue;
      const parent = stack[stack.length - 1];
      if (done.type === 'VALARM' && parent) parent.alarms.push(done);
      else if (done.type === 'VEVENT' || done.type === 'VTODO') comps.push(done);
      if (comps.length > MAX_EVENTS * 2) break;
      continue;
    }
    const top = stack[stack.length - 1];
    if (!top) continue;
    if (top.type === 'VCALENDAR') {
      if (line.name === 'X-WR-CALNAME' && !out.name) out.name = unescapeText(line.value).slice(0, 40);
      if ((line.name === 'X-APPLE-CALENDAR-COLOR' || line.name === 'COLOR') && isHexColor(line.value.slice(0, 7))) {
        out.color = line.value.slice(0, 7).toLowerCase();
      }
      continue;
    }
    top.props.push(line);
  }

  const byUid = new Map();
  const overrides = [];
  for (const c of comps) {
    const get = (n) => c.props.find(p => p.name === n) || null;
    const all = (n) => c.props.filter(p => p.name === n);
    const isTodo = c.type === 'VTODO';
    const startProp = get('DTSTART') || (isTodo ? get('DUE') : null);
    if (!startProp) { out.skipped++; continue; }
    const st = parseIcsDate(startProp.value, startProp.params);
    if (!st) { out.skipped++; continue; }

    const status = (get('STATUS') ? get('STATUS').value : '').trim().toUpperCase();
    const uid = get('UID') ? unescapeText(get('UID').value).trim() : null;
    const recId = get('RECURRENCE-ID');

    let end = null;
    if (!isTodo) {
      const endProp = get('DTEND');
      const durProp = get('DURATION');
      if (endProp) {
        const en = parseIcsDate(endProp.value, endProp.params);
        if (en) end = en.local;
      } else if (durProp) {
        const mins = parseDuration(durProp.value);
        if (mins !== null) end = st.allDay ? E.addDays(st.local, Math.max(1, Math.round(mins / 1440))) : E.fromWall(E.wall(st.local) + mins);
      }
    }
    let startLocal = st.local;
    let endLocal;
    if (st.allDay) {
      // DTEND of an all-day event is EXCLUSIVE; the store keeps the last day.
      const endDate = end ? end.slice(0, 10) : E.addDays(startLocal, 1);
      endLocal = endDate > startLocal ? E.addDays(endDate, -1) : startLocal;
    } else {
      endLocal = end && E.isDateTime(end) ? end : startLocal;
      if (end && E.isDate(end)) endLocal = end + 'T00:00';
    }

    const reminders = [];
    for (const a of c.alarms) {
      const trig = a.props.find(p => p.name === 'TRIGGER');
      if (!trig) continue;
      if (trig.params.VALUE === 'DATE-TIME') continue;
      const mins = parseDuration(trig.value);
      if (mins === null) continue;
      const related = (trig.params.RELATED || 'START').toUpperCase();
      if (related !== 'START') continue;
      // Our all-day reminders are measured from allDayReminderTime, an ICS
      // trigger from midnight — translate between the two.
      const before = st.allDay ? allDayBase - mins : -mins;
      if (before >= 0 && before <= E.MAX_OFFSET) reminders.push(Math.round(before));
    }

    const text = (n) => (get(n) ? unescapeText(get(n).value) : '');
    const priority = get('PRIORITY') ? +get('PRIORITY').value : 0;
    const item = {
      uid,
      kind: isTodo ? 'task' : 'event',
      title: text('SUMMARY'),
      location: text('LOCATION'),
      notes: text('DESCRIPTION'),
      url: get('URL') ? get('URL').value.trim() : '',
      allDay: st.allDay,
      start: startLocal,
      end: endLocal,
      reminders: c.alarms.length ? reminders : null,
      important: priority >= 1 && priority <= 4,
      done: isTodo && (status === 'COMPLETED' || !!get('COMPLETED')),
      rrule: null,
      exdates: [],
      overrides: {}
    };

    if (recId) {
      const rid = parseIcsDate(recId.value, recId.params);
      if (rid && uid) overrides.push({ uid, key: rid.local.slice(0, 10), item, cancelled: status === 'CANCELLED' });
      continue;
    }
    if (status === 'CANCELLED') { out.skipped++; continue; }

    const rr = get('RRULE');
    if (rr) item.rrule = parseRRule(rr.value, startLocal, warnings);
    for (const ex of all('EXDATE')) {
      for (const v of ex.value.split(',')) {
        const d = parseIcsDate(v, ex.params);
        if (d) item.exdates.push(d.local.slice(0, 10));
      }
    }
    if (uid && byUid.has(uid)) {
      out.skipped++;
      continue;
    }
    if (uid) byUid.set(uid, item);
    out.events.push(item);
    if (out.events.length >= MAX_EVENTS) {
      warnings.push('Only the first ' + MAX_EVENTS + ' events were imported');
      break;
    }
  }

  // RECURRENCE-ID components edit one occurrence of their series.
  for (const o of overrides) {
    const parent = byUid.get(o.uid);
    if (!parent || !parent.rrule) {
      if (!o.cancelled && out.events.length < MAX_EVENTS) out.events.push(Object.assign(o.item, { uid: o.uid + '#' + o.key }));
      continue;
    }
    if (o.cancelled) {
      parent.exdates.push(o.key);
      continue;
    }
    const ov = { start: o.item.start, end: o.item.end, allDay: o.item.allDay };
    if (o.item.title !== parent.title) ov.title = o.item.title;
    if (o.item.location !== parent.location) ov.location = o.item.location;
    if (o.item.notes !== parent.notes) ov.notes = o.item.notes;
    parent.overrides[o.key] = ov;
  }

  if (out.events.length === 0 && !warnings.length) warnings.push('No events were found in this file');
  return out;
}

// ── Export ────────────────────────────────────────────────────────────────

function icsDate(d) { return d.replace(/-/g, ''); }
function icsDateTime(dt) { return dt.slice(0, 10).replace(/-/g, '') + 'T' + dt.slice(11, 16).replace(':', '') + '00'; }
function icsStamp(ms) { return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }

function serializeIcs(events, opts) {
  const o = opts || {};
  const now = typeof o.now === 'number' ? o.now : Date.now();
  const allDayBase = E.minutesOf(o.allDayReminderTime || '09:00');
  const cals = o.calendarsById || {};
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//main//Calendar widget//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  if (o.name) lines.push('X-WR-CALNAME:' + escapeText(o.name));

  const emit = (ev, uid, recurrenceKey, ov) => {
    const isTask = ev.kind === 'task';
    const comp = isTask ? 'VTODO' : 'VEVENT';
    const allDay = ov && typeof ov.allDay === 'boolean' ? ov.allDay : ev.allDay;
    const start = ov ? ov.start : ev.start;
    const end = ov ? ov.end : ev.end;
    lines.push('BEGIN:' + comp);
    lines.push('UID:' + escapeText(uid));
    lines.push('DTSTAMP:' + icsStamp(now));
    if (recurrenceKey) {
      lines.push(ev.allDay
        ? 'RECURRENCE-ID;VALUE=DATE:' + icsDate(recurrenceKey)
        : 'RECURRENCE-ID:' + icsDateTime(recurrenceKey + 'T' + ev.start.slice(11, 16)));
    }
    const startProp = isTask ? 'DUE' : 'DTSTART';
    if (allDay) {
      lines.push(startProp + ';VALUE=DATE:' + icsDate(start.slice(0, 10)));
      if (!isTask) lines.push('DTEND;VALUE=DATE:' + icsDate(E.addDays((end || start).slice(0, 10), 1)));
    } else {
      lines.push(startProp + ':' + icsDateTime(start));
      if (!isTask) lines.push('DTEND:' + icsDateTime(end || start));
    }
    if (isTask && !recurrenceKey) lines.push('DTSTART' + (allDay ? ';VALUE=DATE:' + icsDate(start.slice(0, 10)) : ':' + icsDateTime(start)));
    const title = ov && typeof ov.title === 'string' ? ov.title : ev.title;
    const location = ov && typeof ov.location === 'string' ? ov.location : ev.location;
    const notes = ov && typeof ov.notes === 'string' ? ov.notes : ev.notes;
    lines.push('SUMMARY:' + escapeText(title));
    if (location) lines.push('LOCATION:' + escapeText(location));
    if (notes) lines.push('DESCRIPTION:' + escapeText(notes));
    if (ev.url) lines.push('URL:' + ev.url);
    if (ev.important) lines.push('PRIORITY:1');
    if (cals[ev.calendarId]) lines.push('CATEGORIES:' + escapeText(cals[ev.calendarId].name));
    if (isTask) {
      const done = ev.rrule ? (ev.doneDates || []).indexOf(recurrenceKey || ev.start.slice(0, 10)) !== -1 : !!ev.done;
      lines.push('STATUS:' + (done ? 'COMPLETED' : 'NEEDS-ACTION'));
    }
    if (!recurrenceKey && ev.rrule) {
      lines.push('RRULE:' + rruleToIcs(ev));
      if (ev.exdates && ev.exdates.length) {
        lines.push(ev.allDay
          ? 'EXDATE;VALUE=DATE:' + ev.exdates.map(icsDate).join(',')
          : 'EXDATE:' + ev.exdates.map(d => icsDateTime(d + 'T' + ev.start.slice(11, 16))).join(','));
      }
    }
    const rem = Array.isArray(ev.reminders) ? ev.reminders
      : (cals[ev.calendarId] ? (ev.allDay ? cals[ev.calendarId].defaultAllDayReminders : cals[ev.calendarId].defaultReminders) : null);
    for (const off of rem || []) {
      const trigger = allDay ? allDayBase - off : -off;
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + escapeText(title), 'TRIGGER:' + fmtDuration(trigger), 'END:VALARM');
    }
    lines.push('END:' + comp);
  };

  for (const ev of events || []) {
    const uid = ev.uid || (ev.id + '@main-calendar');
    emit(ev, uid, null, null);
    if (ev.rrule && ev.overrides) {
      for (const key of Object.keys(ev.overrides)) emit(ev, uid, key, ev.overrides[key]);
    }
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

module.exports = {
  MAX_BYTES, MAX_EVENTS, WINDOWS_ZONES,
  unfold, parseLine, unescapeText, escapeText, fold,
  resolveZone, zoneOffsetMs, zonedToInstant, parseIcsDate, parseDuration, fmtDuration,
  parseRRule, rruleToIcs, parseIcs, serializeIcs
};
