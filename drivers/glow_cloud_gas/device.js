'use strict';

const CloudDevice = require('../../lib/cloud/CloudDevice');
const { apiError } = require('../../lib/cloud/glowmarkt');
const { gasDaysToAnnounce } = require('../../lib/cloud/newDay');
const { DAY_MS, dayLabel, dateTimeLabel } = require('../../lib/cloud/days');

// Gas comes in whole days, so hourly is plenty.
const READINGS_EVERY_MS = 60 * 60 * 1000;
// "data up to" older than this is late
const LATE_AFTER_DAYS = 3;

/**
 * Gas from the Glowmarkt cloud: the latest complete day with its cost, the
 * tariff, and a card for each day as it arrives. Gas reaches Glowmarkt from
 * the DCC in whole days, a day or more late, with or without a display, so
 * there's nothing live and nothing for Homey Energy.
 */
class GlowCloudGasDevice extends CloudDevice {

  async onInit() {
    this.log('Gas meter (cloud) initialized');
    this.commodity = 'gas';
    this.setUpCloud();
    // the last day New day's figures was fired for; undefined until the first readings poll
    this.announcedDay = this.getStoreValue('announcedDay');
    this.late = Boolean(this.getStoreValue('late'));
    this.startPolling();
  }

  startPolling() {
    this.stopTimers();
    this.event('Polling started');
    this.updateReadings();
    this.startTariff();
    this.every(() => this.updateReadings(), READINGS_EVERY_MS);
  }

  async updateReadings() {
    if (this.isAccessRefused()) return;
    try {
      const readings = await this.loadReadings();
      const now = Date.now();
      const figures = await readings.refresh(now);
      if (!this.getAvailable()) this.setAvailable().catch(this.error);

      const lastTime = figures.dataUpTo['gas.consumption'];
      await this.setIfChanged('data_up_to', dateTimeLabel(lastTime));
      const day = figures.gasLatestDay;
      if (day) {
        await this.setIfChanged('gas_day', dayLabel(day.date));
        await this.setIfChanged('gas_day_energy', day.kWh);
        await this.setIfChanged('gas_day_cost', day.pounds);
      }

      await this.checkLate(lastTime, now);
      await this.announceNewDays(readings, day);
      await this.saveReadings();
      await this.saveState();
      this.cloudStatus.lastSuccessAt = now;
    } catch (error) {
      this.error('updateReadings failed:', error.message);
      this.recordError('readings', error);
    }
  }

  /** Data is late fires once when "data up to" passes 3 days old, and again only after it catches up. */
  async checkLate(lastTime, now) {
    if (!Number.isFinite(lastTime)) return;
    const daysBehind = Math.floor((now - lastTime) / DAY_MS);
    const late = now - lastTime > LATE_AFTER_DAYS * DAY_MS;
    if (late && !this.late) {
      this.event(`Data is late: ${daysBehind} days behind`);
      await this.driver.cards.dataLate.trigger(this, { days: daysBehind }).catch(this.error);
    }
    if (late !== this.late) {
      this.late = late;
      await this.setStoreValue('late', late).catch(this.error);
    }
  }

  /**
   * Fires New day's figures for each complete day since the last one
   * announced, oldest first. Not on the first poll after installing: the
   * latest day then is recorded, not announced.
   */
  async announceNewDays(readings, latest) {
    if (this.announcedDay === undefined) {
      this.announcedDay = latest ? latest.date : null;
      await this.setStoreValue('announcedDay', this.announcedDay).catch(this.error);
      return;
    }
    if (!latest) return;
    // With nothing announced yet, start from the latest day rather than catching up.
    const dates = this.announcedDay === null ? [latest.date] : gasDaysToAnnounce(latest.date, this.announcedDay);
    for (const date of dates) {
      const day = date === latest.date ? latest : await readings.gasDay(date);
      if (!day) break;
      this.announcedDay = date;
      await this.setStoreValue('announcedDay', date).catch(this.error);
      this.event(`New day's figures for ${dayLabel(date)}: ${day.kWh} kWh, £${day.pounds ?? 0}`);
      await this.driver.cards.newDay.trigger(this, {
        date: dayLabel(date), gas_kwh: day.kWh, gas_cost: day.pounds ?? 0,
      }).catch(this.error);
    }
  }

  /**
   * The gas tariff, every half hour. If it has never answered, the standing
   * charge comes from the device setting.
   */
  async updateTariff() {
    if (this.isAccessRefused()) return;
    try {
      const readings = await this.loadReadings();
      const now = Date.now();
      const answers = await readings.fetchTariffs(now);
      this.tariffResult = { at: now, ...answers };
      this.tariffEvents('gas');
      await this.saveReadings();
      await this.showTariff();
      if (!answers.gas) throw apiError('No copy of the gas resource answered /tariff');
    } catch (error) {
      this.error('updateTariff failed:', error.message);
      this.recordError('tariff', error);
    }
  }

  async showTariff(setting = this.getSetting('gas_standing_charge')) {
    const source = this.readings && this.readings.tariffs.gas;
    const last = source && source.last;
    if (last) {
      if (last.rate !== null) await this.setIfChanged('tariff', last.rate);
      if (last.standingCharge !== null) await this.setIfChanged('standing_charge', last.standingCharge);
      return;
    }
    const fallback = Number(setting);
    await this.setIfChanged('standing_charge', fallback > 0 ? fallback : null);
  }

  isUpToDate() {
    return !this.late;
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('username') || changedKeys.includes('password')) {
      await this.applyCredentials(newSettings);
      this.startPolling();
    }
    if (changedKeys.includes('gas_standing_charge')) await this.showTariff(newSettings.gas_standing_charge);
  }

  async onDeleted() {
    this.log('Gas meter (cloud) has been deleted');
    await super.onDeleted();
  }

}

module.exports = GlowCloudGasDevice;
