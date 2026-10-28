'use strict';

const { Device } = require('homey');
const { apiGet, tokenExpiry, summarise, apiError } = require('../../lib/cloud/glowmarkt');
const { maskPostcodes } = require('../../lib/glow/mask');
const StalenessTracker = require('../../lib/glow/StalenessTracker');
const ExportingTracker = require('../../lib/ExportingTracker');
const AccountHealth = require('../../lib/cloud/AccountHealth');
const CloudReadings = require('../../lib/cloud/CloudReadings');
const ImportToday = require('../../lib/cloud/ImportToday');
const { liveElectricityResource } = require('../../lib/cloud/resources');
const { nextTariffAt } = require('../../lib/cloud/TariffSource');
const { dayToAnnounce } = require('../../lib/cloud/newDay');
const {
  addDays, londonDate, dayLabel, dateTimeLabel,
} = require('../../lib/cloud/days');

// renew the token when less than this much of its life remains
const TOKEN_RENEW_BEFORE_MS = 24 * 60 * 60 * 1000;
// how long to wait before trying again when access is refused even after a fresh login
const ACCESS_REFUSED_RETRY_MS = 60 * 60 * 1000;
// settings that need polling restarted when they change
const POLLING_SETTINGS = ['username', 'password', 'pollFrequency'];
const MINUTE_MS = 60 * 1000;
// half-hourly readings move no faster than this on display accounts
const READINGS_EVERY_MS = 15 * MINUTE_MS;

// added to every device, including ones paired before they existed
const CAPABILITIES = ['meter_power.imported', 'standing_charge', 'electricity_today', 'electricity_yesterday', 'electricity_cost_yesterday', 'data_up_to'];
// added once the entry is known to have gas
const GAS_CAPABILITIES = ['gas_day', 'gas_day_energy', 'gas_day_cost', 'tariff.gas', 'standing_charge.gas'];
const CAPABILITY_TITLES = {
  'tariff.gas': 'Gas unit rate',
  'standing_charge.gas': 'Gas standing charge',
};

class GlowmarktUKSmartMeter_device extends Device {

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('Display and CAD (API) initialized');

    for (const capability of CAPABILITIES) await this.ensureCapability(capability);

    // shown in the Cloud section of the app settings page
    if (!this.cloudStatus) this.cloudStatus = { lastSuccessAt: null, lastError: null };

    // Set device unavailable until first successful poll
    this.setUnavailable().catch(this.error);

    // The stale clock restarts at init unless the meter was already stale, so
    // time the app spent stopped doesn't count as silence.
    const staleness = this.getStoreValue('staleness') || {};
    this.staleness = new StalenessTracker({
      staleAfterMinutes: this.getSetting('stale_after') || StalenessTracker.DEFAULT_STALE_AFTER_MINUTES,
      lastArrival: staleness.stale ? staleness.lastArrival : null,
      stale: staleness.stale,
      now: Date.now(),
    });
    this.lastPowerAt = null;
    this.exporting = new ExportingTracker(this.getStoreValue('exporting') || {});
    this.health = new AccountHealth(this.getStoreValue('accountHealth') || {});
    this.importToday = new ImportToday(this.getStoreValue('importToday') || {});
    // the last day New day's figures was fired for; undefined until the first readings poll
    this.announcedDay = this.getStoreValue('announcedDay');
    this.readings = null;
    this.readingsPromise = null;
    this.tariffResult = null;

    const settings = this.getSettings();
    if (settings.pollFrequency) {
      this.pollFrequency = (settings.pollFrequency * 1000);
      this.log(`Poll frequency read from settings as ${this.pollFrequency}`);
    } else {
      this.log('Could not get poll frequency from settings; defaulting to 10000');
      this.pollFrequency = 10000;
    }

    this.startPolling();
  }

  async ensureCapability(capability) {
    if (this.hasCapability(capability)) return;
    await this.addCapability(capability);
    if (CAPABILITY_TITLES[capability]) {
      await this.setCapabilityOptions(capability, { title: { en: CAPABILITY_TITLES[capability] } }).catch(this.error);
    }
  }

  async setIfChanged(capability, value) {
    if (!this.hasCapability(capability) || this.getCapabilityValue(capability) === value) return;
    await this.setCapabilityValue(capability, value).catch(this.error);
  }

  /**
   * Starts every poll, stopping any that are running first. The first polls
   * aren't awaited: awaiting setAvailable() inside onInit breaks the Homey
   * pairing wizard (device state must not be set before onAdded fires).
   */
  startPolling() {
    this.stopTimers();
    // stopTimers() moves this on, so a fetch still running from before a
    // restart doesn't schedule a second chain of tariff fetches
    const generation = this.pollGeneration;

    this.updateDevice();
    this.updateReadings();
    this.updateTariff().then(() => this.scheduleTariff(generation));

    this.log(`Initiating power polling with frequency ${this.pollFrequency}`);
    this.poll = this.homey.setInterval(() => this.updateDevice(), this.pollFrequency);
    this.readingsPoll = this.homey.setInterval(() => this.updateReadings(), READINGS_EVERY_MS);
    this.minuteTimer = this.homey.setInterval(() => this.everyMinute().catch(this.error), MINUTE_MS);
  }

  /** Fetches the tariff 30 s after each hour and half hour. */
  scheduleTariff(generation) {
    if (generation !== this.pollGeneration) return;
    const delay = nextTariffAt(Date.now()) - Date.now();
    this.tariffTimer = this.homey.setTimeout(() => {
      this.updateTariff().then(() => this.scheduleTariff(generation));
    }, delay);
  }

  stopTimers() {
    if (this.poll) this.homey.clearInterval(this.poll);
    if (this.readingsPoll) this.homey.clearInterval(this.readingsPoll);
    if (this.minuteTimer) this.homey.clearInterval(this.minuteTimer);
    if (this.tariffTimer) this.homey.clearTimeout(this.tariffTimer);
    this.poll = null;
    this.readingsPoll = null;
    this.minuteTimer = null;
    this.tariffTimer = null;
    this.pollGeneration = (this.pollGeneration || 0) + 1;
  }

  /**
   * Live power and the import register, every poll: measure_power,
   * meter_power.imported and Electricity today, and from them whether the
   * meter is reporting and exporting.
   */
  async updateDevice() {
    if (this.isAccessRefused()) return;
    const elec_cons_res = this.getStoreValue('elec_cons_res');
    try {
      const powerRes = await this.request(`/resource/${elec_cons_res}/current`);
      if (!powerRes.data?.[0]) throw apiError('Power API returned no data', JSON.stringify(powerRes));
      this.accessRefusedUntil = null;
      if (!this.getAvailable()) this.setAvailable().catch(this.error);
      const [readingAt, watts] = powerRes.data[0];
      this.setCapabilityValue('measure_power', watts).catch(this.error);
      await this.powerReading(readingAt, watts, Date.now());

      const energyRes = await this.request(`/resource/${elec_cons_res}/meterread`);
      if (!energyRes.data?.[0]) throw apiError('Meter read API returned no data', JSON.stringify(energyRes));
      if (!this.getAvailable()) this.setAvailable().catch(this.error);
      const [registerAt, wh] = energyRes.data[0];
      const kWh = wh / 1000;
      this.setCapabilityValue('meter_power.imported', kWh).catch(this.error);
      await this.setIfChanged('electricity_today', this.importToday.reading(registerAt * 1000, wh));
      this.cloudStatus.lastSuccessAt = Date.now();
    } catch (error) {
      this.error('updateDevice failed:', error.message);
      this.recordError('power', error);
      // an access refusal has already set the device unavailable with its own message
      if (!error.accessRefused && this.getAvailable()) {
        this.log('Device set as unavailable');
        this.setUnavailable().catch(this.error);
      }
    }
  }

  /**
   * A /current reading: the meter is reporting while its time moves on, and
   * exporting while the power stays negative.
   */
  async powerReading(readingAt, watts, now) {
    if (readingAt !== this.lastPowerAt) {
      this.lastPowerAt = readingAt;
      const resumed = this.staleness.arrived(now);
      if (resumed) {
        this.log(`Resumed reporting after ${resumed.minutesWithout} minutes`);
        await this.driver.cards.resumed.trigger(this, { minutes: resumed.minutesWithout }).catch(this.error);
      }
    }
    const change = this.exporting.power(watts, now);
    if (change) {
      this.log(`${change.event === 'started' ? 'Started' : 'Stopped'} exporting at ${change.power} W`);
      const card = change.event === 'started' ? this.driver.cards.startedExporting : this.driver.cards.stoppedExporting;
      await card.trigger(this, { power: change.power }).catch(this.error);
    }
  }

  async everyMinute() {
    const now = Date.now();
    const stopped = this.staleness.check(now);
    if (stopped) {
      this.log(`Stopped reporting: no new reading for ${stopped.minutesSince} minutes`);
      await this.driver.cards.stopped.trigger(this, { minutes: stopped.minutesSince }).catch(this.error);
    }
    await this.accountEvent(this.health.check(now));
    await this.saveState();
  }

  async accountEvent(event) {
    if (!event) return;
    this.log(`Account needs attention: ${event.reason}`);
    const reason = this.homey.__(`cloud.attention.${event.reason}`);
    await this.driver.cards.accountAttention.trigger(this, { reason }).catch(this.error);
  }

  async saveState() {
    await this.setStoreValue('staleness', this.staleness.toJSON()).catch(this.error);
    await this.setStoreValue('exporting', this.exporting.toJSON()).catch(this.error);
    await this.setStoreValue('accountHealth', this.health.toJSON()).catch(this.error);
    await this.setStoreValue('importToday', this.importToday.toJSON()).catch(this.error);
  }

  /**
   * The readings layer for this device's entry, created once its resources
   * are listed. Gas capabilities are added if the entry has gas, and a stored
   * live resource that isn't electricity.consumption is replaced.
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
    const live = liveElectricityResource(resources, this.getStoreValue('elec_cons_res'));
    if (live && live !== this.getStoreValue('elec_cons_res')) {
      this.log('Stored resource is not electricity consumption; switching to the one that is');
      await this.setStoreValue('elec_cons_res', live);
    }
    const readings = new CloudReadings({
      request: (path, options) => this.request(path, options),
      resources,
      state: this.getStoreValue('cloudReadings') || {},
    });
    if (readings.hasGas()) {
      for (const capability of GAS_CAPABILITIES) await this.ensureCapability(capability);
    }
    this.readings = readings;
    return readings;
  }

  /** Daily figures and "data up to", every 15 minutes. */
  async updateReadings() {
    if (this.isAccessRefused()) return;
    try {
      const readings = await this.loadReadings();
      const now = Date.now();
      const figures = await readings.refresh(now);

      await this.setIfChanged('data_up_to', dateTimeLabel(figures.dataUpTo['electricity.consumption']));
      // Yesterday shows only once the meter's own figures have replaced the display's.
      const yesterday = figures.electricityYesterday && figures.electricityYesterday.final ? figures.electricityYesterday : null;
      await this.setIfChanged('electricity_yesterday', yesterday ? yesterday.kWh : null);
      await this.setIfChanged('electricity_cost_yesterday', yesterday ? yesterday.pounds : null);
      if (figures.gasLatestDay) {
        await this.setIfChanged('gas_day', dayLabel(figures.gasLatestDay.date));
        await this.setIfChanged('gas_day_energy', figures.gasLatestDay.kWh);
        await this.setIfChanged('gas_day_cost', figures.gasLatestDay.pounds);
      }

      await this.announceNewDay(figures, readings.hasGas(), now);
      await this.setStoreValue('cloudReadings', readings.toJSON()).catch(this.error);
    } catch (error) {
      this.error('updateReadings failed:', error.message);
      this.recordError('readings', error);
    }
  }

  /**
   * Fires New day's figures once per day. Not on the first poll after
   * installing: a day that's already final then is recorded, not announced.
   */
  async announceNewDay(figures, hasGas, now) {
    const day = dayToAnnounce(figures, { now, hasGas, announced: this.announcedDay ?? null });
    if (this.announcedDay === undefined || this.announcedDay === null) {
      this.announcedDay = day ? day.date : addDays(londonDate(now), -2);
      await this.setStoreValue('announcedDay', this.announcedDay).catch(this.error);
      return;
    }
    if (!day) return;
    this.announcedDay = day.date;
    await this.setStoreValue('announcedDay', day.date).catch(this.error);
    this.log(`New day's figures for ${day.date}`);
    await this.driver.cards.newDay.trigger(this, day.tokens).catch(this.error);
  }

  /**
   * The electricity and gas tariffs, every half hour. Tariff changed fires on
   * any change to the electricity rate. Where the gas tariff has never
   * answered, the gas standing charge comes from the device setting.
   * The tariff doesn't control device availability: a missing or failed
   * tariff shouldn't mark the device unavailable if power is working.
   */
  async updateTariff() {
    if (this.isAccessRefused()) return;
    try {
      const readings = await this.loadReadings();
      const now = Date.now();
      const answers = await readings.fetchTariffs(now);
      this.tariffResult = { at: now, ...answers };
      await this.setStoreValue('cloudReadings', readings.toJSON()).catch(this.error);

      const electricity = readings.tariffs.electricity && readings.tariffs.electricity.last;
      if (electricity) {
        if (electricity.rate !== null) {
          const previous = this.getCapabilityValue('tariff');
          await this.setCapabilityValue('tariff', electricity.rate);
          if (previous !== null && previous !== electricity.rate) {
            this.log(`Tariff changed from ${previous} to ${electricity.rate}`);
            this.driver.tariffChangedTrigger.trigger(this, { tariff: electricity.rate }).catch(this.error);
          }
        }
        if (electricity.standingCharge !== null) await this.setIfChanged('standing_charge', electricity.standingCharge);
      }
      await this.updateGasTariff();

      if (!answers.electricity) throw apiError('No copy of the electricity resource answered /tariff');
    } catch (error) {
      this.error('updateTariff failed:', error.message);
      this.recordError('tariff', error);
    }
  }

  async updateGasTariff(setting = this.getSetting('gas_standing_charge')) {
    const { readings } = this;
    if (!readings || !readings.hasGas()) return;
    const gas = readings.tariffs.gas && readings.tariffs.gas.last;
    if (gas) {
      if (gas.rate !== null) await this.setIfChanged('tariff.gas', gas.rate);
      if (gas.standingCharge !== null) await this.setIfChanged('standing_charge.gas', gas.standingCharge);
      return;
    }
    const fallback = Number(setting);
    await this.setIfChanged('standing_charge.gas', fallback > 0 ? fallback : null);
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
      available: this.getAvailable(),
      lastSuccessAt: status.lastSuccessAt || null,
      lastError: status.lastError || null,
      accessRefusedUntil: this.isAccessRefused() ? this.accessRefusedUntil : null,
      tokenRenewsAt: expiry === null ? null : expiry - TOKEN_RENEW_BEFORE_MS,
      readings: this.readingsStatus(),
      tariff: this.tariffResult && {
        at: this.tariffResult.at,
        electricity: this.tariffResult.electricity || null,
        gas: this.tariffResult.gas === undefined ? undefined : this.tariffResult.gas || null,
      },
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

  isReporting() {
    return !this.staleness.stale;
  }

  isAccountOk() {
    return this.health.isOk();
  }

  isExporting() {
    return this.exporting.exporting;
  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log('Display and CAD (API) device added');
  }

  /**
   * onSettings is called when the user updates the device's settings.
   * @param {object} event the onSettings event data
   * @param {object} event.oldSettings The old settings object
   * @param {object} event.newSettings The new settings object
   * @param {string[]} event.changedKeys An array of keys changed since the previous version
   * @returns {Promise<string|void>} return a custom message that will be displayed
   */
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Display and CAD (API) settings changed');

    // if username or password changed, get new token from API and write it to token in device store
    if (changedKeys.includes('username') || changedKeys.includes('password')) {
      this.log('Credentials changed - getting new token from API');
      const token = await this.driver.login(newSettings.username, newSettings.password);
      await this.setStoreValue('token', token || 'VOID');
      this.accessRefusedUntil = null;
    }

    // if poll frequency changed, update variable
    if (changedKeys.includes('pollFrequency')) {
      this.pollFrequency = (newSettings.pollFrequency * 1000);
    }

    if (changedKeys.includes('stale_after')) {
      this.staleness.setStaleAfter(newSettings.stale_after);
      // Apply the new limit straight away rather than at the next minute.
      this.homey.setTimeout(() => this.everyMinute().catch(this.error), 0);
    }

    if (changedKeys.includes('gas_standing_charge')) {
      await this.updateGasTariff(newSettings.gas_standing_charge);
    }

    // restart polling only for the settings it depends on, so it starts afresh
    // with the new login or frequency
    if (POLLING_SETTINGS.some((key) => changedKeys.includes(key))) {
      this.log('Restarting polling');
      this.startPolling();
    }
  }

  /**
   * onRenamed is called when the user updates the device's name.
   * @param {string} name The new name
   */
  async onRenamed(name) {
    this.log('Display and CAD (API) was renamed');
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    this.log('Display and CAD (API) has been deleted');
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

module.exports = GlowmarktUKSmartMeter_device;
