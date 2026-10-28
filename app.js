'use strict';

const Homey = require('homey');

const LayerSupervisor = require('./lib/mqtt/LayerSupervisor');
const CloudDriver = require('./lib/cloud/CloudDriver');

const LOCAL_DRIVER_IDS = ['glow_local_gas', 'glow_local_electricity'];
const SETTINGS_KEY = 'mqtt';
const START_NOW_KEY = 'mqttStartNow';
const RESTART_DEBOUNCE_MS = 1000;
const CHECK_INTERVAL_MS = 60 * 1000;
const ADDRESS_CACHE_MS = 60 * 1000;

class GlowmarktApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('Glowmarkt app initialised');

    // The MQTT layer and unit registry are created the first time the layer
    // starts, so an app with no local devices loads nothing extra and opens no port.
    this.layer = null;
    this.registry = null;
    this.supervisor = new LayerSupervisor();
    this.supervisor.setStartNow(this.homey.settings.get(START_NOW_KEY) === true);

    this.homey.settings.on('set', (key) => {
      if (key === SETTINGS_KEY) this.scheduleRestart();
    });

    await this.updateLayer();
  }

  async onUninit() {
    if (this.restartTimer) this.homey.clearTimeout(this.restartTimer);
    if (this.checkInterval) this.homey.clearInterval(this.checkInterval);
    if (this.layer) await this.layer.stop();
  }

  getMqttSettings() {
    const MqttLayer = require('./lib/mqtt/MqttLayer');
    return MqttLayer.normaliseSettings(this.homey.settings.get(SETTINGS_KEY));
  }

  localDevices() {
    const drivers = this.homey.drivers.getDrivers();
    const devices = [];
    for (const id of LOCAL_DRIVER_IDS) {
      if (!drivers[id]) continue;
      try {
        devices.push(...drivers[id].getDevices());
      } catch (error) {
        // The driver isn't ready yet; its devices report in when they initialise.
      }
    }
    return devices;
  }

  isLayerActive() {
    return Boolean(this.layer && this.layer.isActive());
  }

  /**
   * Starts or stops the MQTT layer according to the supervisor. Local devices
   * and pairing sessions call this when they appear or go away.
   */
  async updateLayer({ immediate = false } = {}) {
    const decision = this.supervisor.decide({
      now: Date.now(),
      localDevices: this.localDevices().length,
      running: this.isLayerActive(),
      immediate,
    });
    if (decision === 'start') await this.startLayer();
    if (decision === 'stop') await this.stopLayer();
  }

  async startLayer() {
    if (!this.layer) {
      const MqttLayer = require('./lib/mqtt/MqttLayer');
      const UnitRegistry = require('./lib/glow/UnitRegistry');
      this.registry = new UnitRegistry();
      // Staleness counts messages for the meter itself, so STATE doesn't count.
      this.registry.on('arrival', (event) => {
        if (event.kind !== 'STATE') this.routeToDevices(event.unitId, event.kind, 'onGlowArrival', event);
      });
      this.registry.on('reading', (event) => this.routeToDevices(event.unitId, event.kind, 'onGlowReading', event));
      this.registry.on('state', (event) => this.routeToDevices(event.unitId, 'STATE', 'onGlowState', event));
      this.layer = new MqttLayer({
        onMessage: (topic, payload) => this.registry.handleMessage(topic, payload),
        log: (message) => this.log(`[MQTT] ${message}`),
      });
    }
    const settings = this.getMqttSettings();
    this.registry.clear();
    this.registry.setPrefix(settings.prefix);
    await this.layer.start(settings);
    if (!this.checkInterval) this.checkInterval = this.homey.setInterval(() => this.updateLayer().catch(this.error), CHECK_INTERVAL_MS);
  }

  /**
   * Hands a message to the local devices for that unit: meter messages to the
   * device of that kind, STATE to both. Drivers never touch MQTT.
   */
  routeToDevices(unitId, kind, method, event) {
    for (const device of this.localDevices()) {
      const data = device.getData();
      if (data.unitId !== unitId || (kind !== 'STATE' && data.kind !== kind)) continue;
      if (typeof device[method] !== 'function') continue;
      Promise.resolve()
        .then(() => device[method](event))
        .catch((error) => this.error(`${method} failed for ${device.getName()}:`, error));
    }
  }

  async stopLayer() {
    if (this.checkInterval) {
      this.homey.clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    if (this.layer) await this.layer.stop();
  }

  // A settings change restarts a running layer after a short pause, so a burst
  // of changes causes one restart.
  scheduleRestart() {
    if (this.restartTimer) this.homey.clearTimeout(this.restartTimer);
    this.restartTimer = this.homey.setTimeout(() => {
      this.restartTimer = null;
      if (!this.isLayerActive()) return;
      const settings = this.getMqttSettings();
      this.registry.clear();
      this.registry.setPrefix(settings.prefix);
      this.layer.restart(settings).catch(this.error);
    }, RESTART_DEBOUNCE_MS);
  }

  async startMqttNow() {
    this.homey.settings.set(START_NOW_KEY, true);
    this.supervisor.setStartNow(true);
    // Start now also retries a layer stuck in the error state.
    if (this.layer && this.layer.getStatus().state === 'error') await this.stopLayer();
    await this.updateLayer();
    return this.getMqttStatus();
  }

  async stopMqttNow() {
    this.homey.settings.set(START_NOW_KEY, false);
    this.supervisor.setStartNow(false);
    await this.updateLayer({ immediate: true });
    return this.getMqttStatus();
  }

  // Pairing sessions on the local drivers keep the layer running while open.

  async openPairingSession() {
    const id = this.supervisor.openSession(Date.now());
    await this.updateLayer();
    return id;
  }

  touchPairingSession(id) {
    this.supervisor.touchSession(id, Date.now());
  }

  async closePairingSession(id) {
    this.supervisor.closeSession(id);
    await this.updateLayer();
  }

  /**
   * What to enter on the display, for the pairing view: the built-in broker's
   * address, port, prefix and credentials, or the external broker's address.
   */
  getConnectionDetails(address) {
    const settings = this.getMqttSettings();
    if (settings.mode === 'external') {
      return {
        mode: 'external', host: settings.externalHost, port: settings.externalPort, prefix: settings.prefix,
      };
    }
    return {
      mode: 'builtin',
      address,
      port: settings.port,
      prefix: settings.prefix,
      auth: settings.authEnabled ? { username: settings.username, password: settings.password } : null,
    };
  }

  async getLocalIp() {
    if (this.localIp && Date.now() - this.localIp.at < ADDRESS_CACHE_MS) return this.localIp.value;
    let value = null;
    try {
      // Documented as "address & port"; keep only the address.
      const address = String(await this.homey.cloud.getLocalAddress());
      value = address.replace(/:\d+$/, '') || null;
    } catch (error) {
      this.error('Could not get the local address:', error.message);
    }
    this.localIp = { value, at: Date.now() };
    return value;
  }

  async getMqttStatus() {
    const settings = this.getMqttSettings();
    const status = this.layer ? this.layer.getStatus() : { state: 'stopped', error: null, transport: null };
    const devices = this.localDevices();

    let error = null;
    if (status.error) {
      const key = `settings.errors.${status.error.code}`;
      const translated = this.homey.__(key, { port: status.error.port, message: status.error.message });
      error = { code: status.error.code, message: translated && translated !== key ? translated : status.error.message };
    }

    const units = this.registry ? this.registry.getUnits() : [];
    for (const unit of units) {
      unit.devices = devices
        .filter((device) => device.getData().unitId === unit.unitId)
        .map((device) => (typeof device.getStatusSummary === 'function'
          ? device.getStatusSummary()
          : { name: device.getName(), kind: device.getData().kind }));
    }

    return {
      state: status.state,
      error,
      mode: settings.mode,
      prefix: settings.prefix,
      startNow: this.supervisor.startNow,
      localDevices: devices.length,
      address: await this.getLocalIp(),
      transport: status.transport,
      units,
      ignoredMessages: this.registry ? this.registry.ignored : 0,
      cloud: this.getCloudStatus(),
    };
  }

  getCloudStatus() {
    const drivers = this.homey.drivers.getDrivers();
    const cloud = ['smart-meter', 'glow_cloud_gas'].map((id) => drivers[id]).filter(Boolean);
    try {
      return CloudDriver.accountsStatus(cloud);
    } catch (error) {
      // A driver isn't ready yet.
      return [];
    }
  }

  getMqttDebugLog() {
    return this.registry ? this.registry.getDebugLog() : [];
  }

}

module.exports = GlowmarktApp;
