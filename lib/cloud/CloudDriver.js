'use strict';

const { Driver } = require('homey');
const { authenticate, apiGet, summarise } = require('./glowmarkt');
const { maskPostcodes } = require('../glow/mask');

/**
 * Shared behaviour of the cloud electricity and gas drivers: one login shared
 * per account, pairing with a Bright app login, the account health cards, and
 * status for the settings page.
 *
 * Subclasses set `kind` ('electricity' or 'gas') and implement
 * entryToDevice(virtualEntity, resources, token, settings).
 */
class CloudDriver extends Driver {

  async onInit() {
    this.logins = new Map();
    // entries left out of the latest pairing, per account, since the app started
    this.pairingSkips = new Map();
  }

  /**
   * Gets this driver's device trigger cards and registers its conditions.
   * `prefix` starts each card id; `conditions` maps a condition's id to a test
   * of the device.
   */
  registerCards(prefix, triggers, conditions) {
    this.cards = Object.fromEntries(Object.entries(triggers)
      .map(([name, id]) => [name, this.homey.flow.getDeviceTriggerCard(`${prefix}${id}`)]));
    for (const [id, test] of Object.entries(conditions)) {
      this.homey.flow.getConditionCard(`${prefix}${id}`).registerRunListener(({ device }) => test(device));
    }
  }

  /**
   * Cloud status per account for the settings page, across drivers. Accounts
   * are numbered, not named, and device and entity names have postcodes masked.
   */
  static accountsStatus(drivers) {
    const accounts = new Map();
    const account = (username) => {
      if (!accounts.has(username)) accounts.set(username, { devices: [], skipped: [], tokenRenewsAt: null });
      return accounts.get(username);
    };

    for (const driver of drivers) {
      for (const device of driver.getDevices()) {
        const entry = account(device.getSetting('username'));
        const status = device.getCloudStatus();
        entry.devices.push(status);
        if (status.tokenRenewsAt !== null && (entry.tokenRenewsAt === null || status.tokenRenewsAt < entry.tokenRenewsAt)) {
          entry.tokenRenewsAt = status.tokenRenewsAt;
        }
      }
    }
    for (const driver of drivers) {
      for (const [username, skipped] of driver.pairingSkips || []) {
        if (skipped.length) account(username).skipped.push(...skipped);
      }
    }

    return [...accounts.values()].map((entry, i) => ({ number: i + 1, ...entry }));
  }

  getCloudStatus() {
    return CloudDriver.accountsStatus([this]);
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
      const skip = (virtualEntity, reason) => skipped.push({
        name: maskPostcodes(virtualEntity.name), kind: this.kind, reason, at: Date.now(),
      });
      for (const virtualEntity of virtualEntities) {
        try {
          const result = await this.veToDevice(virtualEntity, token, { username, password });
          if (result.skipped) skip(virtualEntity, result.skipped);
          else devices.push(result);
        } catch (error) {
          this.log(`Skipping virtual entity ${virtualEntity.name}: ${error.message}`);
          skip(virtualEntity, { code: 'error', message: summarise(error) });
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
   * resources fail or are empty, or entryToDevice() turns it down.
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
    return this.entryToDevice(virtualEntity, resources, token, settings);
  }

}

module.exports = CloudDriver;
