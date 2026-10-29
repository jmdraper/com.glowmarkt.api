'use strict';

// Builds a local gas or electricity device against a stand-in for the Homey
// runtime, recording capability writes, triggers, warnings and logs. Timers
// don't run: tests call everyMinute() themselves. Uses Date.now, so tests can
// control time by replacing it.

require('./homey-stub');
const { translate } = require('./locale');
const GasDevice = require('../../drivers/glow_local_gas/device');
const ElectricityDevice = require('../../drivers/glow_local_electricity/device');

const GAS_CAPABILITIES = ['meter_gas', 'gas_energy', 'tariff', 'standing_charge', 'display_link', 'signal_strength', 'link_quality'];
const ELECTRICITY_CAPABILITIES = ['measure_power', 'meter_power.imported', 'meter_power.exported', 'tariff', 'standing_charge', 'display_link', 'signal_strength', 'link_quality'];

async function makeDevice(Klass, {
  kind, unitId = 'ABC', store = {}, settings = {}, capabilities,
}) {
  const device = new Klass();
  const caps = new Map(capabilities.map((c) => [c, null]));
  const record = {
    writes: [], triggers: [], warnings: [], logs: [], store, settings, caps,
  };
  Object.assign(device, {
    homey: {
      flow: {
        getDeviceTriggerCard: (id) => ({
          trigger: async (dev, tokens) => { record.triggers.push({ id: id.replace(/^glow_local_(gas|electricity)_/, ''), tokens }); },
        }),
      },
      setInterval: () => 1,
      clearInterval: () => {},
      setTimeout: () => 1,
      __: translate,
      app: { updateLayer: async () => {} },
    },
    driver: { id: kind === 'gasmeter' ? 'glow_local_gas' : 'glow_local_electricity' },
    getData: () => ({ unitId, kind }),
    getName: () => (kind === 'gasmeter' ? 'Gas meter (local)' : 'Electricity meter (local)'),
    getStoreValue: (key) => store[key],
    setStoreValue: async (key, value) => { store[key] = JSON.parse(JSON.stringify(value)); },
    getSetting: (key) => settings[key],
    setSettings: async (values) => { Object.assign(settings, values); },
    hasCapability: (c) => caps.has(c),
    getCapabilityValue: (c) => caps.get(c),
    setCapabilityValue: async (c, v) => { caps.set(c, v); record.writes.push([c, v]); },
    setWarning: async (message) => { record.warnings.push(message); },
    unsetWarning: async () => { record.warnings.push(null); },
    log: (...args) => record.logs.push(args.join(' ')),
    error: (...args) => record.logs.push(`ERROR ${args.join(' ')}`),
  });
  await device.onInit();
  return { device, record };
}

const gasDevice = (options = {}) => makeDevice(GasDevice, { kind: 'gasmeter', capabilities: GAS_CAPABILITIES, ...options });
const electricityDevice = (options = {}) => makeDevice(ElectricityDevice, { kind: 'electricitymeter', capabilities: ELECTRICITY_CAPABILITIES, ...options });

module.exports = {
  makeDevice, gasDevice, electricityDevice, GAS_CAPABILITIES, ELECTRICITY_CAPABILITIES,
};
