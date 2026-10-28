'use strict';

const { Device } = require('homey');
const { apiGet, tokenExpiry, summarise, apiError } = require('./glowmarkt');
const { maskPostcodes } = require('../glow/mask');
const AccountHealth = require('./AccountHealth');
const CloudReadings = require('./CloudReadings');
const { nextTariffAt } = require('./TariffSource');

// renew the token when less than this much of its life remains
const TOKEN_RENEW_BEFORE_MS = 24 * 60 * 60 * 1000;
// how long to wait before trying again when access is refused even after a fresh login
const ACCESS_REFUSED_RETRY_MS = 60 * 60 * 1000;

/**
 * Shared behaviour of the cloud electricity and gas devices: requests with
 * token renewal and the 401 back-off, account health, the readings layer for
 * the device's commodity, half-hourly tariff fetches, timers and status for
 * the settings page.
 *
 * Subclasses set `commodity` ('electricity' or 'gas') before calling
 * setUpCloud(), start their polls with every() and scheduleTariff(), and
 * implement updateTariff().
 */
class CloudDevice extends Device {

  setUpCloud() {
    // shown in the Cloud section of the app settings page
    if (!this.cloudStatus) this.cloudStatus = { lastSuccessAt: null, lastError: null };
    this.health = new AccountHealth(this.getStoreValue('accountHealth') || {});
    this.readings = null;
    this.readingsPromise = null;
    this.tariffResult = null;
    this.intervals = [];
  }

  async ensureCapability(capability, title) {
    if (this.hasCapability(capability)) return;
    await this.addCapability(capability);
    if (title) await this.setCapabilityOptions(capability, { title: { en: title } }).catch(this.error);
  }

  async setIfChanged(capability, value) {
    if (!this.hasCapability(capability) || this.getCapabilityValue(capability) === value) return;
    await this.setCapabilityValue(capability, value).catch(this.error);
  }

  /** Runs `fn` every `ms` until stopTimers(). */
  every(fn, ms) {
    this.intervals.push(this.homey.setInterval(fn, ms));
  }

  /**
   * Fetches the tariff now, then 30 s after each hour and half hour. A fetch
   * still running from before stopTimers() doesn't schedule another.
   */
  startTariff() {
    const generation = this.pollGeneration;
    const fetchThenSchedule = () => this.updateTariff().then(() => {
      if (generation !== this.pollGeneration) return;
      this.tariffTimer = this.homey.setTimeout(fetchThenSchedule, nextTariffAt(Date.now()) - Date.now());
    });
    fetchThenSchedule();
  }

  stopTimers() {
    for (const interval of this.intervals || []) this.homey.clearInterval(interval);
    if (this.tariffTimer) this.homey.clearTimeout(this.tariffTimer);
    this.intervals = [];
    this.tariffTimer = null;
    this.pollGeneration = (this.pollGeneration || 0) + 1;
  }

  async accountEvent(event) {
    if (!event) return;
    this.log(`Account needs attention: ${event.reason}`);
    const reason = this.homey.__(`cloud.attention.${event.reason}`);
    await this.driver.cards.accountAttention.trigger(this, { reason }).catch(this.error);
  }

  async saveState() {
    if (this.health) await this.setStoreValue('accountHealth', this.health.toJSON()).catch(this.error);
  }

  /**
   * The readings layer for this device's entry and commodity, created once
   * the entry's resources are listed.
   */
  loadReadings() {
    if (!this.readingsPromise) {
      this.readingsPromise = this.createReadings().catch((error) => {
        this.readingsPromise = null;
        throw error;
      });
    }
    return this.readingsPromise;
  }

  async createReadings() {
    const body = await this.request(`/virtualentity/${this.getData().id}/resources`);
    const resources = Array.isArray(body && body.resources) ? body.resources : [];
    await this.onResources(resources);
    this.readings = new CloudReadings({
      request: (path, options) => this.request(path, options),
      resources,
      state: this.getStoreValue('cloudReadings') || {},
      commodity: this.commodity,
    });
    return this.readings;
  }

  /** Called with the entry's resources before the readings layer is made. */
  async onResources(resources) {}

  async saveReadings() {
    if (this.readings) await this.setStoreValue('cloudReadings', this.readings.toJSON()).catch(this.error);
  }

  /**
   * GETs an API path and returns the response body. Renews the token when it's
   * close to expiry, and logs in again once on a 401 or error response. If it's
   * still a 401 after a fresh login, marks the device unavailable and stops
   * trying for an hour. Errors for HTTP failures carry the `status`; `options`
   * go to apiGet, as { timeoutMs }.
   */
  async request(path, options) {
    let token = await this.currentToken();
    let res = await apiGet(path, token, options);
    if (res.authFailed) {
      this.log(`${path.split('?')[0]} returned HTTP ${res.status}, logging in again`);
      token = await this.refreshToken();
      if (!token) throw apiError('Token refresh failed');
      res = await apiGet(path, token, options);
      if (res.status === 401) {
        this.refuseAccess(res);
        const error = apiError('HTTP 401 after a fresh login', JSON.stringify(res.body));
        error.accessRefused = true;
        error.status = 401;
        throw error;
      }
    }
    if (!res.ok) {
      const error = apiError(`HTTP ${res.status} from /${path.split('?')[0].split('/').pop()}`, JSON.stringify(res.body));
      error.status = res.status;
      throw error;
    }
    if (this.health) this.health.succeeded();
    return res.body;
  }

  /**
   * Returns the stored token, renewing it first if it expires within a day.
   */
  async currentToken() {
    const token = this.getStoreValue('token');
    const expiry = tokenExpiry(token);
    if (expiry !== null && expiry - Date.now() < TOKEN_RENEW_BEFORE_MS) {
      this.log('Token expires within a day, renewing');
      return (await this.refreshToken()) || token;
    }
    return token;
  }

  /**
   * Refreshes the API token using stored credentials. Returns the new token or null on failure.
   * Concurrent calls share one login through the driver, across every device on the account.
   */
  async refreshToken() {
    const settings = this.getSettings();
    const token = await this.driver.login(settings.username, settings.password);
    if (!token) {
      this.error('Token refresh failed');
      if (this.health) await this.accountEvent(this.health.loginFailed(Date.now()));
      return null;
    }
    if (this.health) this.health.loginSucceeded();
    await this.setStoreValue('token', token);
    this.log('Token refreshed successfully');
    return token;
  }

  /** Logs in again after the username or password changes in the device's settings. */
  async applyCredentials(newSettings) {
    this.log('Credentials changed - getting new token from API');
    const token = await this.driver.login(newSettings.username, newSettings.password);
    await this.setStoreValue('token', token || 'VOID');
    this.accessRefusedUntil = null;
  }

  recordError(poll, error) {
    this.cloudStatus.lastError = { at: Date.now(), poll, message: summarise(error) };
  }

  /**
   * Status for the Cloud section of the app settings page, with the postcode
   * masked in the device name. Resource copies are described by name and
   * classifier, never by ID.
   */
  getCloudStatus() {
    const expiry = tokenExpiry(this.getStoreValue('token'));
    const status = this.cloudStatus || {};
    return {
      name: maskPostcodes(this.getName()),
      kind: this.commodity,
      available: this.getAvailable(),
      lastSuccessAt: status.lastSuccessAt || null,
      lastError: status.lastError || null,
      accessRefusedUntil: this.isAccessRefused() ? this.accessRefusedUntil : null,
      tokenRenewsAt: expiry === null ? null : expiry - TOKEN_RENEW_BEFORE_MS,
      readings: this.readingsStatus(),
      tariff: this.tariffResult && { at: this.tariffResult.at, [this.commodity]: this.tariffResult[this.commodity] || null },
    };
  }

  /** [{ classifier, copy, dataUpTo }] for the copies in use, or [] before the first readings poll. */
  readingsStatus() {
    const { readings } = this;
    if (!readings || !readings.selected) return [];
    return Object.entries(readings.selected).map(([classifier, { resourceId, lastTime }]) => {
      const resource = readings.resources.find((r) => r.resourceId === resourceId);
      return { classifier, copy: resource ? maskPostcodes(resource.name) : null, dataUpTo: lastTime };
    });
  }

  isAccessRefused() {
    return Boolean(this.accessRefusedUntil && Date.now() < this.accessRefusedUntil);
  }

  refuseAccess(res) {
    this.accessRefusedUntil = Date.now() + ACCESS_REFUSED_RETRY_MS;
    this.error(`Access refused after a fresh login (HTTP ${res.status}); retrying in an hour`);
    this.setUnavailable(this.homey.__('cloud.accessRefused')).catch(this.error);
    if (this.health) this.accountEvent(this.health.refused()).catch(this.error);
  }

  isAccountOk() {
    return this.health.isOk();
  }

  async onDeleted() {
    this.stopTimers();
  }

  /**
   * onUninit is called when the app stops or restarts, or the device is updated.
   */
  async onUninit() {
    this.stopTimers();
    await this.saveState();
  }

}

CloudDevice.TOKEN_RENEW_BEFORE_MS = TOKEN_RENEW_BEFORE_MS;

module.exports = CloudDevice;
