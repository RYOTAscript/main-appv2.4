'use strict';

// iCalendar import/export (main/calendarIcs.js). Pinned to a DST zone so the
// time-zone conversions are asserted against known answers.
process.env.TZ = 'America/New_York';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Ics = require('../main/calendarIcs.js');
const E = require('../renderer/calendar-engine.js');

const wrap = (body) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', body, 'END:VCALENDAR'].join('\r\n');

test('refuses things that are not calendars, or are too big', () => {
  assert.equal(Ics.parseIcs('hello').events.length, 0);
  assert.match(Ics.parseIcs('hello').warnings[0], /iCalendar/);
  const huge = 'BEGIN:VCALENDAR\n' + 'X'.repeat(Ics.MAX_BYTES + 10);
  assert.match(Ics.parseIcs(huge).warnings[0], /8 MB/);
});

test('timed, all-day, UTC and zoned start times land in local wall time', () => {
  const r = Ics.parseIcs(wrap([
    'X-WR-CALNAME:Term 1',
    'X-APPLE-CALENDAR-COLOR:#FF2968',
    'BEGIN:VEVENT', 'UID:1', 'SUMMARY:Floating', 'DTSTART:20260911T100000', 'DTEND:20260911T113000', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:2', 'SUMMARY:Trip', 'DTSTART;VALUE=DATE:20260911', 'DTEND;VALUE=DATE:20260914', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:3', 'SUMMARY:Utc', 'DTSTART:20260911T140000Z', 'DURATION:PT45M', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:4', 'SUMMARY:Berlin', 'DTSTART;TZID=Europe/Berlin:20260911T100000', 'DTEND;TZID=Europe/Berlin:20260911T110000', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:5', 'SUMMARY:Outlook', 'DTSTART;TZID="W. Europe Standard Time":20260911T100000', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:6', 'SUMMARY:Prefixed', 'DTSTART;TZID=/mozilla.org/20050126_1/Europe/London:20260911T100000', 'END:VEVENT'
  ].join('\r\n')));
  assert.equal(r.name, 'Term 1');
  assert.equal(r.color, '#ff2968');
  const by = Object.fromEntries(r.events.map(e => [e.title, e]));
  assert.equal(by.Floating.start, '2026-09-11T10:00');
  assert.equal(by.Floating.end, '2026-09-11T11:30');
  assert.equal(by.Trip.allDay, true);
  assert.equal(by.Trip.end, '2026-09-13', 'DTEND of an all-day event is exclusive');
  assert.equal(by.Utc.start, '2026-09-11T10:00', '14:00Z is 10:00 in New York (EDT)');
  assert.equal(by.Utc.end, '2026-09-11T10:45');
  assert.equal(by.Berlin.start, '2026-09-11T04:00', '10:00 CEST is 04:00 EDT');
  assert.equal(by.Outlook.start, '2026-09-11T04:00', 'Windows zone names are mapped');
  assert.equal(by.Prefixed.start, '2026-09-11T05:00', 'vendor-prefixed TZIDs are understood');
});

test('zone conversion is right on both sides of a European DST change', () => {
  // Berlin leaves summer time on 2026-10-25; New York on 2026-11-01.
  assert.equal(Ics.parseIcsDate('20261024T120000', { TZID: 'Europe/Berlin' }).local, '2026-10-24T06:00');
  assert.equal(Ics.parseIcsDate('20261026T120000', { TZID: 'Europe/Berlin' }).local, '2026-10-26T07:00');
  assert.equal(Ics.parseIcsDate('20261102T120000', { TZID: 'Europe/Berlin' }).local, '2026-11-02T06:00');
});

test('repeat rules, exceptions, moved and cancelled occurrences', () => {
  const r = Ics.parseIcs(wrap([
    'BEGIN:VEVENT', 'UID:class', 'SUMMARY:Biology', 'DTSTART:20260907T100000', 'DTEND:20260907T110000',
    'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261218T235959Z', 'EXDATE:20260909T100000,20260914T100000', 'EXDATE:20260916T100000', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:class', 'RECURRENCE-ID:20260921T100000', 'SUMMARY:Biology (lab)', 'DTSTART:20260921T130000', 'DTEND:20260921T150000', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:class', 'RECURRENCE-ID:20260923T100000', 'STATUS:CANCELLED', 'DTSTART:20260923T100000', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:club', 'SUMMARY:Club', 'DTSTART:20260908T180000', 'RRULE:FREQ=MONTHLY;BYDAY=2TU;COUNT=6', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:days', 'SUMMARY:Weekdays', 'DTSTART:20260907T083000', 'RRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:hourly', 'SUMMARY:Hourly', 'DTSTART:20260907T083000', 'RRULE:FREQ=HOURLY', 'END:VEVENT'
  ].join('\r\n')));
  const by = Object.fromEntries(r.events.map(e => [e.title, e]));
  const bio = by.Biology;
  assert.deepEqual(bio.rrule.byDay, [1, 3]);
  assert.equal(bio.rrule.until, '2026-12-18');
  assert.deepEqual(bio.exdates.sort(), ['2026-09-09', '2026-09-14', '2026-09-16', '2026-09-23']);
  assert.deepEqual(bio.overrides['2026-09-21'], { start: '2026-09-21T13:00', end: '2026-09-21T15:00', allDay: false, title: 'Biology (lab)' });
  assert.deepEqual(by.Club.rrule, { freq: 'monthly', interval: 1, monthMode: 'nth', nth: 2, until: null, count: 6 });
  assert.deepEqual(by.Weekdays.rrule.byDay, [1, 2, 3, 4, 5]);
  assert.equal(by.Weekdays.rrule.freq, 'weekly');
  assert.equal(by.Hourly.rrule, null);
  assert.ok(r.warnings.some(w => /HOURLY/.test(w)));
});

test('alarms become reminders, measured the widget\'s way', () => {
  const r = Ics.parseIcs(wrap([
    'BEGIN:VEVENT', 'UID:a', 'SUMMARY:Timed', 'DTSTART:20260911T100000',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'END:VALARM',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER;RELATED=START:-P1D', 'END:VALARM',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:PT5M', 'END:VALARM', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:b', 'SUMMARY:AllDay', 'DTSTART;VALUE=DATE:20260911',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15H', 'END:VALARM', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:c', 'SUMMARY:None', 'DTSTART:20260911T100000', 'END:VEVENT'
  ].join('\r\n')), { allDayReminderTime: '09:00' });
  const by = Object.fromEntries(r.events.map(e => [e.title, e]));
  assert.deepEqual(by.Timed.reminders.sort((a, b) => a - b), [15, 1440], 'an alarm AFTER the start is dropped');
  assert.deepEqual(by.AllDay.reminders, [1440], '15h before midnight = 09:00 the day before');
  assert.equal(by.None.reminders, null, 'no alarms = use the calendar default');
});

test('VTODO becomes a task, with its done state', () => {
  const r = Ics.parseIcs(wrap([
    'BEGIN:VTODO', 'UID:t1', 'SUMMARY:Lab report', 'DUE;VALUE=DATE:20260918', 'STATUS:COMPLETED', 'PRIORITY:1', 'END:VTODO',
    'BEGIN:VTODO', 'UID:t2', 'SUMMARY:Reading', 'DUE:20260918T170000', 'END:VTODO'
  ].join('\r\n')));
  const [a, b] = r.events;
  assert.equal(a.kind, 'task');
  assert.equal(a.done, true);
  assert.equal(a.important, true);
  assert.equal(a.start, '2026-09-18');
  assert.equal(b.start, '2026-09-18T17:00');
  assert.equal(b.done, false);
});

test('folded lines and escaped text are decoded', () => {
  const r = Ics.parseIcs(wrap([
    'BEGIN:VEVENT', 'UID:x', 'SUMMARY:Parent\\, teacher\\; night', 'DESCRIPTION:Line one\\nLine two with a very long',
    '  continuation that was folded', 'LOCATION:Hall', 'DTSTART:20260911T180000', 'END:VEVENT'
  ].join('\r\n')));
  const e = r.events[0];
  assert.equal(e.title, 'Parent, teacher; night');
  assert.equal(e.notes, 'Line one\nLine two with a very long continuation that was folded');
});

test('fold never exceeds 75 octets and never splits a character', () => {
  const line = 'SUMMARY:' + '🎉 party with everyone from the club — '.repeat(6);
  const folded = Ics.fold(line);
  for (const part of folded.split('\r\n')) assert.ok(Buffer.byteLength(part, 'utf8') <= 75);
  assert.equal(Ics.unfold(folded)[0], line);
});

test('export → import round-trips the widget\'s own data', () => {
  const ctx = { calendarIds: ['school'], now: Date.now() };
  const events = [
    { id: 'a', calendarId: 'school', title: 'Biology, period 2', location: 'Lab; B', notes: 'Bring\ngoggles', start: '2026-09-07T10:00', end: '2026-09-07T11:00',
      reminders: [10, 1440], important: true,
      rrule: { freq: 'weekly', interval: 1, byDay: [1, 3], until: '2026-12-18' }, exdates: ['2026-09-09'],
      overrides: { '2026-09-14': { start: '2026-09-14T13:00', end: '2026-09-14T14:00', title: 'Biology (moved)' } } },
    { id: 'b', calendarId: 'school', kind: 'task', title: 'Essay', allDay: true, start: '2026-09-18', end: '2026-09-18', reminders: [1440], done: true },
    { id: 'c', calendarId: 'school', title: 'Club', start: '2026-09-08T18:00', end: '2026-09-08T19:00', rrule: { freq: 'monthly', interval: 1, monthMode: 'nth', count: 6 } },
    { id: 'd', calendarId: 'school', title: 'Break', allDay: true, start: '2026-10-19', end: '2026-10-23', reminders: [0] }
  ].map(e => E.sanitizeEvent(e, ctx).event);
  // sanitizeEvent keeps overrides/exdates only on series; restore the test ones.
  events[0].exdates = ['2026-09-09'];
  events[0].overrides = { '2026-09-14': { start: '2026-09-14T13:00', end: '2026-09-14T14:00', allDay: false, title: 'Biology (moved)' } };

  const text = Ics.serializeIcs(events, { name: 'School', calendarsById: { school: { name: 'School' } } });
  assert.ok(text.endsWith('\r\n'));
  const back = Ics.parseIcs(text).events;
  assert.equal(back.length, 4);
  const by = Object.fromEntries(back.map(e => [e.title, e]));
  const bio = by['Biology, period 2'];
  assert.equal(bio.location, 'Lab; B');
  assert.equal(bio.notes, 'Bring\ngoggles');
  assert.equal(bio.start, '2026-09-07T10:00');
  assert.deepEqual(bio.rrule.byDay, [1, 3]);
  assert.equal(bio.rrule.until, '2026-12-18');
  assert.deepEqual(bio.exdates, ['2026-09-09']);
  assert.equal(bio.overrides['2026-09-14'].title, 'Biology (moved)');
  assert.deepEqual(bio.reminders.sort((a, b) => a - b), [10, 1440]);
  assert.equal(bio.important, true);
  assert.equal(by.Essay.kind, 'task');
  assert.equal(by.Essay.done, true);
  assert.deepEqual(by.Essay.reminders, [1440]);
  assert.deepEqual(by.Club.rrule, { freq: 'monthly', interval: 1, monthMode: 'nth', nth: 2, until: null, count: 6 });
  assert.equal(by.Break.end, '2026-10-23');
  assert.deepEqual(by.Break.reminders, [0]);
  // And the re-imported events expand to the same occurrences.
  const a = E.expandEvent(events[0], '2026-09-01', '2026-12-31').map(o => o.start).sort();
  const b = E.expandEvent(E.sanitizeEvent(Object.assign({}, bio, { id: 'z' }), ctx).event, '2026-09-01', '2026-12-31');
  assert.deepEqual(E.expandEvent(Object.assign(E.sanitizeEvent(Object.assign({}, bio, { id: 'z' }), ctx).event,
    { exdates: bio.exdates, overrides: { '2026-09-14': Object.assign({ allDay: false }, bio.overrides['2026-09-14']) } }),
  '2026-09-01', '2026-12-31').map(o => o.start).sort(), a);
  assert.ok(b.length > 0);
});

test('durations format and parse symmetrically', () => {
  for (const m of [0, 15, -15, 60, -900, 540, 1440, -1440, 1500, -10080]) {
    assert.equal(Ics.parseDuration(Ics.fmtDuration(m)), m, String(m));
  }
});
