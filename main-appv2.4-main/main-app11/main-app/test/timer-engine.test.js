'use strict';

// The Timers engine (renderer/timer-engine.js) is the one copy of every rule
// about time — the panel, the floating windows and the main-process scheduler
// all read it. These are the rules that go wrong silently: a repeat that
// drifts, a sleeping laptop that rings ten times on wake, a timer that comes
// back on a monitor that no longer exists.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('../renderer/timer-engine');

const NOON = new Date(2026, 8, 14, 12, 0, 0).getTime();
const S = E.mergeSettings();

function storeWith(timers, settings) {
  const st = E.sanitizeStore({ enabled: true, settings: settings || S }, NOON);
  st.timers = timers;
  return st;
}

test('parseDuration understands the ways people type a time', () => {
  const cases = {
    '10': 600000, '90s': 90000, '1h30': 5400000, '1h 30m': 5400000, '2m30s': 150000,
    '1.5h': 5400000, '10 min': 600000, '5:00': 300000, '1:02:03': 3723000, 'half an hour': 1800000,
  };
  for (const [input, ms] of Object.entries(cases)) {
    assert.equal(E.parseDuration(input, NOON)?.ms, ms, input);
  }
});

test('parseDuration refuses what it cannot be sure about', () => {
  for (const bad of ['abc', '0', '5:99', '30m 1h', '', '1h1h', 'at 25:00', 'at 13pm']) {
    assert.equal(E.parseDuration(bad, NOON), null, bad);
  }
});

test('a clock time counts down to that time, rolling to tomorrow once it has passed', () => {
  const later = E.parseDuration('at 5pm', NOON);
  assert.equal(later.ms, 5 * 3600000);
  assert.equal(later.until, NOON + 5 * 3600000);
  const earlier = E.parseDuration('at 11am', NOON);
  assert.equal(earlier.ms, 23 * 3600000, 'already past today, so tomorrow');
});

test('a running countdown is a wall-clock end instant, so pausing keeps exactly what was left', () => {
  let t = E.createTimer({ durationMs: 60000, start: true }, NOON, S, 0, 0.5);
  assert.equal(t.endAt, NOON + 60000);
  t = E.applyAction(t, 'pause', null, NOON + 20000, S);
  assert.equal(t.status, 'paused');
  assert.equal(t.remainingMs, 40000);
  t = E.applyAction(t, 'resume', null, NOON + 100000, S);
  assert.equal(t.endAt, NOON + 140000, 'resumes from what was left, not from the original end');
});

test('+1 min on a finished timer is a snooze, not a no-op', () => {
  let t = E.createTimer({ durationMs: 60000, start: true }, NOON, S, 0, 0.5);
  const done = E.scan(storeWith([t]), NOON + 60000).store.timers[0];
  assert.equal(done.status, 'done');
  t = E.applyAction(done, 'adjust', 60000, NOON + 61000, S);
  assert.equal(t.status, 'running');
  assert.equal(t.endAt, NOON + 121000);
});

test('a repeating timer schedules each round from the previous END, so it never drifts', () => {
  const t = E.createTimer({ durationMs: 60000, start: true, repeat: 2 }, NOON, S, 0, 0.5);
  // The scan notices the end 700ms late.
  const r = E.scan(storeWith([t]), NOON + 60700);
  assert.equal(r.store.timers[0].endAt, NOON + 120000);
  assert.equal(r.events[0].type, 'repeat');
  assert.equal(r.events[0].round, 2);
  assert.equal(r.events[0].of, 3);
});

test('rounds that passed while asleep are caught up in one event, and marked missed', () => {
  const t = E.createTimer({ durationMs: 60000, start: true, repeat: -1 }, NOON, S, 0, 0.5);
  const r = E.scan(storeWith([t]), NOON + 10 * 60000 + 30000);
  assert.equal(r.events.length, 1, 'one announcement, never a burst');
  assert.equal(r.events[0].count, 10);
  assert.equal(r.events[0].missed, false, 'the latest round ended 30s ago — still on time');
  assert.equal(r.store.timers[0].endAt, NOON + 11 * 60000);

  const late = E.scan(storeWith([E.createTimer({ durationMs: 60000, start: true }, NOON, S, 0, 0.5)]), NOON + 3600000);
  assert.equal(late.events[0].type, 'done');
  assert.equal(late.events[0].missed, true, 'finished long ago: announced quietly, never rung');
});

test('the heads-up fires once, before the end', () => {
  const warn = E.mergeSettings({ warnSeconds: 10 });
  const t = E.createTimer({ durationMs: 60000, start: true }, NOON, warn, 0, 0.5);
  const st = storeWith([t], warn);
  assert.equal(E.nextDue(st, NOON), NOON + 50000, 'the scheduler wakes for the warning');
  const r = E.scan(st, NOON + 50000);
  assert.deepEqual(r.events.map(e => e.type), ['warn']);
  assert.deepEqual(E.scan(r.store, NOON + 51000).events, [], 'and never repeats it');
});

test('a Pomodoro moves focus → break and counts toward the long break', () => {
  const s = E.mergeSettings({ pomodoro: { longEvery: 2, autoBreaks: true, autoFocus: false } });
  let t = E.createTimer({ kind: 'pomodoro', start: true }, NOON, s, 0, 0.5);
  let r = E.scan(storeWith([t], s), NOON + 25 * 60000);
  t = r.store.timers[0];
  assert.equal(t.phase, 'short');
  assert.equal(t.status, 'running', 'breaks start automatically');
  assert.equal(r.store.stats.days[E.dayKey(NOON)].pomodoros, 1);

  r = E.scan(r.store, NOON + 30 * 60000);
  t = r.store.timers[0];
  assert.equal(t.phase, 'focus');
  assert.equal(t.status, 'done', 'focus waits for the user when autoFocus is off');

  t = E.applyAction(t, 'start', null, NOON + 31 * 60000, s);
  r = E.scan(storeWith([t], s), NOON + 56 * 60000);
  assert.equal(r.store.timers[0].phase, 'long', 'the second focus session earns the long break');
});

test('a stopwatch accumulates across pauses and laps are cumulative splits', () => {
  let t = E.createTimer({ kind: 'stopwatch', start: true }, NOON, S, 0, 0.5);
  t = E.applyAction(t, 'lap', null, NOON + 1500, S);
  t = E.applyAction(t, 'pause', null, NOON + 4000, S);
  t = E.applyAction(t, 'resume', null, NOON + 60000, S);
  t = E.applyAction(t, 'lap', null, NOON + 61000, S);
  assert.deepEqual(t.laps, [1500, 5000]);
  const rows = E.lapRows(t.laps);
  assert.equal(rows[1].lap, 3500);
  assert.ok(rows[0].best && rows[1].worst);
});

test('stopwatches never appear in the scheduler', () => {
  const t = E.createTimer({ kind: 'stopwatch', start: true }, NOON, S, 0, 0.5);
  assert.equal(E.nextDue(storeWith([t]), NOON), null);
});

test('a hand-edited or damaged store is repaired, never trusted', () => {
  const st = E.sanitizeStore({
    enabled: 1,
    timers: [
      { id: 'ok1', kind: 'countdown', status: 'running', durationMs: 60000 },   // running with no end
      { id: 'ok1', kind: 'countdown' },                                           // duplicate id
      { id: '../../evil', kind: 'nope', status: 'weird', label: 'x'.repeat(500), color: 'red' },
      null,
    ],
    settings: { volume: 900, sound: 'airhorn', warnSeconds: 7, hotkeyToggle: 'Ctrl+"; rm' },
  }, NOON);
  assert.equal(st.timers.length, 2);
  assert.equal(st.timers[0].status, 'idle');
  assert.match(st.timers[1].id, /^[A-Za-z0-9_-]+$/);
  assert.equal(st.timers[1].kind, 'countdown');
  assert.equal(st.timers[1].label.length, 40);
  assert.match(st.timers[1].color, /^#[0-9a-f]{6}$/);
  assert.equal(st.settings.volume, 100);
  assert.equal(st.settings.sound, 'chime');
  assert.equal(st.settings.warnSeconds, 0);
  assert.equal(st.settings.hotkeyToggle, '');
});

test('formatting: countdowns round up, stopwatches round down', () => {
  assert.equal(E.formatClock(999, 0), '00:01', 'a countdown shows 1 until it truly hits zero');
  assert.equal(E.formatClock(3723400, 2), '1:02:03.40');
  assert.equal(E.formatClock(1999, 1), '00:01.9');
  assert.equal(E.formatHuman(5400000), '1 h 30 min');
  assert.equal(E.formatShort(150000), '2m30s');
});

test('a floating window is always pulled back onto a real display', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  assert.deepEqual(E.clampToArea({ x: 5000, y: -40, width: 196, height: 196 }, area), { x: 1724, y: 0, width: 196, height: 196 });
  const moved = E.mapToArea({ x: 1700, y: 24, width: 196, height: 196 }, area, { x: 1920, y: 0, width: 2560, height: 1400 });
  assert.ok(moved.x > 1920 + 2000, 'top-right of one monitor lands top-right of the other');
  assert.ok(moved.y < 60);
  const corner = E.cornerPosition(area, { width: 196, height: 196 }, 'bottom-left', 16);
  assert.deepEqual(corner, { x: 16, y: 1040 - 196 - 16 });
});

test('stats: today, a 7-day window and a streak that survives the morning', () => {
  const days = {};
  days[E.dayKey(NOON - 86400000)] = { focusMs: 50 * 60000, pomodoros: 2, completed: 0 };
  days[E.dayKey(NOON - 2 * 86400000)] = { focusMs: 0, pomodoros: 0, completed: 3 };
  const sum = E.summarize({ stats: { days } }, NOON);
  assert.equal(sum.week.length, 7);
  assert.equal(sum.today.pomodoros, 0);
  assert.equal(sum.streak, 2, 'nothing yet today still counts yesterday\'s streak');
  assert.equal(sum.totalPomodoros, 2);
});

test('a checkpoint fires once, at the moment its time left is reached', () => {
  let t = E.createTimer({ durationMs: 10 * 60000, checkpoints: [{ leftMs: 5 * 60000, label: 'Flip' }], start: true }, NOON, S, 0, 0.5);
  const st = storeWith([t]);
  assert.equal(E.nextDue(st, NOON), NOON + 5 * 60000, 'the scheduler wakes for it');
  assert.deepEqual(E.scan(st, NOON + 4 * 60000).events, []);
  const r = E.scan(st, NOON + 5 * 60000);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].type, 'checkpoint');
  assert.equal(r.events[0].checkpointLabel, 'Flip');
  assert.equal(E.describeEvent(r.events[0], NOON + 5 * 60000).body, '5 min left');
  assert.equal(r.store.timers[0].checkpoints[0].hit, true);
  assert.deepEqual(E.scan(r.store, NOON + 6 * 60000).events, [], 'and never again');
  assert.equal(E.nextDue(r.store, NOON + 6 * 60000), NOON + 10 * 60000, 'next wake is the end');
});

test('checkpoints passed together are one announcement for the latest', () => {
  const t = E.createTimer({ durationMs: 10 * 60000, checkpoints: [{ leftMs: 8 * 60000 }, { leftMs: 6 * 60000, label: 'Later' }], start: true }, NOON, S, 0, 0.5);
  const r = E.scan(storeWith([t]), NOON + 5 * 60000);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].checkpointLabel, 'Later');
  assert.equal(r.events[0].count, 2);
});

test('a timer ending in the same pass announces the end, not its checkpoints', () => {
  const t = E.createTimer({ durationMs: 60000, checkpoints: [{ leftMs: 30000 }], start: true }, NOON, S, 0, 0.5);
  const r = E.scan(storeWith([t]), NOON + 61000);
  assert.deepEqual(r.events.map(e => e.type), ['done']);
  assert.equal(r.store.timers[0].checkpoints[0].hit, true);
});

test('each repeat round gets its checkpoints back', () => {
  const t = E.createTimer({ durationMs: 60000, repeat: 2, checkpoints: [{ leftMs: 30000 }], start: true }, NOON, S, 0, 0.5);
  let r = E.scan(storeWith([t]), NOON + 30000);
  assert.equal(r.events[0].type, 'checkpoint');
  r = E.scan(r.store, NOON + 60000);
  assert.equal(r.events[0].type, 'repeat');
  assert.equal(r.store.timers[0].checkpoints[0].hit, false, 'reset for round 2');
  r = E.scan(r.store, NOON + 90000);
  assert.equal(r.events[0].type, 'checkpoint', 'and fires again in round 2');
});

test('nudging the time re-decides which checkpoints are still ahead', () => {
  let t = E.createTimer({ durationMs: 10 * 60000, checkpoints: [{ leftMs: 5 * 60000 }], start: true }, NOON, S, 0, 0.5);
  t = E.scan(storeWith([t]), NOON + 6 * 60000).store.timers[0];
  assert.equal(t.checkpoints[0].hit, true);
  t = E.applyAction(t, 'adjust', 3 * 60000, NOON + 6 * 60000, S);
  assert.equal(t.checkpoints[0].hit, false, '7 min left again, so 5 min left is ahead');
  t = E.applyAction(t, 'adjust', -5 * 60000, NOON + 6 * 60000, S);
  assert.equal(t.checkpoints[0].hit, true, 'jumping past it skips it quietly');
});

test('adding a checkpoint the timer is already past marks it passed, not due', () => {
  const t = E.createTimer({ durationMs: 10 * 60000, start: true }, NOON, S, 0, 0.5);
  const withCp = E.setCheckpoints(t, [{ leftMs: 9 * 60000 }, { leftMs: 60000 }], NOON + 3 * 60000);
  assert.deepEqual(withCp.checkpoints.map(c => c.hit), [true, false]);
  assert.deepEqual(E.scan(storeWith([withCp]), NOON + 3 * 60000).events, []);
});

test('checkpoints are sanitised, sorted, de-duplicated and capped', () => {
  const list = [{ leftMs: 1000 }, { leftMs: 500 }, { leftMs: 'x' }, { leftMs: 60000, label: 'a b' }, { leftMs: 60000 }];
  for (let i = 0; i < 20; i++) list.push({ leftMs: 120000 + i * 1000 });
  const cps = E.sanitizeCheckpoints(list);
  assert.equal(cps.length, E.MAX_CHECKPOINTS);
  assert.ok(cps.every((c, i) => i === 0 || cps[i - 1].leftMs > c.leftMs), 'earliest first');
  const clean = E.sanitizeCheckpoints([{ leftMs: 60000, label: 'a b' }]);
  assert.equal(clean[0].label, 'a b');
  assert.match(clean[0].id, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(E.sanitizeTimer({ kind: 'stopwatch', checkpoints: [{ leftMs: 5000 }] }, NOON, S).checkpoints, [], 'countdowns only');
});

test('checkpoint marks sit where the draining line is when they fire', () => {
  const t = E.setCheckpoints(E.createTimer({ durationMs: 60000 }, NOON, S, 0, 0.5), [{ leftMs: 15000 }, { leftMs: 90000 }], NOON);
  const marks = E.checkpointMarks(t);
  assert.equal(marks.length, 1, 'one longer than the timer is not drawn');
  assert.equal(marks[0].frac, 0.25);
});
