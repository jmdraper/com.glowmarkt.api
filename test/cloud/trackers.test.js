'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ExportingTracker = require('../../lib/ExportingTracker');
const AccountHealth = require('../../lib/cloud/AccountHealth');
const { electricityDayToAnnounce, gasDaysToAnnounce } = require('../../lib/cloud/newDay');

const at = (iso) => Date.parse(iso);
const MINUTE = 60 * 1000;

test('exporting is held for a minute either way, and a blip resets the clock', () => {
  const tracker = new ExportingTracker();
  const t0 = at('2026-10-28T16:00:00Z');
  assert.equal(tracker.power(-200, t0), null);
  assert.equal(tracker.power(50, t0 + 30000), null);
  assert.equal(tracker.power(-200, t0 + 40000), null);
  assert.equal(tracker.power(-210, t0 + 99000), null);
  assert.deepEqual(tracker.power(-220, t0 + 100000), { event: 'started', power: -220 });
  assert.equal(tracker.power(-220, t0 + 200000), null);

  assert.equal(tracker.power(0, t0 + 300000), null);
  assert.deepEqual(tracker.power(10, t0 + 360000), { event: 'stopped', power: 10 });
  assert.equal(tracker.power(Number.NaN, t0 + 400000), null);
});

test('a restart keeps the exporting state, so nothing is announced twice', () => {
  const tracker = new ExportingTracker(JSON.parse(JSON.stringify(new ExportingTracker({ exporting: true }))));
  const t0 = at('2026-10-28T16:00:00Z');
  assert.equal(tracker.power(-300, t0), null);
  assert.equal(tracker.power(-300, t0 + 2 * MINUTE), null);
  assert.equal(tracker.exporting, true);
});

test('logins failing for 30 minutes need attention once, until a request succeeds', () => {
  const health = new AccountHealth();
  const t0 = at('2026-10-28T10:00:00Z');
  assert.equal(health.loginFailed(t0), null);
  assert.equal(health.check(t0 + 29 * MINUTE), null);
  assert.deepEqual(health.check(t0 + 30 * MINUTE), { event: 'attention', reason: 'login_failing' });
  assert.equal(health.loginFailed(t0 + 40 * MINUTE), null);
  assert.equal(health.isOk(), false);

  health.succeeded();
  assert.equal(health.isOk(), true);
  assert.equal(health.check(t0 + 60 * MINUTE), null);
});

test('a login that works again stops the 30-minute clock', () => {
  const health = new AccountHealth();
  const t0 = at('2026-10-28T10:00:00Z');
  health.loginFailed(t0);
  health.loginSucceeded();
  health.loginFailed(t0 + 20 * MINUTE);
  assert.equal(health.check(t0 + 35 * MINUTE), null);
  assert.deepEqual(health.check(t0 + 50 * MINUTE), { event: 'attention', reason: 'login_failing' });
});

test('an entry refused after a fresh login needs attention straight away, once', () => {
  const health = new AccountHealth();
  assert.deepEqual(health.refused(), { event: 'attention', reason: 'not_authorised' });
  assert.equal(health.refused(), null);
  const restored = new AccountHealth(JSON.parse(JSON.stringify(health)));
  assert.equal(restored.isOk(), false);
  assert.equal(restored.refused(), null);
});

test('electricity: a final yesterday is announced once', () => {
  const figures = {
    electricityYesterday: {
      date: '2026-10-27', kWh: 11.196, pounds: 2.87, final: true,
    },
  };
  assert.equal(electricityDayToAnnounce(figures, '2026-10-26'), figures.electricityYesterday);
  assert.equal(electricityDayToAnnounce(figures, null), figures.electricityYesterday);
  assert.equal(electricityDayToAnnounce(figures, '2026-10-27'), null);
  assert.equal(electricityDayToAnnounce({ electricityYesterday: { ...figures.electricityYesterday, final: false } }, '2026-10-26'), null);
  assert.equal(electricityDayToAnnounce({ electricityYesterday: null }, '2026-10-26'), null);
});

test('gas: every day since the last one announced, oldest first, at most a week', () => {
  assert.deepEqual(gasDaysToAnnounce('2026-10-27', '2026-10-26'), ['2026-10-27']);
  assert.deepEqual(gasDaysToAnnounce('2026-10-27', '2026-10-24'), ['2026-10-25', '2026-10-26', '2026-10-27']);
  assert.deepEqual(gasDaysToAnnounce('2026-10-27', '2026-10-27'), []);
  assert.deepEqual(gasDaysToAnnounce(null, '2026-10-27'), []);
  assert.equal(gasDaysToAnnounce('2026-10-27', '2026-09-01').length, 7);
  assert.equal(gasDaysToAnnounce('2026-10-27', '2026-09-01')[0], '2026-10-21');
});
