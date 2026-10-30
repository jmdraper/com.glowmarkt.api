'use strict';

const CloudDevice = require('../../lib/cloud/CloudDevice');
const { apiError } = require('../../lib/cloud/glowmarkt');
const StalenessTracker = require('../../lib/glow/StalenessTracker');
const ExportingTracker = require('../../lib/ExportingTracker');
const ImportToday = require('../../lib/cloud/ImportToday');
const { liveElectricityResource } = require('../../lib/cloud/resources');
const { electricityDayToAnnounce } = require('../../lib/cloud/newDay');
const {
  addDays, londonDate, dayLabel, dateTimeLabel,
} = require('../../lib/cloud/days');

// settings that need polling restarted when they change
const POLLING_SETTINGS = ['username', 'password', 'pollFrequency'];
const MINUTE_MS = 60 * 1000;
// half-hourly readings move no faster than this on display accounts
const READINGS_EVERY_MS = 15 * MINUTE_MS;

// added to every device, including ones paired before they existed
const CAPABILITIES = ['meter_power.imported', 'standing_charge', 'electricity_today', 'electricity_yesterday', 'electricity_cost_yesterday', 'data_up_to'];
// gas moved to the cloud gas device before 1.3.0 was published; only test installs have these
const REMOVED_CAPABILITIES = ['gas_day', 'gas_day_energy', 'gas_day_cost', 'tariff.gas', 'standing_charge.gas'];

class GlowmarktUKSmartMeter_device extends CloudDevice {

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('Electricity meter (cloud) initialized');
    this.commodity = 'electricity';

    for (const capability of CAPABILITIES) await this.ensureCapability(capability);
    for (const capability of REMOVED_CAPABILITIES) {
      if (this.hasCapability(capability)) await this.removeCapability(capability).catch(this.error);
    }

    this.setUpCloud();

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
    this.importToday = new ImportToday(this.getStoreValue('importToday') || {});
    // the last day New day's figures was fired for; undefined until the first readings poll
    this.announcedDay = this.getStoreValue('announcedDay');

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

  /**
   * Starts every poll, stopping any that are running first. The first polls
   * aren't awaited: awaiting setAvailable() inside onInit breaks the Homey
   * pairing wizard (device state must not be set before onAdded fires).
   */
  startPolling() {
    this.stopTimers();
    this.updateDevice();
    this.updateReadings();
    this.startTariff();

    this.event(`Polling started, power every ${this.pollFrequency / 1000} s`);
    this.every(() => this.updateDevice(), this.pollFrequency);
    this.every(() => this.updateReadings(), READINGS_EVERY_MS);
    this.every(() => this.everyMinute().catch(this.error), MINUTE_MS);
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
      await this.setIfChanged('electricity_today', this.importToday.reading(registerAt * 1000, wh, this.pollFrequency));
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
        this.event(`Resumed reporting after ${resumed.minutesWithout} minutes`);
        await this.driver.cards.resumed.trigger(this, { minutes: resumed.minutesWithout }).catch(this.error);
      }
    }
    const change = this.exporting.power(watts, now);
    if (change) {
      this.event(`${change.event === 'started' ? 'Started' : 'Stopped'} exporting at ${change.power} W`);
      const card = change.event === 'started' ? this.driver.cards.startedExporting : this.driver.cards.stoppedExporting;
      await card.trigger(this, { power: change.power }).catch(this.error);
    }
  }

  async everyMinute() {
    const now = Date.now();
    const stopped = this.staleness.check(now);
    if (stopped) {
      this.event(`Stopped reporting: no new reading for ${stopped.minutesSince} minutes`);
      await this.driver.cards.stopped.trigger(this, { minutes: stopped.minutesSince }).catch(this.error);
    }
    await this.accountEvent(this.health.check(now));
    await this.saveState();
  }

  async saveState() {
    await super.saveState();
    if (this.staleness) await this.setStoreValue('staleness', this.staleness.toJSON()).catch(this.error);
    if (this.exporting) await this.setStoreValue('exporting', this.exporting.toJSON()).catch(this.error);
    if (this.importToday) await this.setStoreValue('importToday', this.importToday.toJSON()).catch(this.error);
  }

  /** A stored live resource that isn't electricity.consumption is replaced. */
  async onResources(resources) {
    const live = liveElectricityResource(resources, this.getStoreValue('elec_cons_res'));
    if (live && live !== this.getStoreValue('elec_cons_res')) {
      this.event('The stored resource is not electricity consumption, so switching to the one that is');
      await this.setStoreValue('elec_cons_res', live);
    }
  }

  /** Yesterday's figures and "data up to", every 15 minutes. */
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
      this.noteEnergyOnlyCost(yesterday);

      await this.announceNewDay(figures, now);
      await this.saveReadings();
    } catch (error) {
      this.error('updateReadings failed:', error.message);
      this.recordError('readings', error);
    }
  }

  /**
   * Fires New day's figures once per day. Not on the first poll after
   * installing: a day that's already final then is recorded, not announced.
   */
  async announceNewDay(figures, now) {
    const day = electricityDayToAnnounce(figures, this.announcedDay ?? null);
    if (this.announcedDay === undefined || this.announcedDay === null) {
      this.announcedDay = day ? day.date : addDays(londonDate(now), -2);
      await this.setStoreValue('announcedDay', this.announcedDay).catch(this.error);
      return;
    }
    if (!day) return;
    this.announcedDay = day.date;
    await this.setStoreValue('announcedDay', day.date).catch(this.error);
    this.event(`New day's figures for ${dayLabel(day.date)}: ${day.kWh} kWh, £${day.pounds ?? 0}`);
    await this.driver.cards.newDay.trigger(this, {
      date: dayLabel(day.date), electricity_kwh: day.kWh, electricity_cost: day.pounds ?? 0,
    }).catch(this.error);
  }

  /**
   * The electricity tariff, every half hour. Tariff changed fires on any change
   * to the rate. The tariff doesn't control device availability: a missing or
   * failed tariff shouldn't mark the device unavailable if power is working.
   */
  async updateTariff() {
    if (this.isAccessRefused()) return;
    try {
      const readings = await this.loadReadings();
      const now = Date.now();
      const answers = await readings.fetchTariffs(now);
      this.tariffResult = { at: now, ...answers };
      this.tariffEvents('electricity');
      await this.saveReadings();

      const electricity = readings.tariffs.electricity && readings.tariffs.electricity.last;
      if (electricity) {
        if (electricity.rate !== null) {
          const previous = this.getCapabilityValue('tariff');
          await this.setCapabilityValue('tariff', electricity.rate);
          if (previous !== null && previous !== electricity.rate) {
            this.event(`Tariff changed from ${previous} to ${electricity.rate} p/kWh`);
            this.driver.tariffChangedTrigger.trigger(this, { tariff: electricity.rate }).catch(this.error);
          }
        }
        if (electricity.standingCharge !== null) await this.setIfChanged('standing_charge', electricity.standingCharge);
      }
      if (!answers.electricity) throw apiError('No copy of the electricity resource answered /tariff');
    } catch (error) {
      this.error('updateTariff failed:', error.message);
      this.recordError('tariff', error);
    }
  }

  isReporting() {
    return !this.staleness.stale;
  }

  isExporting() {
    return this.exporting.exporting;
  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log('Electricity meter (cloud) added');
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
    this.log('Electricity meter (cloud) settings changed');

    // if username or password changed, get new token from API and write it to token in device store
    if (changedKeys.includes('username') || changedKeys.includes('password')) await this.applyCredentials(newSettings);

    // if poll frequency changed, update variable
    if (changedKeys.includes('pollFrequency')) {
      this.pollFrequency = (newSettings.pollFrequency * 1000);
    }

    if (changedKeys.includes('stale_after')) {
      this.staleness.setStaleAfter(newSettings.stale_after);
      // Apply the new limit straight away rather than at the next minute.
      this.homey.setTimeout(() => this.everyMinute().catch(this.error), 0);
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
    this.log('Electricity meter (cloud) was renamed');
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    this.log('Electricity meter (cloud) has been deleted');
    await super.onDeleted();
  }
}

module.exports = GlowmarktUKSmartMeter_device;
