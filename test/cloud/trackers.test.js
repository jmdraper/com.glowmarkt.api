'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ExportingTracker = require('../../lib/ExportingTracker');
const AccountHealth = require('../../lib/cloud/AccountHealth');
const { dayToAnnounce } = require('../../lib/cloud/newDay');

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

const final27 = {
  electricityYesterday: {
    date: '2026-10-27', kWh: 11.196, pounds: 2.87, final: true,
  },
  gasLatestDay: { date: '2026-10-27', kWh: 0, pounds: 0 },
};

test("a final day is announced once, with its electricity and gas", () => {
  assert.deepEqual(dayToAnnounce(final27, { now: at('2026-10-28T09:00:00Z'), hasGas: true, announced: '2026-10-26' }), {
    date: '2026-10-27',
    tokens: {
      date: 'Tue 27 Oct', electricity_kwh: 11.196, electricity_cost: 2.87, gas_kwh: 0, gas_cost: 0,
    },
  });
  assert.equal(dayToAnnounce(final27, { now: at('2026-10-28T09:15:00Z'), hasGas: true, announced: '2026-10-27' }), null);
});

test('a day not yet final is not announced', () => {
  const figures = { ...final27, electricityYesterday: { ...final27.electricityYesterday, final: false } };
  assert.equal(dayToAnnounce(figures, { now: at('2026-10-28T09:00:00Z'), hasGas: true, announced: '2026-10-26' }), null);
  assert.equal(dayToAnnounce({ electricityYesterday: null, gasLatestDay: null }, { now: at('2026-10-28T09:00:00Z'), hasGas: false }), null);
});

test("the day waits for its gas until 18:00 the next day, then goes with gas as 0", () => {
  const lateGas = { ...final27, gasLatestDay: { date: '2026-10-26', kWh: 28.081, pounds: 2.22 } };
  assert.equal(dayToAnnounce(lateGas, { now: at('2026-10-28T17:59:00Z'), hasGas: true, announced: '2026-10-26' }), null);
  const announced = dayToAnnounce(lateGas, { now: at('2026-10-28T18:00:00Z'), hasGas: true, announced: '2026-10-26' });
  assert.equal(announced.tokens.gas_kwh, 0);
  assert.equal(announced.tokens.electricity_kwh, 11.196);

  // Without gas, nothing to wait for.
  const noGas = { electricityYesterday: final27.electricityYesterday, gasLatestDay: null };
  assert.equal(dayToAnnounce(noGas, { now: at('2026-10-28T09:00:00Z'), hasGas: false, announced: '2026-10-26' }).tokens.gas_kwh, 0);
});
