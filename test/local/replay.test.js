'use strict';

// Runs scripts/replay.js's messages through the real registry and local
// devices, routed as the app routes them, with time following the messages.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { gasDevice, electricityDevice } = require('../helpers/fake-device');
const UnitRegistry = require('../../lib/glow/UnitRegistry');
const { CASES, BASELINE, syntheticMessages, fixtureMessages } = require('../../scripts/replay');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'glow-capture.jsonl.gz');
const START = Date.parse('2026-11-01T12:00:00Z');
const UNIT = 'REPLAY000001';

const realNow = Date.now;
let clock = START;
test.beforeEach(() => { Date.now = () => clock; });
test.afterEach(() => { Date.now = realNow; });

// A registry and one device of each kind for the replay unit, wired as app.js
// wires them.
async function setUp() {
  clock = START;
  const registry = new UnitRegistry({ now: () => clock });
  const gas = await gasDevice({ unitId: UNIT });
  const electricity = await electricityDevice({ unitId: UNIT });
  const devices = [gas, electricity];
  const pending = [];
  const route = (unitId, kind, method, event) => {
    for (const { device } of devices) {
      if (unitId !== UNIT || (kind !== 'STATE' && device.kind !== kind)) continue;
      pending.push(device[method](event));
    }
  };
  registry.on('arrival', (e) => route(e.unitId, e.kind, 'onGlowArrival', e));
  registry.on('reading', (e) => route(e.unitId, e.kind, 'onGlowReading', e));
  registry.on('state', (e) => route(e.unitId, 'STATE', 'onGlowState', e));

  async function play(messages) {
    for (const message of messages) {
      clock = START + message.at;
      registry.handleMessage(message.topic, message.payload);
      await Promise.all(pending.splice(0));
    }
  }
  return {
    registry, gas, electricity, play,
  };
}

function rejectionsOf(registry) {
  const unit = registry.getUnit(UNIT);
  const out = {};
  for (const [kind, reasons] of Object.entries(unit.rejections)) {
    for (const [reason, n] of Object.entries(reasons)) out[`${kind} ${reason}`] = n;
  }
  return out;
}

const EXPECTED = {
  'invalid-json': { 'electricitymeter invalid_json': 1 },
  'missing-object': { 'gasmeter missing_object': 1 },
  'epoch-1970': { 'electricitymeter bad_timestamp': 1 },
  nulls: { 'electricitymeter not_a_number': 2 },
  'no-reading': { 'electricitymeter no_reading_value': 2 },
  zero: { 'electricitymeter zero': 1, 'gasmeter zero': 2 },
  'out-of-range': { 'electricitymeter out_of_range': 2 },
  decrease: { 'electricitymeter decreased': 1 },
  'big-rise': { 'electricitymeter implausible_rise': 1 },
  rssi: { 'STATE out_of_range': 1 },
  'han-blip': {},
  'han-outage': {},
  'no-volume': {},
  tariff: {},
};

test('every synthetic case has an expected outcome here', () => {
  assert.deepEqual(Object.keys(EXPECTED).sort(), Object.keys(CASES).sort());
});

for (const name of Object.keys(CASES).filter((n) => !['han-blip', 'han-outage', 'no-volume', 'tariff'].includes(n))) {
  test(`bad case ${name}: the right counter, and no capability changes`, async () => {
    const { registry, gas, electricity, play } = await setUp();
    const messages = syntheticMessages(name, { unitId: UNIT, start: START });
    // The first good round sets the baseline; nothing after it may change a capability.
    await play(messages.slice(0, 3));
    const writesBefore = [gas.record.writes.length, electricity.record.writes.length];
    await play(messages.slice(3));

    assert.deepEqual(rejectionsOf(registry), EXPECTED[name]);
    assert.deepEqual(gas.record.writes.slice(writesBefore[0]), [], 'gas capability writes');
    assert.deepEqual(electricity.record.writes.slice(writesBefore[1]), [], 'electricity capability writes');
    assert.deepEqual([...gas.record.triggers, ...electricity.record.triggers], []);

    // The devices count their own rejections for the status panel.
    const deviceCounts = {
      ...prefix('gasmeter', gas.device.getStatusSummary().rejections),
      ...prefix('electricitymeter', electricity.device.getStatusSummary().rejections),
    };
    const meterExpected = Object.fromEntries(Object.entries(EXPECTED[name])
      .filter(([key]) => !key.startsWith('STATE') && !/invalid_json|missing_object/.test(key)));
    assert.deepEqual(deviceCounts, meterExpected);
  });
}

function prefix(kind, counts) {
  return Object.fromEntries(Object.entries(counts).map(([reason, n]) => [`${kind} ${reason}`, n]));
}

test('han-blip: a 10 s blip fires nothing and the link stays joined', async () => {
  const { gas, electricity, play } = await setUp();
  await play(syntheticMessages('han-blip', { unitId: UNIT, start: START }));
  for (const { device, record } of [gas, electricity]) {
    assert.deepEqual(record.triggers, []);
    assert.equal(record.caps.get('display_link'), 'Joined');
    assert.equal(device.isLinkConnected(), true);
  }
});

test('han-outage: a 110 s outage fires Display link status changed out and back', async () => {
  const { gas, electricity, play } = await setUp();
  await play(syntheticMessages('han-outage', { unitId: UNIT, start: START }));
  for (const { record } of [gas, electricity]) {
    assert.deepEqual(record.triggers, [
      { id: 'link_changed', tokens: { status: 'Service discovery', previous_status: 'Joined' } },
      { id: 'link_changed', tokens: { status: 'Joined', previous_status: 'Service discovery' } },
    ]);
  }
});

test('no-volume: gas warns, leaves meter_gas alone, counts nothing, and recovers on the next good round', async () => {
  const { registry, gas, play } = await setUp();
  const messages = syntheticMessages('no-volume', { unitId: UNIT, start: START });
  await play(messages.slice(0, 4));
  assert.equal(gas.record.caps.get('meter_gas'), BASELINE.gasVolumeM3);
  assert.match(gas.record.warnings.at(-1), /isn't reporting gas volume/);
  await play(messages.slice(4));
  assert.equal(gas.record.warnings.at(-1), null);
  // Only the baseline was ever written.
  assert.deepEqual(gas.record.writes.filter(([c]) => c === 'meter_gas'), [['meter_gas', BASELINE.gasVolumeM3]]);
  // The warning covers a missing volume; it isn't a rejection.
  assert.deepEqual(rejectionsOf(registry), EXPECTED['no-volume']);
  assert.deepEqual(gas.device.getStatusSummary().rejections, {});
});

test('tariff: Tariff changed fires on both devices, and again when the rates go back', async () => {
  const { gas, electricity, play } = await setUp();
  await play(syntheticMessages('tariff', { unitId: UNIT, start: START }));
  assert.deepEqual(electricity.record.triggers, [
    { id: 'tariff_changed', tokens: { tariff: 15, previous_tariff: 25.63 } },
    { id: 'tariff_changed', tokens: { tariff: 25.63, previous_tariff: 15 } },
  ]);
  assert.deepEqual(gas.record.triggers, [
    { id: 'tariff_changed', tokens: { tariff: 6.5, previous_tariff: 7.92 } },
    { id: 'tariff_changed', tokens: { tariff: 7.92, previous_tariff: 6.5 } },
  ]);
});

test('the capture replayed at 60× ends on its last totals, with only the RSSI rejected', async () => {
  const { registry, gas, electricity, play } = await setUp();
  await play(fixtureMessages(FIXTURE, { unitId: UNIT, start: START, speed: 60 }));
  assert.deepEqual(rejectionsOf(registry), { 'STATE out_of_range': 1 });
  assert.equal(gas.record.caps.get('meter_gas'), BASELINE.gasVolumeM3);
  assert.equal(gas.record.caps.get('gas_energy'), BASELINE.gasEnergyKwh);
  assert.equal(electricity.record.caps.get('meter_power.imported'), BASELINE.importKwh);
  assert.equal(electricity.record.caps.get('meter_power.exported'), BASELINE.exportKwh);
  // The meter_gas step happens once: the baseline, then 3182.49.
  assert.deepEqual(gas.record.writes.filter(([c]) => c === 'meter_gas').map(([, v]) => v), [3182.181, 3182.49]);
  // No tariff change, and the 10 s HAN blip (now 0.17 s) fires nothing. At 60×
  // the minute's export hold spans an hour of capture: the evening export
  // starts, its half-hour break at 18:00 is too short to count, and the
  // overnight import stops it.
  assert.deepEqual(gas.record.triggers, []);
  assert.deepEqual(electricity.record.triggers.map(({ id }) => id), ['started_exporting', 'stopped_exporting']);
});

test('then the synthetic cases follow on from the replay without false rejections', async () => {
  const { registry, play } = await setUp();
  const replay = fixtureMessages(FIXTURE, { unitId: UNIT, start: START, speed: 60 });
  await play(replay);
  const after = replay.at(-1).at + 10 * 1000;
  await play(syntheticMessages('tariff', { unitId: UNIT, start: START + after }).map((m) => ({ ...m, at: m.at + after })));
  assert.deepEqual(rejectionsOf(registry), { 'STATE out_of_range': 1 });
});
