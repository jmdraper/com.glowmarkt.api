'use strict';

// Runs the cloud driver and device against a fake Glowmarkt API, with node-fetch
// replaced before anything loads it.

const test = require('node:test');
const assert = require('node:assert/strict');

const calls = [];
let routes = {};
async function fakeFetch(url, options = {}) {
  const path = url.replace('https://api.glowmarkt.com/api/v0-1', '');
  calls.push({ path, method: options.method, token: options.headers && options.headers.token });
  const route = routes[`${options.method} ${path}`];
  if (!route) throw new Error(`No fake route for ${options.method} ${path}`);
  const { status = 200, body } = typeof route === 'function' ? route(options) : route;
  return {
    status,
    json: async () => {
      if (body === undefined) throw new SyntaxError('Unexpected end of JSON input');
      return body;
    },
  };
}
require.cache[require.resolve('node-fetch')] = {
  id: 'node-fetch', filename: require.resolve('node-fetch'), loaded: true, exports: fakeFetch,
};

require('../helpers/homey-stub');
const Driver = require('../../drivers/smart-meter/driver');
const Device = require('../../drivers/smart-meter/device');
const GasDriver = require('../../drivers/glow_cloud_gas/driver');
const GasDevice = require('../../drivers/glow_cloud_gas/device');
const { summarise, apiError } = require('../../lib/cloud/glowmarkt');

const DAY = 24 * 60 * 60 * 1000;
const jwt = (expMs) => `h.${Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000) })).toString('base64url')}.s`;
const FRESH_TOKEN = jwt(Date.now() + 7 * DAY);
const USERNAME = 'someone@example.com';

function resetApi(extra = {}) {
  calls.length = 0;
  routes = {
    'POST /auth': { body: { valid: true, token: FRESH_TOKEN } },
    'GET /virtualentity': {
      body: [
        { veId: 've-good-0001', name: 'Smart Meter', postalCode: 'YO10 3DD' },
        { veId: 've-stale-0002', name: 'DCC Sourced', postalCode: 'YO10 3DD' },
        { veId: 've-empty-0003', name: 'Empty entry', postalCode: 'YO10 3DD' },
        { veId: 've-broken-0004', name: 'Broken entry', postalCode: 'YO10 3DD' },
      ],
    },
    'GET /virtualentity/ve-good-0001/resources': {
      body: {
        resources: [
          { resourceId: 'res-gas-0001', classifier: 'gas.consumption', name: 'gas consumption' },
          { resourceId: 'res-good-0001', classifier: 'electricity.consumption', name: 'electricity consumption' },
        ],
      },
    },
    // The stale entry lists its resources normally and only fails on /current.
    'GET /virtualentity/ve-stale-0002/resources': { body: { resources: [{ resourceId: 'res-stale-0002', classifier: 'electricity.consumption', name: 'electricity consumption' }] } },
    'GET /virtualentity/ve-empty-0003/resources': { body: { resources: [] } },
    'GET /virtualentity/ve-broken-0004/resources': { status: 500 },
    'GET /resource/res-good-0001/current': { body: { data: [[1761400000, 512]] } },
    'GET /resource/res-stale-0002/current': { status: 401, body: { error: 'Unauthorized' } },
    ...extra,
  };
}

const triggered = [];
const conditions = {};

function makeDriver(devices = [], DriverClass = Driver) {
  const driver = new DriverClass();
  driver.homey = {
    flow: {
      getDeviceTriggerCard: (id) => ({ trigger: async (device, tokens) => { triggered.push({ id, tokens }); } }),
      getConditionCard: (id) => ({ registerRunListener: (listener) => { conditions[id] = listener; } }),
    },
  };
  driver.log = () => {};
  driver.error = () => {};
  driver.getDevices = () => devices;
  driver.onInit();
  return driver;
}

function makeDevice(driver, {
  token = FRESH_TOKEN, name = 'Smart Meter for YO10 3DD', username = USERNAME, DeviceClass = Device,
} = {}) {
  const device = new DeviceClass();
  const store = { token, elec_cons_res: 'res-good-0001' };
  Object.assign(device, {
    driver,
    homey: { __: (key) => key },
    log: () => {},
    error: () => {},
    getStoreValue: (key) => store[key],
    setStoreValue: async (key, value) => { store[key] = value; },
    getName: () => name,
    getAvailable: () => true,
    getSetting: (key) => ({ username, password: 'pw' })[key],
    getSettings: () => ({ username, password: 'pw' }),
    setUnavailable: async () => {},
    cloudStatus: { lastSuccessAt: null, lastError: null },
  });
  return { device, store };
}

async function pair(driver) {
  const handlers = {};
  await driver.onPair({ setHandler: (name, handler) => { handlers[name] = handler; } });
  assert.equal(await handlers.login({ username: USERNAME, password: 'pw' }), true);
  return handlers.list_devices();
}

test('pairing lists working entries and leaves out failing ones with a reason', async () => {
  resetApi();
  const driver = makeDriver();
  const devices = await pair(driver);

  assert.deepEqual(devices.map((d) => d.store.elec_cons_res), ['res-good-0001']);
  const [account] = driver.getCloudStatus();
  assert.equal(account.number, 1);
  assert.deepEqual(account.skipped.map((s) => [s.name, s.reason]), [
    ['DCC Sourced', { code: 'read_failed', status: 401 }],
    ['Empty entry', { code: 'no_resources' }],
    ['Broken entry', { code: 'resources_failed', status: 500 }],
  ]);
});

test('a network error while checking an entry is a skip, not a pairing failure', async () => {
  resetApi({
    'GET /resource/res-stale-0002/current': () => {
      throw Object.assign(new Error('request to https://api.glowmarkt.com/api/v0-1/resource/res-stale-0002/current failed, reason: getaddrinfo ENOTFOUND'), { type: 'system', code: 'ENOTFOUND' });
    },
  });
  const driver = makeDriver();
  const devices = await pair(driver);
  assert.equal(devices.length, 1);
  const skip = driver.getCloudStatus()[0].skipped.find((s) => s.name === 'DCC Sourced');
  assert.deepEqual(skip.reason, { code: 'error', message: 'Network error (ENOTFOUND)' });
});

test('cloud status groups devices by account without showing identifiers', async () => {
  resetApi();
  const driver = makeDriver();
  await pair(driver);
  const devices = [
    makeDevice(driver).device,
    makeDevice(driver, { name: 'DCC Sourced for YO10 3DD', token: jwt(Date.now() + 3 * DAY) }).device,
    makeDevice(driver, { name: 'Other home', username: 'other@example.com' }).device,
  ];
  driver.getDevices = () => devices;

  const accounts = driver.getCloudStatus();
  assert.equal(accounts.length, 2);
  assert.deepEqual(accounts.map((a) => a.number), [1, 2]);
  assert.deepEqual(accounts[0].devices.map((d) => d.name), ['Smart Meter for ••••', 'DCC Sourced for ••••']);
  assert.equal(accounts[0].skipped.length, 3);
  assert.equal(accounts[1].skipped.length, 0);

  // The account's renewal time is the earliest of its devices'.
  const threeDays = jwt(Date.now() + 3 * DAY);
  const expected = JSON.parse(Buffer.from(threeDays.split('.')[1], 'base64url')).exp * 1000 - DAY;
  assert.equal(accounts[0].tokenRenewsAt, expected);

  const text = JSON.stringify(accounts);
  for (const identifier of ['example.com', 'YO10', '3DD', 've-', 'res-', FRESH_TOKEN]) {
    assert.ok(!text.includes(identifier), `status contains ${identifier}`);
  }
});

test('an entry still refused after a fresh login backs off for an hour with a message', async () => {
  resetApi();
  const driver = makeDriver();
  const { device } = makeDevice(driver);
  let unavailableMessage;
  device.setUnavailable = async (message) => { unavailableMessage = message; };

  const error = await device.request('/resource/res-stale-0002/current').catch((e) => e);
  assert.equal(error.accessRefused, true);
  assert.equal(summarise(error), 'HTTP 401 after a fresh login');
  assert.equal(unavailableMessage, 'cloud.accessRefused');
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
    'GET /resource/res-stale-0002/current', 'POST /auth', 'GET /resource/res-stale-0002/current',
  ]);

  const status = device.getCloudStatus();
  assert.ok(status.accessRefusedUntil > Date.now() + 59 * 60 * 1000);
  assert.equal(device.isAccessRefused(), true);
});

test('concurrent polls that hit an expired token share one login', async () => {
  resetApi({
    'GET /resource/res-good-0001/current': (options) => (options.headers.token === FRESH_TOKEN
      ? { body: { data: [[1, 2]] } } : { status: 401, body: { error: 'expired' } }),
    'GET /resource/res-good-0001/tariff': (options) => (options.headers.token === FRESH_TOKEN
      ? { body: { data: [{ currentRates: { rate: 24.5 } }] } } : { status: 401, body: { error: 'expired' } }),
  });
  const driver = makeDriver();
  const { device, store } = makeDevice(driver, { token: 'old-token' });
  await Promise.all([
    device.request('/resource/res-good-0001/current'),
    device.request('/resource/res-good-0001/tariff'),
  ]);
  assert.equal(calls.filter((c) => c.path === '/auth').length, 1);
  assert.equal(store.token, FRESH_TOKEN);
});

test('a token expiring within a day is renewed before the request', async () => {
  resetApi();
  const driver = makeDriver();
  const { device, store } = makeDevice(driver, { token: jwt(Date.now() + 12 * 60 * 60 * 1000) });
  await device.request('/resource/res-good-0001/current');
  assert.deepEqual(calls.map((c) => c.path), ['/auth', '/resource/res-good-0001/current']);
  assert.equal(calls[1].token, FRESH_TOKEN);
  assert.equal(store.token, FRESH_TOKEN);
});

test('other API errors are summarised without bodies or IDs', async () => {
  resetApi({ 'GET /resource/res-good-0001/meterread': { status: 503, body: { message: 'resource res-good-0001 busy' } } });
  const driver = makeDriver();
  const { device } = makeDevice(driver);
  const error = await device.request('/resource/res-good-0001/meterread').catch((e) => e);
  device.recordError('power', error);
  assert.equal(device.getCloudStatus().lastError.message, 'HTTP 503 from /meterread');
  assert.equal(device.getCloudStatus().lastError.poll, 'power');
  assert.match(error.message, /res-good-0001 busy/);
});

test('summarise strips IDs, URLs and bodies from unexpected errors', () => {
  assert.equal(summarise(apiError('Power API returned no data', '{"id":"abc"}')), 'Power API returned no data');
  assert.equal(summarise(new Error('Cannot read properties of undefined (reading 0)')), 'Cannot read properties of undefined (reading 0)');
  assert.equal(summarise(new Error('Bad thing: {"resourceId":"0123456789abcdef0123"}')), 'Bad thing');
  assert.equal(summarise(new Error('failed for 0123456789abcdef0123')), 'failed for …');
  assert.equal(summarise(new Error('request to https://api.glowmarkt.com/x failed')), 'request to');
  assert.equal(summarise(undefined), 'Unknown error');
});

// Device lifecycle and the new capabilities and cards

const AccountHealth = require('../../lib/cloud/AccountHealth');
const { fakeCloudApi, RECORDED_AT, ENTRIES, ID } = require('../helpers/fake-cloud-api');

const settle = () => new Promise((resolve) => { setTimeout(resolve, 10); });
const realNow = Date.now;
let now = realNow();
test.beforeEach(() => {
  now = RECORDED_AT;
  Date.now = () => now;
});
test.afterEach(() => { Date.now = realNow; });

/**
 * A cloud device with Homey's timers, settings and capabilities stood in for.
 * With `api`, its requests go to that fake API instead of node-fetch.
 */
function startDevice({
  pollFrequency, settings: extraSettings = {}, store: storeValues = {}, api, capabilities = {}, gas = false,
} = {}) {
  resetApi();
  triggered.length = 0;
  const driver = makeDriver([], gas ? GasDriver : Driver);
  const { device, store } = makeDevice(driver, { DeviceClass: gas ? GasDevice : Device });
  Object.assign(store, storeValues);
  const active = new Map();
  const timeouts = new Map();
  let nextId = 1;
  Object.assign(device.homey, {
    setInterval: (fn, ms) => { active.set(nextId, ms); return nextId++; },
    clearInterval: (id) => { active.delete(id); },
    setTimeout: (fn, ms) => { timeouts.set(nextId, { fn, ms }); return nextId++; },
    clearTimeout: (id) => { timeouts.delete(id); },
  });
  const settings = {
    username: USERNAME, password: 'pw', pollFrequency, ...extraSettings,
  };
  // what pairing gives each driver's devices
  const paired = gas
    ? ['gas_day', 'gas_day_energy', 'gas_day_cost', 'tariff', 'standing_charge', 'data_up_to']
    : ['measure_power', 'meter_power.imported', 'tariff'];
  const caps = new Map([...paired.map((c) => [c, null]), ...Object.entries(capabilities)]);
  Object.assign(device, {
    getSettings: () => settings,
    getSetting: (key) => settings[key],
    getData: () => ({ id: ENTRIES[0].veId }),
    hasCapability: (capability) => caps.has(capability),
    addCapability: async (capability) => { caps.set(capability, null); },
    removeCapability: async (capability) => { caps.delete(capability); },
    setCapabilityOptions: async () => {},
    getCapabilityValue: (capability) => caps.get(capability) ?? null,
    setCapabilityValue: async (capability, value) => { caps.set(capability, value); },
    setAvailable: async () => {},
  });
  if (api) device.request = api.request;
  let inits = 0;
  const onInit = device.onInit.bind(device);
  device.onInit = async () => {
    inits++;
    return onInit();
  };
  return {
    device, store, active, timeouts, caps, settings, inits: () => inits,
  };
}

const READINGS_MS = 15 * 60 * 1000;

test('changing the poll frequency restarts polling without running setup again', async () => {
  const { device, active, inits } = startDevice({ pollFrequency: 10 });
  await device.onInit();
  assert.deepEqual([...active.values()], [10000, READINGS_MS, 60000]);
  const before = [...active.keys()];

  await device.onSettings({ oldSettings: {}, newSettings: { pollFrequency: 30 }, changedKeys: ['pollFrequency'] });
  assert.equal(inits(), 1);
  assert.deepEqual([...active.values()], [30000, READINGS_MS, 60000]);
  assert.ok(before.every((id) => !active.has(id)), 'old timers still running');
});

test('new login details restart polling with the new token', async () => {
  const { device, store, active } = startDevice();
  await device.onInit();
  store.token = 'old-token';
  await device.onSettings({ oldSettings: {}, newSettings: { username: USERNAME, password: 'new' }, changedKeys: ['password'] });
  assert.equal(store.token, FRESH_TOKEN);
  assert.equal(active.size, 3);
});

test('settings polling does not depend on leave it running', async () => {
  const { device, active } = startDevice();
  await device.onInit();
  const before = [...active.keys()];
  await device.onSettings({ oldSettings: {}, newSettings: { stale_after: 10 }, changedKeys: ['stale_after'] });
  assert.deepEqual([...active.keys()], before);
});

test('every timer stops when the app stops or the device is deleted', async () => {
  const stopped = startDevice({ api: fakeCloudApi() });
  await stopped.device.onInit();
  await settle();
  assert.equal(stopped.timeouts.size, 1, 'the next tariff fetch is scheduled');
  await stopped.device.onUninit();
  assert.equal(stopped.active.size, 0);
  assert.equal(stopped.timeouts.size, 0);

  const deleted = startDevice();
  await deleted.device.onInit();
  await deleted.device.onDeleted();
  assert.equal(deleted.active.size, 0);
});

test('the next tariff fetch is 30 s after the next half hour', async () => {
  const { device, timeouts } = startDevice({ api: fakeCloudApi() });
  await device.onInit();
  await settle();
  // 13:40:33 → 14:00:30
  assert.deepEqual([...timeouts.values()].map(({ ms }) => ms), [Date.parse('2026-10-28T14:00:30Z') - RECORDED_AT]);
});

test('an existing device gains the new capabilities, and a test install loses the gas ones', async () => {
  const { device, caps, store } = startDevice({
    api: fakeCloudApi(),
    store: { elec_cons_res: ID['gas.consumption|gas consumption'] },
    capabilities: { gas_day: 'Tue 27 Oct', 'tariff.gas': 7.92 },
  });
  await device.onInit();
  for (const capability of ['standing_charge', 'electricity_today', 'electricity_yesterday', 'electricity_cost_yesterday', 'data_up_to']) {
    assert.ok(caps.has(capability), capability);
  }
  assert.ok(!caps.has('gas_day') && !caps.has('tariff.gas'));
  await settle();
  // A device paired by name onto the gas resource moves to electricity consumption.
  assert.equal(store.elec_cons_res, ID['electricity.consumption|electricity consumption']);
});

test('yesterday and data up to come from the readings poll, which reads no gas', async () => {
  const api = fakeCloudApi();
  const { device, caps } = startDevice({ api });
  await device.onInit();
  await settle();
  assert.equal(caps.get('electricity_yesterday'), 11.196);
  assert.equal(caps.get('electricity_cost_yesterday'), 2.87);
  assert.equal(caps.get('data_up_to'), 'Wed 28 Oct 13:18');
  const gasIds = [ID['gas.consumption|gas consumption'], ID['gas.consumption|Smart Meter, gas consumption']];
  assert.ok(!api.calls.some((c) => gasIds.some((id) => c.path.includes(id))), 'the electricity device read gas');
});

test('rates and standing charges come from /tariff, and Tariff changed fires when the rate changes', async () => {
  const { device, caps } = startDevice({ api: fakeCloudApi(), capabilities: { tariff: 24.5 } });
  await device.onInit();
  await settle();
  assert.equal(caps.get('tariff'), 25.63);
  assert.equal(caps.get('standing_charge'), 60.7);
  assert.deepEqual(triggered.filter((t) => t.id === 'tariff_changed').map((t) => t.tokens), [{ tariff: 25.63 }]);
});

test("New day's figures doesn't fire on the first poll after install", async () => {
  const { device, store } = startDevice({ api: fakeCloudApi() });
  await device.onInit();
  await settle();
  assert.equal(store.announcedDay, '2026-10-27');
  assert.equal(triggered.filter((t) => t.id === 'cloud_new_day_figures').length, 0);
});

test("New day's figures fires once for a final day", async () => {
  const { device } = startDevice({ api: fakeCloudApi(), store: { announcedDay: '2026-10-26' } });
  await device.onInit();
  await settle();
  await device.updateReadings();
  assert.deepEqual(triggered.filter((t) => t.id === 'cloud_new_day_figures').map((t) => t.tokens), [{
    date: 'Tue 27 Oct', electricity_kwh: 11.196, electricity_cost: 2.87,
  }]);
});

test('stopped and resumed reporting follow the time of the live reading', async () => {
  let readingAt = 1793194800;
  const api = fakeCloudApi({ overrides: { current: () => ({ data: [[readingAt, 250]] }) } });
  const { device } = startDevice({ api });
  await device.onInit();
  await settle();
  assert.equal(conditions.cloud_is_reporting({ device }), true);

  // The same reading for six minutes
  now += 6 * 60 * 1000;
  await device.updateDevice();
  await device.everyMinute();
  assert.deepEqual(triggered.filter((t) => t.id === 'cloud_stopped_reporting').map((t) => t.tokens), [{ minutes: 6 }]);
  assert.equal(conditions.cloud_is_reporting({ device }), false);
  await device.everyMinute();
  assert.equal(triggered.filter((t) => t.id === 'cloud_stopped_reporting').length, 1);

  readingAt += 400;
  await device.updateDevice();
  assert.deepEqual(triggered.filter((t) => t.id === 'cloud_resumed_reporting').map((t) => t.tokens), [{ minutes: 6 }]);
  assert.equal(conditions.cloud_is_reporting({ device }), true);
});

test('exporting starts and stops after a minute either side of zero', async () => {
  let watts = 250;
  const api = fakeCloudApi({ overrides: { current: () => ({ data: [[Math.floor(now / 1000), watts]] }) } });
  const { device } = startDevice({ api });
  await device.onInit();
  await settle();

  watts = -300;
  for (let i = 0; i < 6; i++) {
    now += 10000;
    await device.updateDevice();
  }
  assert.equal(conditions.cloud_is_exporting({ device }), false);
  now += 10000;
  await device.updateDevice();
  assert.deepEqual(triggered.filter((t) => t.id === 'cloud_started_exporting').map((t) => t.tokens), [{ power: -300 }]);
  assert.equal(conditions.cloud_is_exporting({ device }), true);

  watts = 120;
  for (let i = 0; i < 7; i++) {
    now += 10000;
    await device.updateDevice();
  }
  assert.deepEqual(triggered.filter((t) => t.id === 'cloud_stopped_exporting').map((t) => t.tokens), [{ power: 120 }]);
  assert.equal(conditions.cloud_is_exporting({ device }), false);
});

test('account needs attention once after 30 minutes of failed logins, and again only after recovering', async () => {
  resetApi({
    'POST /auth': { body: { valid: false } },
    'GET /resource/res-good-0001/current': { status: 401, body: { error: 'expired' } },
  });
  triggered.length = 0;
  const driver = makeDriver();
  const { device } = makeDevice(driver, { token: 'old-token' });
  device.health = new AccountHealth();
  const attention = () => triggered.filter((t) => t.id === 'cloud_account_attention').map((t) => t.tokens.reason);

  await device.request('/resource/res-good-0001/current').catch(() => {});
  now += 29 * 60 * 1000;
  await device.request('/resource/res-good-0001/current').catch(() => {});
  assert.deepEqual(attention(), []);
  now += 60 * 1000;
  await device.request('/resource/res-good-0001/current').catch(() => {});
  await device.request('/resource/res-good-0001/current').catch(() => {});
  assert.deepEqual(attention(), ['cloud.attention.login_failing']);
  assert.equal(conditions.cloud_account_ok({ device }), false);

  routes['POST /auth'] = { body: { valid: true, token: FRESH_TOKEN } };
  routes['GET /resource/res-good-0001/current'] = { body: { data: [[1, 2]] } };
  await device.request('/resource/res-good-0001/current');
  assert.equal(conditions.cloud_account_ok({ device }), true);
});

test('account needs attention when the entry is refused after a fresh login', async () => {
  resetApi();
  triggered.length = 0;
  const driver = makeDriver();
  const { device } = makeDevice(driver);
  device.health = new AccountHealth();
  device.setUnavailable = async () => {};
  await device.request('/resource/res-stale-0002/current').catch(() => {});
  await settle();
  assert.deepEqual(triggered.filter((t) => t.id === 'cloud_account_attention').map((t) => t.tokens), [{ reason: 'cloud.attention.not_authorised' }]);
});

test('cloud status shows the copies in use and the last tariff, without IDs', async () => {
  const { device } = startDevice({ api: fakeCloudApi() });
  await device.onInit();
  await settle();
  const status = device.getCloudStatus();
  assert.deepEqual(status.readings.find((r) => r.classifier === 'electricity.consumption'), {
    classifier: 'electricity.consumption', copy: 'electricity consumption', dataUpTo: Date.parse('2026-10-28T13:18:00Z'),
  });
  assert.equal(status.kind, 'electricity');
  assert.deepEqual(status.tariff, { at: RECORDED_AT, electricity: { rate: 25.63, standingCharge: 60.7 } });
  assert.ok(!JSON.stringify(status).includes('00000000-'), 'status contains a resource ID');
});

// The cloud gas device

const GAS = ID['gas.consumption|gas consumption'];
const GAS_SMART = ID['gas.consumption|Smart Meter, gas consumption'];

test('pairing a gas device lists entries with gas Glowmarkt has data for', async () => {
  resetApi({
    'GET /virtualentity': { body: [{ veId: 've-good-0001', name: 'DCC Sourced', postalCode: 'YO10 3DD' }, { veId: 've-stale-0002', name: 'DCC Sourced', postalCode: 'YO10 3DD' }] },
    'GET /virtualentity/ve-stale-0002/resources': { body: { resources: [{ resourceId: 'res-gas-0002', classifier: 'gas.consumption', name: 'gas consumption' }] } },
    'GET /resource/res-gas-0001/last-time': { body: { data: { lastTs: 1793143800 } } },
    'GET /resource/res-gas-0002/last-time': { status: 401, body: { error: 'Unauthorized' } },
  });
  const driver = makeDriver([], GasDriver);
  await driver.onInit();
  const devices = await pair(driver);
  assert.deepEqual(devices.map((d) => [d.name, d.data.id]), [['DCC Sourced gas for YO10 3DD', 've-good-0001']]);
  assert.deepEqual(driver.getCloudStatus()[0].skipped.map((s) => [s.kind, s.reason]), [['gas', { code: 'read_failed', status: 401 }]]);
});

test('the gas device shows the latest complete day, its cost, the tariff and data up to, reading no electricity', async () => {
  const api = fakeCloudApi();
  const { device, caps } = startDevice({ api, gas: true });
  await device.onInit();
  await settle();
  assert.equal(caps.get('gas_day'), 'Tue 27 Oct');
  assert.equal(caps.get('gas_day_energy'), 0);
  assert.equal(caps.get('gas_day_cost'), 0);
  assert.equal(caps.get('data_up_to'), 'Tue 27 Oct 23:30');
  assert.equal(caps.get('tariff'), 7.92);
  assert.equal(caps.get('standing_charge'), 28.84);
  assert.ok(!api.calls.some((c) => c.path.includes(ID['electricity.consumption|electricity consumption'])), 'the gas device read electricity');
  assert.deepEqual(device.getCloudStatus().tariff, { at: RECORDED_AT, gas: { rate: 7.92, standingCharge: 28.84 } });
});

test('without a gas tariff ever, the standing charge comes from the setting', async () => {
  const timeout = Object.assign(new Error('network timeout'), { type: 'request-timeout' });
  const api = fakeCloudApi({ overrides: { [`tariff ${GAS}`]: timeout, [`tariff ${GAS_SMART}`]: timeout } });
  const { device, caps } = startDevice({ api, gas: true, settings: { gas_standing_charge: 30.5 } });
  await device.onInit();
  await settle();
  assert.equal(caps.get('standing_charge'), 30.5);
  assert.equal(caps.get('tariff'), null);

  await device.onSettings({ oldSettings: {}, newSettings: { gas_standing_charge: 0 }, changedKeys: ['gas_standing_charge'] });
  assert.equal(caps.get('standing_charge'), null);
});

test("gas New day's figures: not on the first poll, then once per day, oldest first after a gap", async () => {
  const first = startDevice({ api: fakeCloudApi(), gas: true });
  await first.device.onInit();
  await settle();
  assert.equal(first.store.announcedDay, '2026-10-27');
  assert.equal(triggered.filter((t) => t.id === 'cloud_gas_new_day_figures').length, 0);

  const gap = startDevice({ api: fakeCloudApi(), gas: true, store: { announcedDay: '2026-10-23' } });
  await gap.device.onInit();
  await settle();
  assert.deepEqual(triggered.filter((t) => t.id === 'cloud_gas_new_day_figures').map((t) => t.tokens.date), ['Sat 24 Oct', 'Sun 25 Oct', 'Mon 26 Oct', 'Tue 27 Oct']);
  assert.deepEqual(triggered.find((t) => t.tokens.date === 'Sat 24 Oct').tokens, { date: 'Sat 24 Oct', gas_kwh: 28.081, gas_cost: 2.22 });
  assert.equal(gap.store.announcedDay, '2026-10-27');

  await gap.device.updateReadings();
  assert.equal(triggered.filter((t) => t.id === 'cloud_gas_new_day_figures').length, 4);
});

test('gas Data is late fires once when data up to passes 3 days, and the condition follows it', async () => {
  const { device } = startDevice({ api: fakeCloudApi(), gas: true });
  await device.onInit();
  await settle();
  assert.equal(conditions.cloud_gas_up_to_date({ device }), true);

  now = Date.parse('2026-10-31T00:00:00Z');
  await device.updateReadings();
  await device.updateReadings();
  assert.deepEqual(triggered.filter((t) => t.id === 'cloud_gas_data_late').map((t) => t.tokens), [{ days: 3 }]);
  assert.equal(conditions.cloud_gas_up_to_date({ device }), false);
});

test('cloud status puts electricity and gas devices on the same account together', async () => {
  const electricity = startDevice({ api: fakeCloudApi() });
  const gas = startDevice({ api: fakeCloudApi(), gas: true });
  await electricity.device.onInit();
  await gas.device.onInit();
  await settle();
  electricity.device.driver.getDevices = () => [electricity.device];
  gas.device.driver.getDevices = () => [gas.device];
  const CloudDriver = require('../../lib/cloud/CloudDriver');
  const accounts = CloudDriver.accountsStatus([electricity.device.driver, gas.device.driver]);
  assert.equal(accounts.length, 1);
  assert.deepEqual(accounts[0].devices.map((d) => d.kind), ['electricity', 'gas']);
});
