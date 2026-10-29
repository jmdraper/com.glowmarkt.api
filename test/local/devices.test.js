'use strict';

// Runs the local gas and electricity devices and drivers against a stand-in
// for the Homey runtime. Time is controlled by replacing Date.now.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

require('../helpers/homey-stub');
const { translate } = require('../helpers/locale');
const { gasDevice, electricityDevice } = require('../helpers/fake-device');
const GasDriver = require('../../drivers/glow_local_gas/driver');
const ElectricityDriver = require('../../drivers/glow_local_electricity/driver');
const UnitRegistry = require('../../lib/glow/UnitRegistry');
const { parsePayload } = require('../../lib/glow/parse');
const { validateState } = require('../../lib/glow/validate');
const { STATE, ELECTRICITY, GAS, clone } = require('../glow/examples');

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const START = Date.parse('2026-10-26T12:00:00Z');

let clock = START;
const realNow = Date.now;
test.beforeEach(() => {
  clock = START;
  Date.now = () => clock;
});
test.afterEach(() => {
  Date.now = realNow;
});

// Builds a payload at the current clock, optionally changed by `edit`.
function reading(kind, edit = () => {}) {
  const payload = clone(kind === 'gasmeter' ? GAS : ELECTRICITY);
  payload[kind].timestamp = new Date(clock).toISOString();
  edit(payload[kind]);
  return { reading: parsePayload(kind, JSON.stringify(payload)).reading, receivedAt: clock };
}

function stateEvent(han = {}) {
  const payload = clone(STATE);
  Object.assign(payload.han, han);
  const parsed = parsePayload('STATE', JSON.stringify(payload)).reading;
  return { reading: parsed, accepted: validateState(parsed).accepted };
}

async function deliver(device, kind, edit) {
  await device.onGlowArrival();
  await device.onGlowReading(reading(kind, edit));
}

test('electricity: readings set signed power in W, the totals, and the tariff in pence', async () => {
  const { device, record } = await electricityDevice();
  await deliver(device, 'electricitymeter');
  assert.equal(record.caps.get('measure_power'), -3873);
  assert.equal(record.caps.get('meter_power.imported'), 10326.628);
  assert.equal(record.caps.get('meter_power.exported'), 2004.682);
  assert.equal(record.caps.get('tariff'), 25.63);
  assert.equal(record.caps.get('standing_charge'), 60.7);
  assert.equal(record.settings.meter_id, '••••0123');
  assert.equal(record.settings.unit_id, 'ABC');
});

test('capabilities are written only when they change', async () => {
  const { device, record } = await electricityDevice();
  await deliver(device, 'electricitymeter');
  const writes = record.writes.length;
  clock += 10 * SECOND;
  await deliver(device, 'electricitymeter');
  assert.equal(record.writes.length, writes);
  clock += 10 * SECOND;
  await deliver(device, 'electricitymeter', (m) => { m.power.value = -3.5; });
  assert.deepEqual(record.writes.slice(writes), [['measure_power', -3500]]);
});

test('Tariff changed fires with the new and previous tariff, but not on the first reading', async () => {
  const { device, record } = await electricityDevice();
  await deliver(device, 'electricitymeter');
  assert.deepEqual(record.triggers, []);
  clock += 10 * SECOND;
  await deliver(device, 'electricitymeter', (m) => { m.energy.import.price.unitrate = 0.15; });
  assert.deepEqual(record.triggers, [{ id: 'tariff_changed', tokens: { tariff: 15, previous_tariff: 25.63 } }]);
});

test('electricity: Started and Stopped exporting fire once power has held its side of zero for a minute', async () => {
  const power = (kw) => (payload) => { payload.power.value = kw; };
  const { device, record } = await electricityDevice();
  const cards = (r) => r.triggers.filter(({ id }) => id.endsWith('_exporting'));

  await deliver(device, 'electricitymeter', power(-1.2));
  clock += 50 * SECOND;
  // a kettle within the minute starts the hold again
  await deliver(device, 'electricitymeter', power(0.3));
  clock += 10 * SECOND;
  await deliver(device, 'electricitymeter', power(-1.25));
  clock += 59 * SECOND;
  await deliver(device, 'electricitymeter', power(-1.25));
  assert.deepEqual(cards(record), []);
  assert.equal(device.isExporting(), false);

  clock += SECOND;
  await deliver(device, 'electricitymeter', power(-1.25));
  assert.deepEqual(cards(record), [{ id: 'started_exporting', tokens: { power: -1250 } }]);
  assert.equal(device.isExporting(), true);

  // the held state survives a restart, so it isn't announced again
  const restarted = await electricityDevice({ store: record.store });
  assert.equal(restarted.device.isExporting(), true);
  clock += 10 * SECOND;
  await deliver(restarted.device, 'electricitymeter', power(-1.3));
  await deliver(restarted.device, 'electricitymeter', power(0.24));
  clock += 60 * SECOND;
  await deliver(restarted.device, 'electricitymeter', power(0.241));
  assert.deepEqual(cards(restarted.record), [{ id: 'stopped_exporting', tokens: { power: 241 } }]);
  assert.equal(restarted.device.isExporting(), false);
});

test('rejected fields change nothing and are counted per reason', async () => {
  const { device, record } = await electricityDevice();
  await deliver(device, 'electricitymeter');
  const writes = record.writes.length;
  clock += 10 * SECOND;
  await deliver(device, 'electricitymeter', (m) => {
    m.power.value = -8388.608;
    m.energy.import.cumulative = 1;
    m.energy.import.price.unitrate = null;
  });
  assert.equal(record.writes.length, writes);
  assert.deepEqual(device.getStatusSummary().rejections, { no_reading_value: 1, decreased: 1, not_a_number: 1 });
});

test('each rejection reason is logged at most once an hour', async () => {
  const { device, record } = await electricityDevice();
  await deliver(device, 'electricitymeter');
  const logged = () => record.logs.filter((line) => line.includes('Rejected')).length;
  for (let i = 0; i < 5; i++) {
    clock += 10 * SECOND;
    await deliver(device, 'electricitymeter', (m) => { m.power.value = 45; });
  }
  assert.equal(logged(), 1);
  clock += 61 * MINUTE;
  await deliver(device, 'electricitymeter', (m) => { m.power.value = 45; });
  assert.equal(logged(), 2);
  assert.equal(device.getStatusSummary().rejections.out_of_range, 6);
});

test('gas: volume feeds meter_gas and kWh goes to the gas energy capability, never meter_power', async () => {
  const { device, record } = await gasDevice();
  await deliver(device, 'gasmeter');
  assert.equal(record.caps.get('meter_gas'), 3182.181);
  assert.equal(record.caps.get('gas_energy'), 35706.086);
  assert.equal(record.caps.get('tariff'), 7.92);
  assert.equal(record.caps.get('standing_charge'), 28.84);
  assert.ok(![...record.caps.keys()].some((c) => c.startsWith('meter_power')));
  assert.equal(record.settings.meter_id, 'not available');
});

test('gas without cumulativevol leaves meter_gas alone and warns until volume returns', async () => {
  const { device, record } = await gasDevice();
  await deliver(device, 'gasmeter', (m) => { delete m.energy.import.cumulativevol; });
  assert.equal(record.caps.get('meter_gas'), null);
  assert.equal(record.warnings.at(-1), "Your display isn't reporting gas volume, so this device can't feed Homey Energy.");
  clock += 30 * SECOND;
  await deliver(device, 'gasmeter');
  assert.equal(record.caps.get('meter_gas'), 3182.181);
  assert.equal(record.warnings.at(-1), null);
});

test('the capture\'s 05:30 gas step is applied straight away', async () => {
  const { device, record } = await gasDevice();
  // Flat readings re-stamped every 30 s for half an hour, then the step 33 s later.
  for (let s = 0; s <= 30 * 60; s += 30) {
    clock = START + s * SECOND;
    await deliver(device, 'gasmeter');
  }
  clock += 33 * SECOND;
  await deliver(device, 'gasmeter', (m) => { m.energy.import.cumulativevol = 3182.49; m.energy.import.cumulative = 35709.559; });
  assert.equal(record.caps.get('meter_gas'), 3182.49);
  assert.deepEqual(device.getStatusSummary().rejections, {});
});

test('staleness: 5 minutes without data warns and fires stopped; the next message resumes', async () => {
  const { device, record } = await gasDevice();
  await deliver(device, 'gasmeter');
  clock += 5 * MINUTE;
  await device.everyMinute();
  assert.deepEqual(record.triggers, []);
  assert.equal(device.isReporting(), true);

  clock += MINUTE;
  await device.everyMinute();
  assert.deepEqual(record.triggers, [{ id: 'stopped_reporting', tokens: { minutes: 6 } }]);
  assert.equal(record.warnings.at(-1), 'No data from the display for 6 minutes');
  assert.equal(device.isReporting(), false);

  clock += 2 * MINUTE;
  await device.everyMinute();
  assert.equal(record.warnings.at(-1), 'No data from the display for 8 minutes');
  assert.equal(record.triggers.length, 1);

  clock += 30 * SECOND;
  await deliver(device, 'gasmeter');
  assert.deepEqual(record.triggers[1], { id: 'resumed_reporting', tokens: { minutes: 8 } });
  assert.equal(record.warnings.at(-1), null);
  assert.equal(device.isReporting(), true);
});

test('staleness: any message counts, including a rejected one', async () => {
  const { device } = await electricityDevice();
  for (let i = 0; i < 10; i++) {
    clock += MINUTE;
    await device.onGlowArrival();
    await device.everyMinute();
  }
  assert.equal(device.isReporting(), true);
});

test('staleness: the stale-after setting applies', async () => {
  const { device } = await gasDevice({ settings: { stale_after: 2 } });
  clock += 3 * MINUTE;
  await device.everyMinute();
  assert.equal(device.isReporting(), false);
  await device.onSettings({ newSettings: { stale_after: 10 }, changedKeys: ['stale_after'] });
  assert.equal(device.staleness.staleAfterMinutes, 10);
});

test('staleness: an app restart does not count as silence, unless the meter was already stale', async () => {
  const fresh = await gasDevice({ store: { staleness: { lastArrival: START - 3 * 60 * MINUTE, stale: false } } });
  await fresh.device.everyMinute();
  assert.equal(fresh.device.isReporting(), true);

  const stale = await gasDevice({ store: { staleness: { lastArrival: START - 20 * MINUTE, stale: true } } });
  assert.equal(stale.device.isReporting(), false);
  assert.equal(stale.record.warnings.at(-1), 'No data from the display for 20 minutes');
  await stale.device.onGlowArrival();
  assert.deepEqual(stale.record.triggers, [{ id: 'resumed_reporting', tokens: { minutes: 20 } }]);
});

test('link status: the first status shows at once; a 10 s blip changes nothing', async () => {
  const { device, record } = await electricityDevice();
  await device.onGlowState(stateEvent());
  assert.equal(record.caps.get('display_link'), 'Joined');
  clock += 10 * SECOND;
  await device.onGlowState(stateEvent({ status: 'service discovery' }));
  clock += 10 * SECOND;
  await device.onGlowState(stateEvent());
  clock += 2 * MINUTE;
  await device.everyMinute();
  assert.deepEqual(record.triggers, []);
  assert.equal(record.caps.get('display_link'), 'Joined');
  assert.equal(device.isLinkConnected(), true);
});

test('link status: a status lasting 60 s fires Display link status changed', async () => {
  const { device, record } = await electricityDevice();
  await device.onGlowState(stateEvent());
  for (let s = 10; s <= 70; s += 10) {
    clock = START + s * SECOND;
    await device.onGlowState(stateEvent({ status: 'service discovery' }));
  }
  assert.deepEqual(record.triggers, [{ id: 'link_changed', tokens: { status: 'Service discovery', previous_status: 'Joined' } }]);
  assert.equal(record.caps.get('display_link'), 'Service discovery');
  assert.equal(device.isLinkConnected(), false);
});

test('link status: settles from the minute timer if STATE messages stop', async () => {
  const { device, record } = await electricityDevice();
  await device.onGlowState(stateEvent());
  clock += 10 * SECOND;
  await device.onGlowState(stateEvent({ status: 'service discovery' }));
  clock += 61 * SECOND;
  await device.everyMinute();
  assert.equal(record.triggers[0].id, 'link_changed');
});

test('RSSI and LQI are written at most once a minute, with the latest value; +73 is skipped', async () => {
  const { device, record } = await gasDevice();
  await device.onGlowState(stateEvent({ rssi: -40, lqi: 200 }));
  clock += 10 * SECOND;
  await device.onGlowState(stateEvent({ rssi: -45, lqi: 190 }));
  clock += 10 * SECOND;
  await device.onGlowState(stateEvent({ rssi: -50, lqi: 180 }));
  const signalWrites = () => record.writes.filter(([c]) => c === 'signal_strength' || c === 'link_quality');
  assert.deepEqual(signalWrites(), [['signal_strength', -40], ['link_quality', 200]]);

  clock += 50 * SECOND;
  await device.onGlowState(stateEvent({ rssi: 73 }));
  await device.everyMinute();
  assert.deepEqual(signalWrites().slice(2), [['signal_strength', -50], ['link_quality', 255]]);
});

test('display labels are updated only when they change', async () => {
  const { device, record } = await gasDevice();
  await device.onGlowState(stateEvent());
  assert.equal(record.settings.hardware, 'GLOW-IHD-02-1v4-SMETS2');
  assert.equal(record.settings.software, 'v2.0.2');
  let calls = 0;
  device.setSettings = async () => { calls++; };
  await device.onGlowState(stateEvent());
  assert.equal(calls, 0);
});

test('validation state is saved and restored, so a restart keeps the last good totals', async () => {
  const first = await electricityDevice();
  await deliver(first.device, 'electricitymeter');
  await first.device.everyMinute();
  const { store } = first.record;
  assert.equal(store.validation.lastGood.importKwh.value, 10326.628);

  const restarted = await electricityDevice({ store });
  clock += 10 * SECOND;
  await deliver(restarted.device, 'electricitymeter', (m) => { m.energy.import.cumulative = 10000; });
  assert.deepEqual(restarted.device.getStatusSummary().rejections, { decreased: 1 });
});

test('drivers register their conditions with the device\'s state; electricity adds Is exporting', async () => {
  for (const Driver of [GasDriver, ElectricityDriver]) {
    const driver = new Driver();
    driver.id = Driver === GasDriver ? 'glow_local_gas' : 'glow_local_electricity';
    const listeners = {};
    driver.homey = { flow: { getConditionCard: (id) => ({ registerRunListener: (fn) => { listeners[id] = fn; } }) } };
    await driver.onInit();
    const device = { isReporting: () => false, isLinkConnected: () => true, isExporting: () => true };
    assert.equal(await listeners[`${driver.id}_is_reporting`]({ device }), false);
    assert.equal(await listeners[`${driver.id}_link_connected`]({ device }), true);
    if (Driver === ElectricityDriver) assert.equal(await listeners[`${driver.id}_is_exporting`]({ device }), true);
    else assert.equal(listeners[`${driver.id}_is_exporting`], undefined);
  }
});

function pairingDriver(Driver, registry, pairedUnitIds = []) {
  const driver = new Driver();
  driver.homey = {
    __: translate,
    app: {
      registry,
      getMqttStatus: async () => ({ state: 'running', error: null, address: '192.168.1.20' }),
      getConnectionDetails: (address) => ({
        mode: 'builtin', address, port: 1884, prefix: 'glow', auth: null,
      }),
    },
  };
  driver.getDevices = () => pairedUnitIds.map((unitId) => ({ getData: () => ({ unitId }) }));
  return driver;
}

test('pairing waits until a unit has sent that meter kind', async () => {
  const registry = new UnitRegistry();
  registry.handleMessage('glow/AAA/STATE', JSON.stringify(STATE));
  const state = await pairingDriver(GasDriver, registry).pairingState();
  assert.equal(state.seen, 0);
  assert.deepEqual(state.units, []);
  assert.deepEqual(state.connection, {
    mode: 'builtin', address: '192.168.1.20', port: 1884, prefix: 'glow', auth: null,
  });
});

test('pairing lists units with a masked meter ID and the latest reading, leaving out paired ones', async () => {
  const registry = new UnitRegistry();
  registry.handleMessage('glow/AAA/STATE', JSON.stringify(STATE));
  registry.handleMessage('glow/AAA/SENSOR/electricitymeter', JSON.stringify(ELECTRICITY));
  registry.handleMessage('glow/BBB/SENSOR/electricitymeter', JSON.stringify(ELECTRICITY));

  const state = await pairingDriver(ElectricityDriver, registry, ['BBB']).pairingState();
  assert.equal(state.seen, 2);
  assert.equal(state.units.length, 1);
  const [entry] = state.units;
  assert.deepEqual(entry.device, {
    name: 'Electricity meter (local)',
    data: { unitId: 'AAA', kind: 'electricitymeter' },
    settings: {
      unit_id: 'AAA', meter_id: '••••0123', hardware: 'GLOW-IHD-02-1v4-SMETS2', software: 'v2.0.2',
    },
  });
  assert.equal(entry.description, 'MPAN ••••0123 · -3873 W');
  assert.equal(entry.warning, null);
});

test('pairing still lists a gas unit without volume, with a warning', async () => {
  const registry = new UnitRegistry();
  const gas = clone(GAS);
  delete gas.gasmeter.energy.import.cumulativevol;
  registry.handleMessage('glow/AAA/SENSOR/gasmeter', JSON.stringify(gas));
  const [entry] = (await pairingDriver(GasDriver, registry).pairingState()).units;
  assert.equal(entry.description, 'MPRN not available');
  assert.match(entry.warning, /No gas volume reported/);
});

test('both drivers use the same pairing view', () => {
  const read = (driver) => fs.readFileSync(path.join(__dirname, '..', '..', 'drivers', driver, 'pair', 'select.html'), 'utf8');
  assert.equal(read('glow_local_gas'), read('glow_local_electricity'));
});
