'use strict';

// Runs app.js against a stand-in for the Homey runtime, with the real MQTT
// layer on spare local ports.

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { EventEmitter } = require('events');
const mqtt = require('mqtt');

require('./helpers/homey-stub');
const GlowmarktApp = require('../app');

const { translate } = require('./helpers/locale');

function fakeHomey(stored = {}, devices = [], cloudDriver = null) {
  const settings = new EventEmitter();
  const values = new Map(Object.entries(stored));
  settings.get = (key) => values.get(key);
  settings.set = (key, value) => {
    values.set(key, value);
    settings.emit('set', key);
  };
  const drivers = {};
  if (devices.length) drivers.glow_local_gas = { getDevices: () => devices };
  if (cloudDriver) drivers['smart-meter'] = cloudDriver;
  return {
    settings,
    drivers: { getDrivers: () => drivers },
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    cloud: { getLocalAddress: async () => '192.168.1.20:80' },
    __: translate,
  };
}

async function makeApp(stored, devices, cloudDriver) {
  const app = new GlowmarktApp();
  app.homey = fakeHomey(stored, devices, cloudDriver);
  app.log = () => {};
  app.error = () => {};
  await app.onInit();
  return app;
}

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function isListening(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('after an upgrade with no local devices, nothing starts and nothing is loaded', async () => {
  const port = await freePort();
  const app = await makeApp({ mqtt: { port } });
  assert.equal(app.layer, null);
  assert.equal(app.registry, null);
  assert.equal(await isListening(port), false);
  const status = await app.getMqttStatus();
  assert.equal(status.state, 'stopped');
  assert.deepEqual(status.units, []);
  await app.onUninit();
});

test('Start now listens, shows a published unit, and Stop closes the port', async () => {
  const port = await freePort();
  const app = await makeApp({ mqtt: { port } });

  let status = await app.startMqttNow();
  assert.equal(status.state, 'running');
  assert.equal(status.address, '192.168.1.20');
  assert.equal(status.transport.port, port);
  assert.equal(await isListening(port), true);

  const client = await mqtt.connectAsync({ host: '127.0.0.1', port, reconnectPeriod: 0 });
  await client.publishAsync('glow/TEST/STATE', JSON.stringify({ timestamp: '2026-10-25T16:08:22Z', han: { status: 'joined', rssi: -32, lqi: 255 } }));
  await client.endAsync();
  await sleep(100);

  status = await app.getMqttStatus();
  assert.equal(status.units.length, 1);
  assert.equal(status.units[0].unitId, 'TEST');
  assert.equal(status.units[0].han.status, 'joined');
  assert.equal(app.getMqttDebugLog()[0].topic, 'glow/TEST/STATE');

  status = await app.stopMqttNow();
  assert.equal(status.state, 'stopped');
  assert.equal(await isListening(port), false);
  await app.onUninit();
});

test('the Start now flag survives a restart of the app', async () => {
  const port = await freePort();
  const app = await makeApp({ mqtt: { port }, mqttStartNow: true });
  assert.equal(await isListening(port), true);
  await app.onUninit();
  assert.equal(await isListening(port), false);
});

test('changing the port restarts the layer after a pause', async () => {
  const [first, second] = [await freePort(), await freePort()];
  const app = await makeApp({ mqtt: { port: first } });
  await app.startMqttNow();
  app.homey.settings.set('mqtt', { port: second });
  await sleep(1300);
  assert.equal(await isListening(first), false);
  assert.equal(await isListening(second), true);
  await app.onUninit();
});

test('a port in use shows a localised error and no crash', async () => {
  const port = await freePort();
  const blocker = net.createServer().listen(port);
  await new Promise((resolve) => blocker.once('listening', resolve));

  const app = await makeApp({ mqtt: { port } });
  const status = await app.startMqttNow();
  assert.equal(status.state, 'error');
  assert.equal(status.error.message, `Port ${port} is already in use by another app; choose another port.`);
  await app.onUninit();
  await new Promise((resolve) => blocker.close(resolve));
});

test('a local device starts the layer at init', async () => {
  const port = await freePort();
  const app = await makeApp({ mqtt: { port } }, [{ getData: () => ({ unitId: 'TEST', kind: 'gasmeter' }), getName: () => 'Gas' }]);
  assert.equal(await isListening(port), true);
  const status = await app.getMqttStatus();
  assert.equal(status.localDevices, 1);
  await app.onUninit();
});

test('a pairing session starts the layer; closing it leaves it running for the idle period', async () => {
  const port = await freePort();
  const app = await makeApp({ mqtt: { port } });
  const session = await app.openPairingSession();
  assert.equal(await isListening(port), true);
  await app.closePairingSession(session);
  assert.equal(await isListening(port), true);
  await app.onUninit();
});

test('status includes the cloud drivers status, or an empty list without them', async () => {
  const port = await freePort();
  let app = await makeApp({ mqtt: { port } });
  assert.deepEqual((await app.getMqttStatus()).cloud, []);
  await app.onUninit();

  const status = { name: 'Home', tokenRenewsAt: null };
  const device = { getSetting: () => 'someone@example.com', getCloudStatus: () => status };
  app = await makeApp({ mqtt: { port } }, [], { getDevices: () => [device], pairingSkips: new Map() });
  assert.deepEqual((await app.getMqttStatus()).cloud, [{
    number: 1, devices: [status], skipped: [], tokenRenewsAt: null,
  }]);
  await app.onUninit();

  app = await makeApp({ mqtt: { port } }, [], { getDevices: () => { throw new Error('not ready'); } });
  assert.deepEqual((await app.getMqttStatus()).cloud, []);
  await app.onUninit();
});

test('messages reach the local device for that unit and kind; STATE reaches both', async (t) => {
  const port = await freePort();
  const calls = [];
  const fake = (unitId, kind) => ({
    getData: () => ({ unitId, kind }),
    getName: () => `${unitId} ${kind}`,
    onGlowArrival: (e) => calls.push(`${unitId} ${kind} arrival ${e.kind}`),
    onGlowReading: (e) => calls.push(`${unitId} ${kind} reading ${e.kind}`),
    onGlowState: () => calls.push(`${unitId} ${kind} state`),
  });
  const devices = [fake('TEST', 'electricitymeter'), fake('TEST', 'gasmeter'), fake('OTHER', 'electricitymeter')];
  const app = await makeApp({ mqtt: { port } }, devices);
  t.after(() => app.onUninit());

  const client = await mqtt.connectAsync({ host: '127.0.0.1', port, reconnectPeriod: 0 });
  const timestamp = new Date().toISOString();
  await client.publishAsync('glow/TEST/SENSOR/electricitymeter', JSON.stringify({ electricitymeter: { timestamp, power: { value: 1 } } }));
  await client.publishAsync('glow/TEST/STATE', JSON.stringify({ timestamp, han: { status: 'joined', rssi: -32, lqi: 255 } }));
  await client.endAsync();
  await sleep(100);

  assert.deepEqual(calls.sort(), [
    'TEST electricitymeter arrival electricitymeter',
    'TEST electricitymeter reading electricitymeter',
    'TEST electricitymeter state',
    'TEST gasmeter state',
  ]);
});
