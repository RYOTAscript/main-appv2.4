'use strict';

// Calendar engine — recurrence, reminders, the scheduler's due/missed rules,
// quick-add parsing and input sanitising (renderer/calendar-engine.js).
//
// Pinned to a zone WITH daylight saving so the DST assertions mean something
// on any machine. node --test runs each file in its own process, so this
// only affects this file.
process.env.TZ = 'America/New_York';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('../renderer/calendar-engine.js');

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
// Friday 11 September 2026, 14:05 local.
const NOW = at(2026, 9, 11, 14, 5);

// ── Reference recurrence generator ──────────────────────────────────────────
// Deliberately naive: walks every day from the series start and asks "is this
// day an occurrence?" straight from the rule's definition. The engine skips
// ahead, indexes weeks and counts cleverly; this does none of that, so any
// disagreement between the two is a bug in the clever one.
function reference(ev, from, to) {
  const r = ev.rrule;
  const start = ev.start.slice(0, 10);
  const out = [];
  let generated = 0;
  const wkst = typeof r.wkst === 'number' ? r.wkst : 1;
  const anchor = E.startOfWeek(start, wkst);
  const sy = +start.slice(0, 4), sm = +start.slice(5, 7), sd = +start.slice(8, 10);
  const nth = r.nth || E.nthOfMonth(start);
  for (let d = start; d <= to; d = E.addDays(d, 1)) {
    if (r.until && d > r.until) break;
    const y = +d.slice(0, 4), m = +d.slice(5, 7), day = +d.slice(8, 10);
    let hit = false;
    if (r.freq === 'daily') hit = E.diffDays(start, d) % r.interval === 0;
    if (r.freq === 'weekly') {
      const week = Math.floor(E.diffDays(anchor, d) / 7);
      hit = week % r.interval === 0 && (r.byDay || [E.dow(start)]).includes(E.dow(d));
    }
    if (r.freq === 'monthly' || r.freq === 'yearly') {
      const monthDiff = (y - sy) * 12 + (m - sm);
      const stepOk = r.freq === 'monthly' ? monthDiff % r.interval === 0 : (m === sm && (y - sy) % r.interval === 0);
      if (stepOk) {
        hit = r.monthMode === 'nth'
          ? E.dow(d) === E.dow(start) && day === E.nthWeekdayOfMonth(y, m, E.dow(start), nth)
          : day === sd;
      }
    }
    if (!hit) continue;
    if (r.count && generated >= r.count) break;
    generated++;
    if (d >= from && !(ev.exdates || []).includes(d)) out.push(d);
  }
  return out;
}

// Deterministic PRNG so a failure is reproducible.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// ── Date primitives ─────────────────────────────────────────────────────────

test('weekday, month length and ISO week are correct', () => {
  assert.equal(E.dow('2026-09-11'), 5);          // Friday
  assert.equal(E.dow('1970-01-01'), 4);          // Thursday
  assert.equal(E.dow('1969-12-31'), 3);          // negative day numbers too
  assert.equal(E.daysInMonth(2028, 2), 29);
  assert.equal(E.daysInMonth(2026, 2), 28);
  assert.equal(E.isoWeek('2026-01-01'), 1);
  assert.equal(E.isoWeek('2026-12-31'), 53);
  assert.equal(E.isoWeek('2027-01-01'), 53);     // belongs to 2026's last week
  assert.equal(E.addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(E.startOfWeek('2026-09-11', 1), '2026-09-07');
  assert.equal(E.startOfWeek('2026-09-11', 0), '2026-09-06');
});

test('date arithmetic ignores daylight saving entirely', () => {
  // US clocks go forward on 2026-03-08 and back on 2026-11-01.
  assert.equal(E.addDays('2026-03-07', 1), '2026-03-08');
  assert.equal(E.addDays('2026-03-08', 1), '2026-03-09');
  assert.equal(E.diffDays('2026-10-31', '2026-11-02'), 2);
  // A 01:00–03:00 event on the spring-forward night is still two wall hours.
  assert.equal(E.durationMinutes({ start: '2026-03-08T01:00', end: '2026-03-08T03:00' }), 120);
  assert.equal(E.fromWall(E.wall('2026-03-08T23:30') + 60), '2026-03-09T00:30');
});

test('isDate / isDateTime reject impossible values', () => {
  assert.ok(E.isDate('2028-02-29'));
  assert.ok(!E.isDate('2026-02-29'));
  assert.ok(!E.isDate('2026-13-01'));
  assert.ok(!E.isDate('26-01-01'));
  assert.ok(E.isDateTime('2026-09-11T23:59'));
  assert.ok(!E.isDateTime('2026-09-11T24:00'));
  assert.ok(!E.isDateTime('2026-09-11 10:00'));
});

// ── Recurrence ──────────────────────────────────────────────────────────────

test('monthly on the 31st skips short months (RFC 5545)', () => {
  const ev = { id: 'a', start: '2026-01-31T10:00', end: '2026-01-31T11:00', rrule: { freq: 'monthly', interval: 1 } };
  assert.deepEqual(E.occurrenceKeys(ev, '2026-01-01', '2026-12-31'),
    ['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31', '2026-08-31', '2026-10-31', '2026-12-31']);
});

test('yearly on Feb 29 only lands in leap years', () => {
  const ev = { id: 'a', allDay: true, start: '2024-02-29', end: '2024-02-29', rrule: { freq: 'yearly', interval: 1 } };
  assert.deepEqual(E.occurrenceKeys(ev, '2024-01-01', '2033-01-01'), ['2024-02-29', '2028-02-29', '2032-02-29']);
});

test('weekly COUNT counts generated instances, and exdates never shift it', () => {
  const ev = { id: 'b', start: '2026-09-09T10:00', end: '2026-09-09T11:00',
    rrule: { freq: 'weekly', interval: 1, byDay: [1, 3, 5], count: 5 } };
  assert.deepEqual(E.occurrenceKeys(ev, '2026-09-01', '2026-12-31'),
    ['2026-09-09', '2026-09-11', '2026-09-14', '2026-09-16', '2026-09-18']);
  const withEx = Object.assign({}, ev, { exdates: ['2026-09-14'] });
  assert.deepEqual(E.occurrenceKeys(withEx, '2026-09-01', '2026-12-31'),
    ['2026-09-09', '2026-09-11', '2026-09-16', '2026-09-18']);
});

test('monthly by weekday: 2nd Tuesday and last Friday', () => {
  const second = { id: 'c', start: '2026-09-08T18:00', end: '2026-09-08T19:00', rrule: { freq: 'monthly', interval: 1, monthMode: 'nth' } };
  assert.deepEqual(E.occurrenceKeys(second, '2026-09-01', '2026-12-31'), ['2026-09-08', '2026-10-13', '2026-11-10', '2026-12-08']);
  const last = { id: 'd', start: '2026-10-30T17:00', end: '2026-10-30T18:00', rrule: { freq: 'monthly', interval: 1, monthMode: 'nth', nth: -1 } };
  assert.deepEqual(E.occurrenceKeys(last, '2026-10-01', '2027-01-31'), ['2026-10-30', '2026-11-27', '2026-12-25', '2027-01-29']);
});

test('until is inclusive', () => {
  const ev = { id: 'e', allDay: true, start: '2026-09-11', end: '2026-09-11', rrule: { freq: 'daily', interval: 3, until: '2026-09-20' } };
  assert.deepEqual(E.occurrenceKeys(ev, '2026-01-01', '2026-12-31'), ['2026-09-11', '2026-09-14', '2026-09-17', '2026-09-20']);
});

test('recurrence agrees with a brute-force reference across 400 random rules', () => {
  const rand = rng(1234);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  for (let i = 0; i < 400; i++) {
    const start = E.addDays('2024-01-01', Math.floor(rand() * 900));
    const freq = pick(E.FREQS);
    const r = { freq, interval: 1 + Math.floor(rand() * 3) };
    if (freq === 'weekly') {
      const days = new Set([E.dow(start)]);
      for (let k = 0; k < 3; k++) if (rand() < 0.5) days.add(Math.floor(rand() * 7));
      r.byDay = [...days].sort();
      if (rand() < 0.3) r.wkst = 0;
    }
    if ((freq === 'monthly' || freq === 'yearly') && rand() < 0.5) r.monthMode = 'nth';
    if (rand() < 0.3) r.count = 1 + Math.floor(rand() * 40);
    else if (rand() < 0.3) r.until = E.addDays(start, Math.floor(rand() * 800));
    const ev = { id: 'r' + i, start: start + 'T09:00', end: start + 'T10:00', rrule: r,
      exdates: rand() < 0.3 ? [E.addDays(start, 7), E.addDays(start, 14)] : [] };
    const from = E.addDays(start, Math.floor(rand() * 700) - 30);
    const to = E.addDays(from, Math.floor(rand() * 200));
    assert.deepEqual(E.occurrenceKeys(ev, from, to), reference(ev, from, to),
      `rule ${JSON.stringify(r)} from ${start}, window ${from}..${to}`);
  }
});

test('expansion far in the future is fast (no walking from the start)', () => {
  const ev = { id: 'f', start: '2000-01-03T08:00', end: '2000-01-03T09:00', rrule: { freq: 'weekly', interval: 1, byDay: [1, 2, 3, 4, 5] } };
  const t0 = Date.now();
  for (let i = 0; i < 200; i++) E.expandEvent(ev, '2090-01-01', '2090-02-11');
  assert.ok(Date.now() - t0 < 500, 'weekly expansion 90 years out should be near-instant');
  assert.equal(E.expandEvent(ev, '2090-01-01', '2090-01-07').length, 5);
});

test('multi-day and midnight-crossing items overlap the right days', () => {
  const trip = { id: 'g', allDay: true, start: '2026-09-10', end: '2026-09-13' };
  assert.equal(E.expandEvent(trip, '2026-09-12', '2026-09-12').length, 1);
  assert.equal(E.expandEvent(trip, '2026-09-14', '2026-09-20').length, 0);
  const late = { id: 'h', start: '2026-09-11T23:00', end: '2026-09-12T01:00' };
  assert.equal(E.expandEvent(late, '2026-09-12', '2026-09-12').length, 1);
  const toMidnight = { id: 'i', start: '2026-09-11T22:00', end: '2026-09-12T00:00' };
  assert.equal(E.expandEvent(toMidnight, '2026-09-12', '2026-09-12').length, 0, 'ending at midnight does not touch the next day');
  // A recurring multi-day item that started before the window still shows.
  const weekly = { id: 'j', allDay: true, start: '2026-09-05', end: '2026-09-07', rrule: { freq: 'weekly', interval: 1 } };
  assert.deepEqual(E.expandEvent(weekly, '2026-09-14', '2026-09-14').map(o => o.occKey), ['2026-09-12']);
});

test('an occurrence moved to another week shows there, not where it was', () => {
  let ev = { id: 'k', title: 'Class', start: '2026-09-07T10:00', end: '2026-09-07T11:00', rrule: { freq: 'weekly', interval: 1 } };
  ev = E.editOccurrence(ev, '2026-09-14', { start: '2026-09-23T15:00', end: '2026-09-23T16:00', title: 'Class (moved)' });
  const week2 = E.expandEvent(ev, '2026-09-14', '2026-09-20');
  assert.deepEqual(week2.map(o => o.occKey), [], 'gone from its original week');
  const week3 = E.expandEvent(ev, '2026-09-21', '2026-09-27');
  assert.equal(week3.length, 2);
  const moved = week3.find(o => o.overridden);
  assert.equal(moved.start, '2026-09-23T15:00');
  assert.equal(moved.title, 'Class (moved)');
  assert.equal(moved.uid, 'k|2026-09-14', 'keeps its identity');
});

test('removeOccurrence / occurrenceFor / nextOccurrence', () => {
  let ev = { id: 'l', start: '2026-09-07T10:00', end: '2026-09-07T11:00', rrule: { freq: 'weekly', interval: 1 } };
  ev = E.removeOccurrence(ev, '2026-09-14');
  assert.equal(E.occurrenceFor(ev, '2026-09-14'), null);
  assert.equal(E.occurrenceFor(ev, '2026-09-15'), null, 'not an occurrence at all');
  assert.equal(E.occurrenceFor(ev, '2026-09-21').start, '2026-09-21T10:00');
  assert.equal(E.nextOccurrence(ev, '2026-09-12').occKey, '2026-09-21');
  const once = { id: 'm', start: '2026-09-01T10:00', end: '2026-09-01T11:00' };
  assert.equal(E.nextOccurrence(once, '2026-09-11'), null);
});

test('splitSeries keeps the total COUNT and partitions exceptions', () => {
  const ev = { id: 'n', start: '2026-09-07T10:00', end: '2026-09-07T11:00',
    rrule: { freq: 'weekly', interval: 1, count: 10 }, exdates: ['2026-09-14', '2026-10-05'],
    overrides: { '2026-09-21': { start: '2026-09-21T12:00', end: '2026-09-21T13:00' } } };
  const { before, after } = E.splitSeries(ev, '2026-09-28', 'n2');
  assert.equal(before.rrule.count, 3);
  assert.equal(after.rrule.count, 7);
  assert.equal(after.id, 'n2');
  assert.equal(after.start, '2026-09-28T10:00');
  assert.deepEqual(before.exdates, ['2026-09-14']);
  assert.deepEqual(after.exdates, ['2026-10-05']);
  assert.ok(before.overrides['2026-09-21']);
  const all = E.occurrenceKeys(before, '2026-01-01', '2027-12-31').concat(E.occurrenceKeys(after, '2026-01-01', '2027-12-31'));
  const original = E.occurrenceKeys(ev, '2026-01-01', '2027-12-31');
  assert.deepEqual(all, original, 'the two halves together are the original series');
});

test('splitSeries with an until date', () => {
  const ev = { id: 'o', allDay: true, start: '2026-09-01', end: '2026-09-01', rrule: { freq: 'daily', interval: 1, until: '2026-09-10' } };
  const { before, after } = E.splitSeries(ev, '2026-09-05', 'o2');
  assert.equal(before.rrule.until, '2026-09-04');
  assert.equal(after.start, '2026-09-05');
  assert.equal(after.rrule.until, '2026-09-10');
  assert.equal(E.splitSeries(ev, '2026-09-01', 'x').before, null, 'splitting at the first occurrence is the whole series');
});

test('task done state: single and per-occurrence', () => {
  const task = { id: 'p', kind: 'task', allDay: true, start: '2026-09-12', end: '2026-09-12' };
  assert.equal(E.setTaskDone(task, '2026-09-12', true).done, true);
  const series = { id: 'q', kind: 'task', allDay: true, start: '2026-09-07', end: '2026-09-07', rrule: { freq: 'weekly', interval: 1 } };
  const s2 = E.setTaskDone(series, '2026-09-14', true);
  const occs = E.expandEvent(s2, '2026-09-07', '2026-09-21');
  assert.deepEqual(occs.map(o => o.done), [false, true, false]);
  assert.deepEqual(E.setTaskDone(s2, '2026-09-14', false).doneDates, []);
});

test('movedTimes: drag by days / minutes, resize, all-day', () => {
  const occ = { kind: 'event', allDay: false, start: '2026-09-11T10:00', end: '2026-09-11T11:30' };
  assert.deepEqual(E.movedTimes(occ, 1, 30, false), { start: '2026-09-12T10:30', end: '2026-09-12T12:00' });
  assert.deepEqual(E.movedTimes(occ, 0, -120, true), { start: '2026-09-11T10:00', end: '2026-09-11T10:15' }, 'never shorter than 15 min');
  const allDay = { kind: 'event', allDay: true, start: '2026-09-11', end: '2026-09-12' };
  assert.deepEqual(E.movedTimes(allDay, 3, 0, false), { start: '2026-09-14', end: '2026-09-15' });
});

// ── Reminders & scheduler ───────────────────────────────────────────────────

function state(events, extra) {
  return Object.assign({
    calendars: E.DEFAULT_CALENDARS.map(c => Object.assign({}, c)),
    settings: E.mergeSettings({}),
    events
  }, extra || {});
}

test('reminder instances: timed, all-day at 09:00, silent calendars, done tasks', () => {
  const s = state([
    { id: 'a', calendarId: 'personal', title: 'Timed', start: '2026-09-12T10:00', end: '2026-09-12T11:00', reminders: [15, 60] },
    { id: 'b', calendarId: 'personal', title: 'All day', allDay: true, start: '2026-09-12', end: '2026-09-12', reminders: [0, 1440] },
    { id: 'c', calendarId: 'work', title: 'Muted', start: '2026-09-12T10:00', end: '2026-09-12T11:00', reminders: [15] },
    { id: 'd', calendarId: 'personal', kind: 'task', title: 'Done', done: true, start: '2026-09-12T10:00', end: '2026-09-12T10:00', reminders: [15] }
  ]);
  s.calendars.find(c => c.id === 'work').notify = false;
  const inst = E.collectReminderInstances(s, at(2026, 9, 11), at(2026, 9, 13));
  const got = inst.map(i => i.occ.eventId + '@' + new Date(i.fireAt).toTimeString().slice(0, 5) + '/' + i.offset).sort();
  assert.deepEqual(got, ['a@09:00/60', 'a@09:45/15', 'b@09:00/0', 'b@09:00/1440'].sort());
  const b1440 = inst.find(i => i.occ.eventId === 'b' && i.offset === 1440);
  assert.equal(b1440.fireAt, at(2026, 9, 11, 9, 0), '"1 day before" an all-day item = 09:00 the day before');
});

test('calendar default reminders apply when an event has none of its own', () => {
  const s = state([{ id: 'x', calendarId: 'deadlines', title: 'Exam', start: '2026-09-15T09:00', end: '2026-09-15T11:00', reminders: null }]);
  const offsets = E.collectReminderInstances(s, at(2026, 9, 1), at(2026, 9, 30)).map(i => i.offset).sort((a, b) => a - b);
  assert.deepEqual(offsets, [60, 1440]);
});

test('scan fires what came due since the watermark', () => {
  const s = state([{ id: 'a', calendarId: 'personal', title: 'Standup', start: '2026-09-11T14:15', end: '2026-09-11T14:30', reminders: [10] }]);
  const res = E.scan(s, { watermark: at(2026, 9, 11, 14, 0) }, NOW);
  assert.equal(res.fire.length, 1);
  assert.equal(res.fire[0].occ.title, 'Standup');
  assert.equal(res.watermark, NOW);
  // Running again immediately fires nothing — it was handled.
  assert.equal(E.scan(s, { watermark: res.watermark }, NOW + 1000).fire.length, 0);
});

test('an event created with its reminder time already past does not ping', () => {
  const s = state([{ id: 'a', calendarId: 'personal', title: 'Soon', start: '2026-09-11T14:10', end: '2026-09-11T15:00', reminders: [15] }]);
  // Reminder was at 13:55; the watermark (last pass) is 14:04.
  const res = E.scan(s, { watermark: at(2026, 9, 11, 14, 4) }, NOW);
  assert.equal(res.fire.length, 0);
  assert.equal(res.missed.length, 0);
});

test('several due reminders for one occurrence collapse into the latest', () => {
  const s = state([{ id: 'a', calendarId: 'personal', title: 'Exam', start: '2026-09-11T14:10', end: '2026-09-11T16:00', reminders: [10, 60, 1440] }]);
  // Laptop asleep since yesterday: all three came due while away.
  const res = E.scan(s, { watermark: at(2026, 9, 10, 9, 0) }, NOW);
  assert.equal(res.fire.length, 1);
  assert.equal(res.fire[0].offset, 10, 'the closest-to-start reminder wins');
  assert.equal(res.missed.length, 0);
});

test('reminders for things already over are "missed" only if main was away', () => {
  const s = state([{ id: 'a', calendarId: 'personal', title: 'Morning class', start: '2026-09-11T09:00', end: '2026-09-11T10:00', reminders: [10] }]);
  const away = E.scan(s, { watermark: at(2026, 9, 11, 7, 0) }, NOW);
  assert.equal(away.fire.length, 0);
  assert.equal(away.missed.length, 1);
  // A merely-late tick (watermark 1 minute ago) never manufactures a "missed".
  const s2 = state([{ id: 'b', calendarId: 'personal', title: 'Past', start: '2026-09-11T13:40', end: '2026-09-11T13:50', reminders: [26] }]);
  const late = E.scan(s2, { watermark: NOW - 60000 }, NOW);
  assert.equal(late.missed.length, 0);
});

test('snoozes fire once, and vanish with their event', () => {
  const s = state([{ id: 'a', calendarId: 'personal', title: 'Call', start: '2026-09-11T15:00', end: '2026-09-11T15:30', reminders: [] }]);
  const snoozes = [{ eventId: 'a', occKey: '2026-09-11', fireAt: NOW - 1000 }, { eventId: 'gone', occKey: '2026-09-11', fireAt: NOW - 1000 },
    { eventId: 'a', occKey: '2026-09-11', fireAt: NOW + 600000 }];
  const res = E.scan(s, { watermark: NOW - 30000, snoozes }, NOW);
  assert.equal(res.fire.length, 1);
  assert.equal(res.fire[0].type, 'snooze');
  assert.equal(res.snoozes.length, 1, 'only the future snooze remains');
  assert.equal(res.nextAt, NOW + 600000, 'and the scheduler wakes for it');
});

test('the daily digest fires once, inside a 3-hour window', () => {
  const s = state([], { settings: E.sanitizeSettings({ digest: { enabled: true, time: '07:30' } }) });
  const morning = at(2026, 9, 11, 7, 31);
  assert.ok(E.scan(s, { watermark: at(2026, 9, 11, 7, 29) }, morning).digest);
  assert.equal(E.scan(s, { watermark: morning }, morning + 60000).digest, null);
  // Booted at 11:00 — too late to be a morning digest.
  assert.equal(E.scan(s, { watermark: at(2026, 9, 10, 23, 0) }, at(2026, 9, 11, 11, 0)).digest, null);
});

test('nextAt is the next reminder, never later than the wake cap', () => {
  const s = state([{ id: 'a', calendarId: 'personal', title: 'Later', start: '2026-09-11T14:20', end: '2026-09-11T15:00', reminders: [5] }]);
  assert.equal(E.nextWakeAt(s, [], NOW), at(2026, 9, 11, 14, 15));
  assert.equal(E.nextWakeAt(state([]), [], NOW), NOW + E.WAKE_CAP);
});

test('a daily 09:00 series reminds at 08:50 local on both sides of a DST change', () => {
  const s = state([{ id: 'a', calendarId: 'personal', title: 'Daily', start: '2026-10-30T09:00', end: '2026-10-30T09:30', reminders: [10], rrule: { freq: 'daily', interval: 1 } }]);
  const fires = E.collectReminderInstances(s, at(2026, 10, 30), at(2026, 11, 3)).map(i => new Date(i.fireAt));
  assert.equal(fires.length, 4);
  for (const d of fires) assert.equal(d.getHours() * 60 + d.getMinutes(), 8 * 60 + 50);
  assert.equal(fires[2] - fires[1], 25 * 3600000, 'the fall-back day is 25 real hours long');
});

test('quiet hours handle windows that wrap midnight', () => {
  const s = E.sanitizeSettings({ quietHours: { enabled: true, start: '22:00', end: '07:00' } });
  assert.ok(E.inQuietHours(s, at(2026, 9, 11, 23, 0)));
  assert.ok(E.inQuietHours(s, at(2026, 9, 11, 6, 59)));
  assert.ok(!E.inQuietHours(s, at(2026, 9, 11, 7, 0)));
  assert.ok(!E.inQuietHours(E.sanitizeSettings({}), at(2026, 9, 11, 23, 0)), 'off by default');
});

test('describeAlert speaks naturally for events, tasks and all-day items', () => {
  const ev = { kind: 'event', title: 'Math', location: 'Room 204', allDay: false, start: '2026-09-11T14:15', end: '2026-09-11T15:15' };
  const a = E.describeAlert(ev, NOW, { clock24: false });
  assert.equal(a.headline, 'In 10 min');
  assert.equal(a.when, '2:15 – 3:15 PM');
  assert.equal(a.body, 'In 10 min · 2:15 – 3:15 PM · Room 204');
  assert.equal(E.describeAlert(Object.assign({}, ev, { start: '2026-09-11T14:05' }), NOW).headline, 'Starting now');
  assert.equal(E.describeAlert(Object.assign({}, ev, { start: '2026-09-11T14:00' }), NOW).headline, 'Started 5 min ago');
  assert.equal(E.describeAlert({ kind: 'task', title: 'Essay', allDay: true, start: '2026-09-12', end: '2026-09-12' }, NOW).headline, 'Due tomorrow');
  assert.equal(E.describeAlert({ kind: 'task', title: 'Form', allDay: false, start: '2026-09-11T13:50', end: '2026-09-11T13:50' }, NOW).headline, 'Overdue by 15 min');
  assert.equal(E.describeAlert({ kind: 'event', title: 'Trip', allDay: true, start: '2026-09-14', end: '2026-09-14' }, NOW).headline, 'On Monday');
  assert.equal(E.describeAlert(ev, NOW, { clock24: true }).when, '14:15 – 15:15');
});

test('digest and missed summaries', () => {
  const s = state([
    { id: 'a', calendarId: 'school', title: 'Chemistry', start: '2026-09-11T08:30', end: '2026-09-11T09:30' },
    { id: 'b', calendarId: 'school', kind: 'task', title: 'Essay', allDay: true, start: '2026-09-11', end: '2026-09-11' },
    { id: 'c', calendarId: 'school', kind: 'task', title: 'Old worksheet', allDay: true, start: '2026-09-08', end: '2026-09-08' }
  ]);
  const d = E.digestSummary(s, '2026-09-11', at(2026, 9, 11, 7, 30), {});
  assert.equal(d.events, 1);
  assert.equal(d.tasks, 1);
  assert.equal(d.overdue, 1);
  assert.match(d.title, /^Good morning — 1 event, 1 due, 1 overdue$/);
  assert.match(d.body, /First up: 8:30 AM Chemistry/);
  const m = E.missedSummary([{ occ: { title: 'A', allDay: false, start: '2026-09-11T09:00' } }, { occ: { title: 'B', allDay: true, start: '2026-09-11' } }], {});
  assert.equal(m.title, '2 missed reminders');
  assert.match(m.body, /^A \(9 AM\), B/);
});

// ── Layout, links, search ───────────────────────────────────────────────────

test('overlapping blocks share columns; separate clusters stay full width', () => {
  const out = E.layoutDayColumns([
    { id: 1, startMin: 540, endMin: 600 },
    { id: 2, startMin: 570, endMin: 630 },
    { id: 3, startMin: 590, endMin: 620 },
    { id: 4, startMin: 700, endMin: 760 }
  ]);
  const by = Object.fromEntries(out.map(o => [o.id, o]));
  assert.equal(by[1].cols, 3);
  assert.deepEqual([by[1].col, by[2].col, by[3].col].sort(), [0, 1, 2]);
  assert.equal(by[4].cols, 1);
  assert.equal(by[4].col, 0);
});

test('findMeetingLink finds call links and nothing else', () => {
  assert.equal(E.findMeetingLink({ notes: 'Join: https://us02web.zoom.us/j/123?pwd=x.' }), 'https://us02web.zoom.us/j/123?pwd=x');
  assert.equal(E.findMeetingLink({ location: 'https://meet.google.com/abc-defg-hij' }), 'https://meet.google.com/abc-defg-hij');
  assert.equal(E.findMeetingLink({ notes: 'See https://example.com/agenda' }), null);
  assert.equal(E.findMeetingLink({ url: 'javascript:alert(1)' }), null);
  assert.equal(E.findMeetingLink({ notes: 'https://evil.com/zoom.us/j/1' }), null, 'host is checked, not the path');
});

test('searchEvents ranks upcoming title hits first', () => {
  const events = [
    { id: 'a', title: 'Old physics exam', start: '2026-01-10T09:00', end: '2026-01-10T10:00' },
    { id: 'b', title: 'Lab', notes: 'physics practical', start: '2026-09-20T09:00', end: '2026-09-20T10:00' },
    { id: 'c', title: 'Physics', start: '2026-09-07T09:00', end: '2026-09-07T10:00', rrule: { freq: 'weekly', interval: 1 } }
  ];
  const hits = E.searchEvents(events, 'physics', '2026-09-11');
  assert.deepEqual(hits.map(h => h.eventId), ['c', 'b', 'a']);
  assert.equal(hits[0].occKey, '2026-09-14', 'a recurring hit shows its next occurrence');
});

// ── Sanitising ──────────────────────────────────────────────────────────────

test('sanitizeEvent normalises and defends the store', () => {
  const ctx = { calendarIds: ['personal', 'school'], now: NOW };
  assert.equal(E.sanitizeEvent({ start: 'tomorrow' }, ctx).ok, false);
  const r = E.sanitizeEvent({
    title: 'Hi \nthere', calendarId: 'nope', start: '2026-09-11T10:00', end: '2026-09-11T09:00',
    reminders: [15, 15, -5, 999999, 60.4], url: 'javascript:alert(1)',
    rrule: { freq: 'weekly', interval: 500, byDay: [9, 1], until: '2020-01-01', count: 5 }
  }, ctx);
  assert.ok(r.ok);
  const ev = r.event;
  assert.equal(ev.title, 'Hi there');
  assert.equal(ev.calendarId, 'personal');
  assert.equal(ev.end, '2026-09-11T11:00', 'an end before the start becomes the default duration');
  assert.deepEqual(ev.reminders, [15, 60]);
  assert.equal(ev.url, '');
  assert.deepEqual(ev.rrule, { freq: 'weekly', interval: 99, byDay: [1], wkst: 1, until: null, count: 5 });
  assert.equal(E.sanitizeEvent({ start: '2026-09-11', allDay: true, reminders: null }, ctx).event.reminders, null, 'null = use the calendar default');
  const task = E.sanitizeEvent({ kind: 'task', start: '2026-09-11T10:00', end: '2026-09-12T10:00' }, ctx).event;
  assert.equal(task.end, task.start, 'a task has one moment: its due time');
  const bad = E.sanitizeEvent({ start: '2026-09-07T10:00', rrule: { freq: 'weekly' },
    overrides: { 'not-a-date': { start: 'x' }, '2026-09-14': { start: '2026-09-15T10:00', title: 'Moved' } } }, ctx).event;
  assert.deepEqual(Object.keys(bad.overrides), ['2026-09-14']);
});

test('sanitizeSettings merges over defaults and rejects junk', () => {
  const s = E.sanitizeSettings({ weekStart: 3, defaultView: 'decade', clock24: 'yes', digest: { enabled: true, time: '25:00' } });
  assert.equal(s.weekStart, 1);
  assert.equal(s.defaultView, 'month');
  assert.equal(s.clock24, false);
  assert.equal(s.digest.enabled, true);
  assert.equal(s.digest.time, '07:30');
  assert.equal(E.sanitizeSettings({ weekStart: 0 }).weekStart, 0);
});

// ── Quick add ───────────────────────────────────────────────────────────────

const Q = (text, opts) => E.parseQuickAdd(text, Object.assign({ now: NOW }, opts || {}));

test('quick add: the everyday student and work phrasings', () => {
  const cases = [
    ['Math test fri 10am @room204 !', { title: 'Math test', start: '2026-09-18T10:00', end: '2026-09-18T11:00', important: true, location: 'room204' }],
    ['Dentist tomorrow at 3', { title: 'Dentist', start: '2026-09-12T15:00' }],
    ['Lunch with Sam at noon', { title: 'Lunch with Sam', start: '2026-09-12T12:00' }],
    ['Meeting 3-4pm', { title: 'Meeting', start: '2026-09-11T15:00', end: '2026-09-11T16:00' }],
    ['Chem lab 11-1pm on sep 25', { title: 'Chem lab', start: '2026-09-25T11:00', end: '2026-09-25T13:00' }],
    ['SAT prep tuesday 4pm', { title: 'SAT prep', start: '2026-09-15T16:00' }],
    ['Movie friday 11pm-1am', { title: 'Movie', start: '2026-09-11T23:00', end: '2026-09-12T01:00' }],
    ['Team sync 2026-09-30 14:00 for 30 min', { title: 'Team sync', start: '2026-09-30T14:00', end: '2026-09-30T14:30' }],
    ['Party tonight', { title: 'Party', start: '2026-09-11T20:00' }],
    ['Project review the 15th', { title: 'Project review', start: '2026-09-15', allDay: true }],
    ['Trip the day after tomorrow', { title: 'Trip', start: '2026-09-13' }],
    ['Interview in 2 weeks at 10:30', { title: 'Interview', start: '2026-09-25T10:30' }],
    ['Breakfast tomorrow morning', { title: 'Breakfast', start: '2026-09-12T09:00' }],
    ['Run at 07:30 tomorrow', { title: 'Run', start: '2026-09-12T07:30' }],
    ['Call at 5', { title: 'Call', start: '2026-09-11T17:00' }],
    ['Gym at 7 tomorrow', { title: 'Gym', start: '2026-09-12T07:00' }],
    ['Rent due end of month', { title: 'Rent', start: '2026-09-30', kind: 'task' }],
    ['BBQ this weekend', { title: 'BBQ', start: '2026-09-12' }],
    ['Hike next weekend', { title: 'Hike', start: '2026-09-19' }]
  ];
  for (const [text, want] of cases) {
    const got = Q(text);
    for (const [k, v] of Object.entries(want)) assert.equal(got[k], v, `${JSON.stringify(text)} → ${k}`);
  }
});

test('quick add: "next friday" means next week\'s Friday; bare "friday" the coming one', () => {
  const monday = at(2026, 9, 7, 9, 0);
  assert.equal(E.parseQuickAdd('Party friday', { now: monday }).start, '2026-09-11');
  assert.equal(E.parseQuickAdd('Party next friday', { now: monday }).start, '2026-09-18');
  assert.equal(E.parseQuickAdd('Party next monday', { now: monday }).start, '2026-09-14');
});

test('quick add: numeric dates follow the locale order', () => {
  assert.equal(Q('Exam 9/25 9:00').start, '2026-09-25T09:00');
  assert.equal(Q('Exam 25/9 9:00', { dateOrder: 'dmy' }).start, '2026-09-25T09:00');
  assert.equal(Q('Exam 3/2').start, '2027-03-02', 'a date already past this year rolls to next year');
});

test('quick add: tasks, tags and calendars', () => {
  const essay = Q('History essay due next thursday');
  assert.equal(essay.kind, 'task');
  assert.equal(essay.title, 'History essay');
  assert.equal(essay.start, '2026-09-17');
  assert.ok(essay.tags.includes('school'));
  assert.equal(Q('todo: buy printer ink').title, 'buy printer ink');
  assert.equal(Q('todo: buy printer ink').kind, 'task');
  assert.equal(Q('Standup 9am #work').calendarName, 'work');
  assert.ok(Q('Physics exam monday').tags.includes('exam'));
  assert.ok(!Q('Shift every sat 9am').tags.includes('exam'), '"sat" in lower case is Saturday, not the SAT');
  assert.ok(Q('SAT on saturday').tags.includes('exam'));
  assert.equal(Q('Study @"Room 204" tomorrow').location, 'Room 204');
});

test('quick add: recurrence', () => {
  const standup = Q('Standup every weekday 9:30-9:45');
  assert.deepEqual(standup.rrule, { freq: 'weekly', interval: 1, byDay: [1, 2, 3, 4, 5] });
  assert.equal(standup.start, '2026-09-14T09:30', 'first weekday whose 9:30 is still ahead');
  const gym = Q('Gym mondays and thursdays 6pm for 1h');
  assert.deepEqual(gym.rrule.byDay, [1, 4]);
  assert.equal(gym.end, '2026-09-14T19:00');
  const shift = Q('Shift every sat 9am-5pm until dec 20');
  assert.deepEqual(shift.rrule, { freq: 'weekly', interval: 1, byDay: [6], until: '2026-12-20' });
  assert.equal(shift.title, 'Shift');
  const piano = Q('Piano every other wednesday 5pm for 10 weeks');
  assert.equal(piano.rrule.interval, 2);
  assert.equal(piano.rrule.until, '2026-11-24');
  assert.equal(Q('Pills daily at 8am').rrule.freq, 'daily');
  assert.equal(Q('Pills daily at 8am').start, '2026-09-12T08:00', 'today\'s 8am has passed');
  assert.equal(Q('Review biweekly').rrule.interval, 2);
  assert.equal(Q('Mom birthday oct 3 every year').rrule.freq, 'yearly');
  assert.equal(Q('Tutoring every tuesday for 6 lessons').rrule.count, 6);
  assert.equal(Q('Rent every month').rrule.freq, 'monthly');
});

test('quick add: reminders', () => {
  assert.deepEqual(Q('Call dentist tomorrow 2pm remind me 30 min before').reminders, [30]);
  assert.deepEqual(Q('Exam oct 2 remind me 2 days before').reminders, [2880]);
  assert.deepEqual(Q('Exam oct 2 remind me the day before').reminders, [1440]);
  assert.deepEqual(Q('Nap at 3pm no reminder').reminders, []);
  assert.equal(Q('Nap at 3pm').reminders, undefined, 'unspecified = calendar default');
});

test('quick add: text with no date stays undated and keeps its title intact', () => {
  const r = Q('Read chapter 4');
  assert.equal(r.hasDate, false);
  assert.equal(r.title, 'Read chapter 4');
  assert.equal(Q('Room 5a cleanup').title, 'Room 5a cleanup', 'a bare "5a" is not a time');
  assert.equal(Q('Version 1-2 notes').hasTime, false, 'a bare "1-2" is not a time range');
});

test('quick add: spans cover exactly the consumed text', () => {
  const text = 'Dentist tomorrow at 3pm @clinic';
  const r = Q(text);
  const types = r.spans.map(s => s.type).sort();
  assert.deepEqual(types, ['date', 'location', 'time']);
  for (const s of r.spans) assert.equal(text.slice(s.start, s.end), s.text);
  for (const s of r.spans) assert.ok(!r.title.includes(s.text.trim()), `title must not contain "${s.text}"`);
});

// ── Regressions ─────────────────────────────────────────────────────────────

// The bug: RegExp.test() coerces, so ID_RE.test(null) was true ("null" matches
// the pattern) and an event saved with id:null KEPT null as its id. Nothing
// could find it again — deleting or editing it silently did nothing.
test('an id that is not a usable string is replaced, never kept', () => {
  const ctx = { calendarIds: ['personal'], now: NOW };
  const ok = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id) && id !== 'null' && id !== 'undefined';
  for (const bad of [null, undefined, 42, {}, [], '', 'has space', 'x'.repeat(65)]) {
    const ev = E.sanitizeEvent({ id: bad, start: '2026-09-11T10:00' }, ctx).event;
    assert.ok(ok(ev.id), 'usable id for input ' + JSON.stringify(bad) + ', got ' + JSON.stringify(ev.id));
  }
  const a = E.sanitizeEvent({ start: '2026-09-11T10:00' }, ctx).event;
  const b = E.sanitizeEvent({ start: '2026-09-11T10:00' }, ctx).event;
  assert.notEqual(a.id, b.id, 'two id-less events must not collide');
  assert.equal(E.sanitizeEvent({ id: 'keep-me', start: '2026-09-11T10:00' }, ctx).event.id, 'keep-me');
  // Calendars had the same hole: a new one came back with id undefined.
  const c1 = E.sanitizeCalendar({ name: 'New' }, null);
  const c2 = E.sanitizeCalendar({ name: 'Other' }, null);
  assert.ok(ok(c1.id), 'new calendar gets an id, got ' + JSON.stringify(c1.id));
  assert.notEqual(c1.id, c2.id);
  assert.equal(E.sanitizeCalendar({ name: 'x' }, { id: 'school' }).id, 'school', 'an existing id is kept');
});

test('quick add reads dotted dates and two-digit years', () => {
  const dmy = { dateOrder: 'dmy' };
  assert.equal(Q('Math test 22.4.27', dmy).start, '2027-04-22');
  assert.equal(Q('Math test 22.4.27', dmy).title, 'Math test');
  assert.equal(Q('Review 22.4.2027', dmy).start, '2027-04-22');
  assert.equal(Q('Math test 23/6/27', dmy).start, '2027-06-23');
  assert.equal(Q('Trip 4.22.27', { dateOrder: 'mdy' }).start, '2027-04-22', 'US order reads month first');
  assert.equal(Q('Exam due 22.4', dmy).start, '2027-04-22', 'a word like "due" marks a year-less dotted date');
  assert.equal(Q('Exam due 22.4', dmy).title, 'Exam');
  // A bare decimal in a title is NOT a date.
  assert.equal(Q('chapter 2.5 notes', dmy).hasDate, false);
  assert.equal(Q('chapter 2.5 notes', dmy).title, 'chapter 2.5 notes');
  // And the forms that also use dots still win where they should.
  assert.equal(Q('Lunch 12.30pm tomorrow', dmy).start, '2026-09-12T12:30');
  assert.equal(Q('Essay for 1.5 hours', dmy).hasDate, false);
  assert.equal(Q('Meeting 3-4pm', dmy).start, '2026-09-11T15:00');
});

// ── School terms, the right-click action, the year view ─────────────────────

test('school terms: sanitising, which term a day is in, and which week of it', () => {
  const terms = E.sanitizeSettings({ terms: [
    { name: 'Term 4', start: '2026-10-12', end: '2026-12-18' },
    { name: 'Term 3', start: '2026-07-20', end: '2026-09-25' },
    { name: 'backwards', start: '2026-05-05', end: '2026-04-04' },
    { name: 'junk', start: 'whenever', end: '2026-04-04' }
  ] }).terms;
  assert.equal(terms.length, 2, 'impossible terms are dropped');
  assert.deepEqual(terms.map(t => t.name), ['Term 3', 'Term 4'], 'kept in date order');
  assert.ok(terms.every(t => /^[A-Za-z0-9_-]{1,64}$/.test(t.id)), 'each gets a usable id');

  assert.equal(E.currentTerm(terms, '2026-09-13').name, 'Term 3');
  assert.equal(E.currentTerm(terms, '2026-10-01'), null, 'the holidays are not a term');
  assert.equal(E.nextTerm(terms, '2026-10-01').name, 'Term 4');

  const t3 = terms[0];
  assert.equal(E.termWeek(t3, t3.start, 1), 1, 'the first day is week 1');
  assert.equal(E.termWeek(t3, E.addDays(t3.start, 7), 1), 2, 'seven days on is week 2');
  assert.equal(E.termWeek(t3, '2026-09-13', 1), 8);
  assert.equal(E.termWeek(t3, '2026-10-01', 1), 0, 'outside the term there is no week');

  const label = E.termLabel(terms, '2026-09-13', 1);
  assert.equal(label.name, 'Term 3');
  assert.equal(label.week, 8);
  assert.equal(E.termLabel(terms, '2026-10-05', 1), null, 'nothing to show in the holidays');
});

test('the right-click action is off unless it is chosen', () => {
  assert.equal(E.mergeSettings({}).rightClick, 'none', 'destructive by default would be wrong');
  assert.equal(E.sanitizeSettings({ rightClick: 'delete' }).rightClick, 'delete');
  assert.equal(E.sanitizeSettings({ rightClick: 'done' }).rightClick, 'done');
  assert.equal(E.sanitizeSettings({ rightClick: 'wipe-everything' }).rightClick, 'none', 'junk never arms it');
});

test('quick add understands the end of term', () => {
  const terms = [
    { id: 't3', name: 'Term 3', start: '2026-07-20', end: '2026-09-25' },
    { id: 't4', name: 'Term 4', start: '2026-10-12', end: '2026-12-18' }
  ];
  const opts = { now: NOW, terms };                       // NOW sits inside Term 3
  assert.equal(E.parseQuickAdd('Project due end of term', opts).start, '2026-09-25');
  assert.equal(E.parseQuickAdd('Maths every monday until end of term', opts).rrule.until, '2026-09-25');
  // During the holidays it means the term that is coming.
  const holidays = { now: at(2026, 10, 1, 9, 0), terms };
  assert.equal(E.parseQuickAdd('Chemistry every tuesday until the end of term', holidays).rrule.until, '2026-12-18');
  // With no terms set, those words are just words.
  assert.equal(E.parseQuickAdd('Project due end of term', { now: NOW }).hasDate, false);
});

test('year is a real view', () => {
  assert.deepEqual(E.VIEWS, ['month', 'week', 'agenda', 'year']);
  assert.equal(E.sanitizeSettings({ defaultView: 'year' }).defaultView, 'year');
});

test('showing term start and end in the calendar is a setting, off by default', () => {
  assert.equal(E.mergeSettings({}).termMarkers, false);
  assert.equal(E.sanitizeSettings({ termMarkers: true }).termMarkers, true);
  assert.equal(E.sanitizeSettings({ termMarkers: 'yes' }).termMarkers, false, 'junk is not truthy here');
});

test('week numbers can count from the term instead of from January', () => {
  const s = E.sanitizeSettings({ weekNumbersFrom: 'term', weekStart: 1, terms: [
    { name: 'Term 3', start: '2026-07-20', end: '2026-09-25' },
    { name: 'Term 4', start: '2026-10-14', end: '2026-12-18' }
  ] });
  const wk = (row) => E.weekNumberLabel(row, s);
  assert.equal(wk('2026-07-20').text, '1', 'the week a term starts is week 1');
  assert.equal(wk('2026-07-27').text, '2');
  assert.equal(wk('2026-09-07').text, '8');
  assert.equal(wk('2026-07-13').text, '–', 'the week before the term belongs to no term');
  assert.equal(wk('2026-09-28').text, '–', 'nor do the holidays');
  assert.equal(wk('2026-10-12').text, '1', 'a term starting mid-week makes that whole row week 1');
  assert.equal(wk('2026-10-12').term.name, 'Term 4', 'and each term starts counting again');
  assert.equal(wk('2026-10-19').text, '2');
  assert.equal(wk('2026-07-20').inTerm, true);
  assert.equal(wk('2026-07-13').inTerm, false);

  // Unchanged by default: ISO weeks counted from January.
  const iso = E.sanitizeSettings({});
  assert.equal(iso.weekNumbersFrom, 'year');
  assert.equal(E.weekNumberLabel('2026-09-07', iso).text, String(E.isoWeek('2026-09-07')));
  assert.equal(E.sanitizeSettings({ weekNumbersFrom: 'fortnight' }).weekNumbersFrom, 'year', 'junk falls back');
});
