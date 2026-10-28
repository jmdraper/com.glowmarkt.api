'use strict';

const { Driver } = require('homey');
const { authenticate, apiGet, summarise } = require('../../lib/cloud/glowmarkt');
const { maskPostcodes } = require('../../lib/glow/mask');
const { liveElectricityResource } = require('../../lib/cloud/resources');

class GlowmarktUKSmartMeter_driver extends Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('Glowmarkt UK Smart Meter driver has been initialized');
    this.tariffChangedTrigger = this.homey.flow.getDeviceTriggerCard('tariff_changed');
    const trigger = (id) => this.homey.flow.getDeviceTriggerCard(`cloud_${id}`);
    this.cards = {
      stopped: trigger('stopped_reporting'),
      resumed: trigger('resumed_reporting'),
      accountAttention: trigger('account_attention'),
      startedExporting: trigger('started_exporting'),
      stoppedExporting: trigger('stopped_exporting'),
      newDay: trigger('new_day_figures'),
    };
    const condition = (id, test) => this.homey.flow.getConditionCard(`cloud_${id}`).registerRunListener(({ device }) => test(device));
    condition('is_reporting', (device) => device.isReporting());
    condition('account_ok', (device) => device.isAccountOk());
    condition('is_exporting', (device) => device.isExporting());
    this.logins = new Map();
    // entries left out of the latest pairing, per account, since the app started
    this.pairingSkips = new Map();
  }

  /**
   * Cloud status per account for the settings page. Accounts are numbered, not
   * named, and device and entity names have postcodes masked.
   */
  getCloudStatus() {
    const accounts = new Map();
    const account = (username) => {
      if (!accounts.has(username)) accounts.set(username, { devices: [], skipped: [], tokenRenewsAt: null });
      return accounts.get(username);
    };

    for (const device of this.getDevices()) {
      const entry = account(device.getSetting('username'));
      const status = device.getCloudStatus();
      entry.devices.push(status);
      if (status.tokenRenewsAt !== null && (entry.tokenRenewsAt === null || status.tokenRenewsAt < entry.tokenRenewsAt)) {
        entry.tokenRenewsAt = status.tokenRenewsAt;
      }
    }
    for (const [username, skipped] of this.pairingSkips) {
      if (skipped.length) account(username).skipped = skipped;
    }

    return [...accounts.values()].map((entry, i) => ({ number: i + 1, ...entry }));
  }

  /**
   * Logs in, sharing one request between every device and poll that asks for
   * the same account at the same time. Returns the new token, or null on failure.
   */
  login(username, password) {
    if (!this.logins.has(username)) {
      const attempt = authenticate(username, password)
        .catch((error) => {
          this.error('Login failed:', error);
          return null;
        })
        .finally(() => this.logins.delete(username));
      this.logins.set(username, attempt);
    }
    return this.logins.get(username);
  }

  async onPair(session) {
    let username;
    let password;
    let token;

    session.setHandler("login", async (data) => {
      username = data.username;
      password = data.password;

      // get new auth token from API
      token = await authenticate(username, password);
      this.log('Login credentials valid: ' + Boolean(token));
      return Boolean(token);
    });

    session.setHandler("list_devices", async () => {
      // get list of resources from API
      const veidResponse = await apiGet('/virtualentity', token);
      if (!veidResponse.ok || !Array.isArray(veidResponse.body)) {
        throw new Error(`Could not list virtual entities (HTTP ${veidResponse.status})`);
      }
      const virtualEntities = veidResponse.body;

      // map the ones whose resources work to an array of devices for pairing,
      // recording the rest for the settings page
      const devices = [];
      const skipped = [];
      for (const virtualEntity of virtualEntities) {
        try {
          const result = await this.veToDevice(virtualEntity, token, { username, password });
          if (result.skipped) skipped.push({ name: maskPostcodes(virtualEntity.name), reason: result.skipped, at: Date.now() });
          else devices.push(result);
        } catch (error) {
          this.log(`Skipping virtual entity ${virtualEntity.name}: ${error.message}`);
          skipped.push({ name: maskPostcodes(virtualEntity.name), reason: { code: 'error', message: summarise(error) }, at: Date.now() });
        }
      }
      this.pairingSkips.set(username, skipped);
      this.log(`Virtual Entities: ${virtualEntities.length}, usable: ${devices.length}`);

      // finally, return the array of devices available to pair
      return devices;
    });
  }

  /**
   * Returns a pairing entry for a virtual entity, or { skipped: reason } if its
   * resources fail, are empty, or can't be read (a stale entity lists its
   * resources normally but returns HTTP 401 on /current).
   */
  async veToDevice(virtualEntity, token, settings) {
    const resourcesResponse = await apiGet(`/virtualentity/${virtualEntity.veId}/resources`, token);
    if (!resourcesResponse.ok) {
      this.log(`Skipping virtual entity ${virtualEntity.name}: resources failed (HTTP ${resourcesResponse.status})`);
      return { skipped: { code: 'resources_failed', status: resourcesResponse.status } };
    }
    const { resources } = resourcesResponse.body;
    if (!Array.isArray(resources) || resources.length === 0) {
      this.log(`Skipping virtual entity ${virtualEntity.name}: no resources`);
      return { skipped: { code: 'no_resources' } };
    }

    // live power and the import register come from an electricity.consumption resource
    const elec_cons_res = liveElectricityResource(resources, null);
    if (!elec_cons_res) {
      this.log(`Skipping virtual entity ${virtualEntity.name}: no electricity consumption resource`);
      return { skipped: { code: 'no_electricity' } };
    }

    // check the resource can actually be read
    const current = await apiGet(`/resource/${elec_cons_res}/current`, token);
    if (!current.ok) {
      this.log(`Skipping virtual entity ${virtualEntity.name}: its resource returned HTTP ${current.status}`);
      return { skipped: { code: 'read_failed', status: current.status } };
    }

    // create store object
    const deviceStore = { elec_cons_res, token: token };

    // return a homey device object
    return {
      name: `${virtualEntity.name} for ${virtualEntity.postalCode}`,
      data: { id: virtualEntity.veId },
      settings,
      store: deviceStore
    };
  }

}

module.exports = GlowmarktUKSmartMeter_driver;
