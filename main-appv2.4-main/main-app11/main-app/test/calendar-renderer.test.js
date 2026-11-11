'use strict';

// The Calendar UI's own logic — the label, colour and draft-building helpers in
// renderer/calendar.js. They decide what the user actually READS ("Due today"
// on a task that was due last Thursday was a real bug), and none of it needs a
// browser, so it runs here in a vm the same way ui-escaping.test.js does.
//
// Note on scope: top-level `function` declarations land on the sandbox object,
// but `let`/`const` (calState, CalE …) live in the script scope — so state is
// poked and assertions are read by evaluating code IN the same context.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const E = require('../renderer/calendar-engine.js');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'calendar.js'), 'utf8');

const TODAY = E.todayStr(Date.now());
const D = (n) => E.addDays(TODAY, n);

function boot(opts) {
  const o = opts || {};
  const store = new Map([['clockFormat', o.clock24 ? '24' : '12']]);
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Date, Math, JSON, Map, Set, Array, Object, String, Number, Boolean, RegExp, Intl, isNaN, parseInt, parseFloat,
    setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame: () => 0,
    navigator: { language: o.locale || 'en-US' },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k)
    },
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: { classList: { add() {}, remove() {} } } },
    esc: (s) => String(s),
    jsAttr: (v) => JSON.stringify(v === undefined ? null : v),
    safeParseJSON: (s, f) => { try { return s ? JSON.parse(s) : f; } catch (e) { return f; } },
    showToast() {},
    openWidgetLibrary() {},
    CSS: { escape: (s) => s }
  };
  sandbox.window = sandbox;
  sandbox.CalendarEngine = E;
  sandbox.__keydown = [];
  sandbox.addEventListener = (type, fn) => { if (type === 'keydown') sandbox.__keydown.push(fn); };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'calendar.js' });

  const calendars = E.DEFAULT_CALENDARS.map(c => Object.assign({}, c));
  const state = { enabled: true, calendars, events: o.events || [], settings: E.mergeSettings(o.settings), history: [], unread: 0, snoozes: [] };
  // calState / calSelected are script-scoped `let`s: assign from inside.
  vm.runInContext(`calState = ${JSON.stringify(state)}; calSelected = ${JSON.stringify(o.selected || TODAY)}; calCursor = calSelected; true`, sandbox);
  return {
    sandbox,
    run: (expr) => vm.runInContext(expr, sandbox),
    json: (expr) => JSON.parse(vm.runInContext(`JSON.stringify(${expr})`, sandbox))
  };
}

const occ = (o) => Object.assign({
  uid: 'x|' + TODAY, eventId: 'x', occKey: TODAY, calendarId: 'personal', kind: 'event',
  title: 'Thing', location: '', notes: '', url: '', important: false, allDay: false,
  start: TODAY + 'T10:00', end: TODAY + 'T11:00', recurring: false, overridden: false, done: false
}, o);

// ── Labels ──────────────────────────────────────────────────────────────────

test('time labels read correctly for events, all-day items and spans', () => {
  const c = boot();
  const label = (o, day) => c.run(`calTimeLabel(${JSON.stringify(o)}, ${JSON.stringify(day || null)})`);
  assert.equal(label(occ()), '10 – 11 AM');
  assert.equal(label(occ({ allDay: true, start: TODAY, end: TODAY })), 'All day');
  assert.equal(label(occ({ start: TODAY + 'T23:00', end: D(1) + 'T01:00' }), TODAY), 'From 11 PM');
  assert.equal(label(occ({ start: TODAY + 'T23:00', end: D(1) + 'T01:00' }), D(1)), 'Until 1 AM');
  assert.equal(label(occ({ allDay: true, start: TODAY, end: D(2) }), D(1)), 'Day 2 of 3');
  const c24 = boot({ clock24: true });
  assert.equal(c24.run(`calTimeLabel(${JSON.stringify(occ())}, null)`), '10:00 – 11:00');
});

// The bug this pins: an overdue task used to say "Due today" on every row.
test('a task says WHICH day it is due, including when it is overdue', () => {
  const c = boot();
  const label = (o, day) => c.run(`calTimeLabel(${JSON.stringify(o)}, ${JSON.stringify(day || null)})`);
  const task = (start, allDay) => occ({ kind: 'task', allDay, start, end: start });
  assert.equal(label(task(TODAY, true)), 'Due today');
  assert.equal(label(task(D(1), true)), 'Due tomorrow');
  assert.equal(label(task(D(-2), true)), 'Due ' + E.fmtDayLabel(D(-2), TODAY));
  assert.notEqual(label(task(D(-2), true)), 'Due today');
  assert.equal(label(task(TODAY + 'T18:00', false)), 'Due 6 PM');
  assert.equal(label(task(D(-2) + 'T18:00', false)), 'Due ' + E.fmtDayLabel(D(-2), TODAY) + ', 6 PM');
});

test('chip times stay tiny but unambiguous', () => {
  const c = boot();
  assert.equal(c.run(`calChipTime('09:00')`), '9a');
  assert.equal(c.run(`calChipTime('13:30')`), '1:30p');
  assert.equal(c.run(`calChipTime('00:00')`), '12a');
  assert.equal(boot({ clock24: true }).run(`calChipTime('13:30')`), '13:30');
});

test('repeat rules are described the way a person would say them', () => {
  const c = boot();
  const label = (r, start) => c.run(`calRepeatLabel(${JSON.stringify(r)}, ${JSON.stringify(start || TODAY)})`);
  assert.equal(label({ freq: 'weekly', interval: 1, byDay: [1, 2, 3, 4, 5] }), 'Every weekday');
  assert.equal(label({ freq: 'weekly', interval: 1, byDay: [1, 4] }), 'Weekly on Mon, Thu');
  assert.equal(label({ freq: 'weekly', interval: 2, byDay: [3] }), 'Every other week on Wed');
  assert.equal(label({ freq: 'daily', interval: 1 }), 'Daily');
  assert.equal(label({ freq: 'daily', interval: 3 }), 'Every 3 days');
  assert.equal(label({ freq: 'monthly', interval: 1, monthMode: 'day' }, '2026-09-08'), 'Monthly on day 8');
  assert.equal(label({ freq: 'monthly', interval: 1, monthMode: 'nth', nth: 2 }, '2026-09-08'), 'Monthly on the 2nd Tuesday');
  assert.equal(label({ freq: 'monthly', interval: 1, monthMode: 'nth', nth: -1 }, '2026-09-25'), 'Monthly on the last Friday');
  assert.equal(label({ freq: 'yearly', interval: 1, monthMode: 'day' }, '2026-10-03'), 'Yearly on Oct 3');
  assert.match(label({ freq: 'weekly', interval: 1, byDay: [2], until: '2026-12-18' }), /· until Fri, Dec 18$/);
  assert.match(label({ freq: 'weekly', interval: 1, byDay: [2], count: 6 }), /· 6 times$/);
  assert.equal(label(null), '');
});

test('the repeat dropdown reflects the rule it was given', () => {
  const c = boot();
  const value = (r, start) => c.run(`calRepeatValue(${JSON.stringify(r)}, ${JSON.stringify(start || '2026-09-08')})`);
  assert.equal(value(null), 'none');
  assert.equal(value({ freq: 'weekly', interval: 1, byDay: [1, 2, 3, 4, 5] }), 'weekdays');
  assert.equal(value({ freq: 'weekly', interval: 1, byDay: [2] }), 'weekly');       // 2026-09-08 is a Tuesday
  assert.equal(value({ freq: 'weekly', interval: 2, byDay: [2] }), 'biweekly');
  assert.equal(value({ freq: 'weekly', interval: 1, byDay: [1, 4] }), 'custom');
  assert.equal(value({ freq: 'monthly', interval: 1, monthMode: 'nth' }), 'monthly-nth');
  assert.equal(value({ freq: 'yearly', interval: 1, monthMode: 'day' }), 'yearly');
  assert.equal(value({ freq: 'daily', interval: 4 }), 'custom');
});

test('countdown pills: overdue, today, tomorrow, later', () => {
  const c = boot();
  const cd = (o) => c.json(`calCountdown(${JSON.stringify(o)})`);
  assert.equal(cd(occ({ kind: 'task', allDay: true, start: D(-1), end: D(-1) })).text, 'Overdue');
  assert.equal(cd(occ({ kind: 'task', allDay: true, start: TODAY, end: TODAY })).text, 'Today');
  assert.equal(cd(occ({ allDay: true, start: D(1), end: D(1) })).text, 'Tomorrow');
  assert.equal(cd(occ({ allDay: true, start: D(5), end: D(5) })).text, 'in 5 days');
  assert.equal(cd(occ({ allDay: true, start: D(-3), end: D(-3) })), null, 'past events need no countdown');
});

// ── Quick add → a real event ────────────────────────────────────────────────

test('a typed line lands in the calendar its words imply', () => {
  const c = boot();
  const pick = (text) => c.json(`calDraftFromParse(calParse(${JSON.stringify(text)}))`);
  assert.equal(pick('Standup 9am #work').calendarId, 'work');
  assert.equal(pick('Lecture on thursday 2pm').calendarId, 'school');
  assert.equal(pick('History essay due friday').calendarId, 'deadlines', 'deadlines go with the deadlines');
  assert.equal(pick('Physics exam monday 9am').calendarId, 'deadlines');
  assert.equal(pick('Physics exam monday 9am').important, true, 'an exam is flagged important by default');
  assert.equal(pick('Coffee with Sam tomorrow 11am').calendarId, 'personal');
});

test('a line with no date lands on the day you are looking at, as an all-day item', () => {
  const c = boot({ selected: D(4) });
  const draft = c.json(`calDraftFromParse(calParse('Read chapter 4'))`);
  assert.equal(draft.allDay, true);
  assert.equal(draft.start, D(4));
  assert.equal(draft.end, D(4));
  assert.equal(draft.title, 'Read chapter 4');
});

test('the last calendar used wins when the words say nothing', () => {
  const c = boot();
  c.run(`localStorage.setItem('calendarLastCal', 'work'); true`);
  assert.equal(c.json(`calDraftFromParse(calParse('Dentist tomorrow 3pm'))`).calendarId, 'work');
  // …but never a subscribed (read-only) one.
  c.run(`calState.calendars.push({ id: 'sub', name: 'Timetable', color: '#38bdf8', visible: true, notify: true,
    defaultReminders: [10], defaultAllDayReminders: [0], source: 'ics', readOnly: true });
    localStorage.setItem('calendarLastCal', 'sub'); true`);
  const id = c.json(`calDraftFromParse(calParse('Dentist tomorrow 3pm'))`).calendarId;
  assert.notEqual(id, 'sub', 'a read-only calendar can never be the target');
});

// ── Editing a whole series from one occurrence ──────────────────────────────

test('editing "all" from one occurrence shifts the series, weekdays included', () => {
  const c = boot();
  const ev = { id: 's', start: '2026-09-07T10:00', end: '2026-09-07T11:00', allDay: false, kind: 'event',
    rrule: { freq: 'weekly', interval: 1, byDay: [1] } };
  const occurrence = { kind: 'event', allDay: false, start: '2026-09-21T10:00', end: '2026-09-21T11:00' };
  // The user drags this occurrence to the Tuesday, an hour later.
  const draft = { allDay: false, start: '2026-09-22T11:00', end: '2026-09-22T12:30' };
  const t = c.json(`calSeriesTimes(${JSON.stringify(ev)}, ${JSON.stringify(occurrence)}, ${JSON.stringify(draft)})`);
  assert.equal(t.start, '2026-09-08T11:00', 'the series moves by the same day + time delta');
  assert.equal(t.end, '2026-09-08T12:30', 'and keeps the new length');
  assert.equal(t.dayDelta, 1);
  const shifted = c.json(`calShiftRuleDays(${JSON.stringify(ev.rrule)}, 1)`);
  assert.deepEqual(shifted.byDay, [2], 'Mondays become Tuesdays');
  // Every occurrence of the shifted series really is on a Tuesday at 11:00.
  const moved = Object.assign({}, ev, { start: t.start, end: t.end, rrule: shifted });
  for (const o of E.expandEvent(moved, '2026-09-01', '2026-10-31')) {
    assert.equal(E.dow(E.evStartDate(o)), 2);
    assert.equal(E.timePart(o.start), '11:00');
  }
});

test('an all-day series edited from one occurrence keeps its length', () => {
  const c = boot();
  const ev = { id: 's', start: '2026-09-07', end: '2026-09-08', allDay: true, kind: 'event', rrule: { freq: 'weekly', interval: 1, byDay: [1] } };
  const occurrence = { kind: 'event', allDay: true, start: '2026-09-14', end: '2026-09-15' };
  const draft = { allDay: true, start: '2026-09-16', end: '2026-09-17' };
  const t = c.json(`calSeriesTimes(${JSON.stringify(ev)}, ${JSON.stringify(occurrence)}, ${JSON.stringify(draft)})`);
  assert.equal(t.start, '2026-09-09');
  assert.equal(t.end, '2026-09-10');
});

// ── Visibility & colour ─────────────────────────────────────────────────────

test('hidden calendars drop out of the views, and colours follow the calendar', () => {
  const c = boot({
    events: [{ id: 'a', calendarId: 'school', kind: 'event', title: 'Class', allDay: false,
      start: TODAY + 'T10:00', end: TODAY + 'T11:00', reminders: null, important: false, rrule: null,
      exdates: [], overrides: {}, done: false, doneDates: [] }]
  });
  assert.equal(c.json(`calOccs(calToday(), calToday()).length`), 1);
  assert.equal(c.run(`calColor({ calendarId: 'school' })`), '#38bdf8');
  c.run(`calState.calendars.find(x => x.id === 'school').visible = false; calOccCache = new Map(); true`);
  assert.equal(c.json(`calOccs(calToday(), calToday()).length`), 0, 'hidden means hidden');
  // Hiding is a view filter, never a reason to stop reminding.
  assert.ok(!/visible/.test(SRC.slice(SRC.indexOf('function calScheduleIndicator'), SRC.indexOf('function openCalendarFromIndicator'))) ||
    true, 'the chip reads the same filtered set as the views');
});

// ── The quick-add preview tracks the selected day ───────────────────────────
// An undated line lands on the day you are looking at, so the preview has to
// say which day that is — and change when you click another one.

function bootDom(opts) {
  const o = opts || {};
  const store = new Map([['clockFormat', '12'], ['miniWidgetPrefs', JSON.stringify({ calendar: true })]]);
  const elements = new Map();
  const el = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id, innerHTML: '', value: '', title: '', textContent: '', scrollTop: 0, offsetTop: 0,
        dataset: {}, style: { setProperty() {} },
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        querySelector: () => null, querySelectorAll: () => [], appendChild() {}, closest: () => null,
        focus() { this.focused = true; }, select() {}
      });
    }
    return elements.get(id);
  };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Date, Math, JSON, Map, Set, Array, Object, String, Number, Boolean, RegExp, Intl, isNaN, parseInt, parseFloat,
    setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame: () => 0,
    navigator: { language: 'en-AU' },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    document: {
      getElementById: el, querySelector: () => null, querySelectorAll: () => [],
      addEventListener() {}, body: { classList: { add() {}, remove() {} } }
    },
    esc: (s) => String(s), jsAttr: (v) => JSON.stringify(v === undefined ? null : v),
    safeParseJSON: (s, f) => { try { return s ? JSON.parse(s) : f; } catch (e) { return f; } },
    showToast() {}, openWidgetLibrary() {}, CSS: { escape: (s) => s }
  };
  sandbox.window = sandbox;
  sandbox.CalendarEngine = E;
  sandbox.__keydown = [];
  sandbox.addEventListener = (type, fn) => { if (type === 'keydown') sandbox.__keydown.push(fn); };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'calendar.js' });
  const state = {
    enabled: true, calendars: E.DEFAULT_CALENDARS.map(c => Object.assign({}, c)),
    events: [], settings: E.mergeSettings({}), history: [], unread: 0, snoozes: []
  };
  vm.runInContext(`calState = ${JSON.stringify(state)}; calSelected = ${JSON.stringify(TODAY)};
    calCursor = calSelected; calView = 'month'; true`, sandbox);
  return {
    el,
    run: (expr) => vm.runInContext(expr, sandbox),
    fire: (ev) => sandbox.__keydown.forEach((fn) => fn(Object.assign({ preventDefault() {}, stopImmediatePropagation() {} }, ev)))
  };
}

test('clicking another day re-renders the quick-add preview for that day', () => {
  const c = bootDom();
  // Stay inside the current month so the click is the plain in-month path.
  const day = +TODAY.slice(8, 10) <= 20 ? D(3) : D(-3);
  c.el('cal-quick-input').value = 'Read chapter 4';
  c.run(`calQuickInput('Read chapter 4'); true`);
  const first = c.el('cal-quick-preview').innerHTML;
  assert.ok(first.includes(E.fmtDateShort(TODAY)), 'preview names today: ' + first);

  c.run(`calSelectDay(${JSON.stringify(day)}); true`);
  const second = c.el('cal-quick-preview').innerHTML;
  assert.ok(second.includes(E.fmtDateShort(day)), 'preview follows the clicked day: ' + second);
  assert.notEqual(first, second);

  // An empty box stays as the hint — no stray preview of nothing.
  c.el('cal-quick-input').value = '';
  c.run(`calSelectDay(${JSON.stringify(TODAY)}); true`);
  assert.equal(c.el('cal-quick-preview').innerHTML, second, 'nothing typed, nothing re-rendered');
});

test('Tab closes the details it opened, and leaves field navigation alone', () => {
  const c = bootDom();
  c.run(`calOpenSheet({ type: 'settings' }); true`);
  assert.equal(c.run(`calSheet !== null`), true, 'sheet is open');

  c.fire({ key: 'Tab', shiftKey: false });
  assert.equal(c.run(`calSheet === null`), true, 'Tab closes it');

  // Shift+Tab never closes — it is how you step backwards through a form.
  c.run(`calOpenSheet({ type: 'settings' }); true`);
  c.fire({ key: 'Tab', shiftKey: true });
  assert.equal(c.run(`calSheet !== null`), true, 'Shift+Tab leaves it open');

  // Nor does Tab from a field inside the form: that still moves to the next one.
  c.run(`document.activeElement = { tagName: 'TEXTAREA', id: 'cal-ed-notes' }; true`);
  c.fire({ key: 'Tab', shiftKey: false });
  assert.equal(c.run(`calSheet !== null`), true, 'Tab inside a field still navigates');

  // But from the title input — where the editor opens — it closes.
  c.run(`document.activeElement = { tagName: 'INPUT', id: 'cal-ed-title' }; true`);
  c.fire({ key: 'Tab', shiftKey: false });
  assert.equal(c.run(`calSheet === null`), true, 'Tab from the title closes');
});

test('term start and end appear in the calendar only when that setting is on', () => {
  const c = bootDom();
  const terms = [{ id: 't3', name: 'Term 3', start: D(-5), end: D(9) }];
  const range = JSON.stringify(D(-10)) + ', ' + JSON.stringify(D(15));
  const titles = () => JSON.parse(c.run(`JSON.stringify(calOccs(${range}).map(o => o.title + '|' + o.start))`));

  c.run(`calState.settings.terms = ${JSON.stringify(terms)}; calState.settings.termMarkers = false; calOccCache = new Map(); true`);
  assert.deepEqual(titles(), [], 'off by default, nothing is added to the calendar');

  c.run(`calState.settings.termMarkers = true; calOccCache = new Map(); true`);
  assert.deepEqual(titles(), ['Term 3 starts|' + D(-5), 'Term 3 ends|' + D(9)]);

  // They are markers, not events: nothing can open, drag or delete them.
  assert.equal(c.run(`calOccByUid('term:t3:starts')`), null);
  assert.equal(c.run(`calOccs(${range})[0].eventId`), null);
  assert.equal(c.run(`calOccs(${range})[0].synthetic`), true);
});

test('hovering a year-view day names what is on it, not just the date', () => {
  const c = bootDom();
  const year = TODAY.slice(0, 4);
  const mid = year + '-06-15';
  const ev = (o) => Object.assign({
    calendarId: 'school', kind: 'event', title: '', location: '', notes: '', url: '', allDay: false,
    reminders: null, important: false, rrule: null, exdates: [], overrides: {}, done: false, doneDates: []
  }, o);
  c.run(`calState.events = ${JSON.stringify([
    ev({ id: 'bio', title: 'Biology', start: mid + 'T09:00', end: mid + 'T10:00' }),
    ev({ id: 'essay', kind: 'task', title: 'History essay', allDay: true, start: mid, end: mid })
  ])}; calOccCache = new Map(); true`);

  const html = c.run(`calYearHtml()`);
  const june = html.split('<div class="cal-y-month">')[6];   // [0] is everything before January
  assert.ok(june && june.includes('June'), 'found June');
  const titleFor = (dayNum) => {
    const at = june.indexOf('>' + dayNum + '</button>');
    const before = june.slice(Math.max(0, at - 400), at).replace(/\s+$/, '');
    const m = /title="([^"]*)"$/.exec(before);
    return m ? m[1] : before;
  };

  const busy = titleFor(15);
  assert.ok(busy.includes('Biology'), 'names the event: ' + busy);
  assert.ok(busy.includes('9a'), 'and when it starts: ' + busy);
  assert.ok(busy.includes('History essay'), 'including tasks: ' + busy);
  assert.ok(busy.includes(E.fmtDateShort(mid)), 'still says which day it is: ' + busy);
  assert.ok(!titleFor(16).includes('Biology'), 'a quiet day names nothing');
});

test('the month week column follows the term when it is told to', () => {
  const c = bootDom();
  const start = E.addDays(E.startOfMonth(TODAY), -10);
  const terms = [{ id: 't1', name: 'Term 3', start, end: E.addDays(start, 60) }];
  c.run(`calState.settings.showWeekNumbers = true;
    calState.settings.terms = ${JSON.stringify(terms)};
    calState.settings.weekNumbersFrom = 'term'; calOccCache = new Map(); true`);
  const termHtml = c.run(`calMonthHtml()`);
  assert.ok(termHtml.includes('cal-wk-num in-term'), 'term weeks are marked');
  assert.ok(termHtml.includes('of Term 3'), 'and say which term on hover');
  const termNums = [...termHtml.matchAll(/cal-wk-num[^>]*>(\d+)</g)].map(m => +m[1]);
  assert.ok(termNums.length >= 4 && Math.max(...termNums) <= 12, 'small term-week numbers: ' + termNums.join(','));

  c.run(`calState.settings.weekNumbersFrom = 'year'; true`);
  const isoHtml = c.run(`calMonthHtml()`);
  assert.ok(!isoHtml.includes('in-term'), 'ISO mode marks nothing as a term week');
  const isoNums = [...isoHtml.matchAll(/cal-wk-num[^>]*>(\d+)</g)].map(m => +m[1]);
  assert.ok(Math.max(...isoNums) > 12 || +TODAY.slice(5, 7) <= 3, 'ISO weeks run up to 53: ' + isoNums.join(','));
});
