'use strict';

const LocalMeterDevice = require('../../lib/glow/LocalMeterDevice');
const ExportingTracker = require('../../lib/ExportingTracker');

class GlowLocalElectricityDevice extends LocalMeterDevice {

  async onInit() {
    // the held exporting state, kept so a restart doesn't announce a change that didn't happen
    this.exporting = new ExportingTracker(this.getStoreValue('exporting') || {});
    await super.onInit();
    this.cards.startedExporting = this.homey.flow.getDeviceTriggerCard(`${this.driver.id}_started_exporting`);
    this.cards.stoppedExporting = this.homey.flow.getDeviceTriggerCard(`${this.driver.id}_stopped_exporting`);
  }

  /**
   * Power is signed: negative while exporting. The totals feed Homey Energy as
   * a cumulative whole-home meter.
   */
  async applyFields(accepted) {
    if (accepted.powerKw !== undefined) {
      const watts = Math.round(accepted.powerKw * 1000);
      await this.setIfChanged('measure_power', watts);
      await this.applyExporting(watts);
    }
    if (accepted.importKwh !== undefined) await this.setIfChanged('meter_power.imported', accepted.importKwh);
    if (accepted.exportKwh !== undefined) await this.setIfChanged('meter_power.exported', accepted.exportKwh);
  }

  /** Started or Stopped exporting, once power has been on the other side of zero for a minute. */
  async applyExporting(watts) {
    const change = this.exporting.power(watts, Date.now());
    if (!change) return;
    this.log(`${change.event === 'started' ? 'Started' : 'Stopped'} exporting at ${change.power} W`);
    await this.setStoreValue('exporting', this.exporting.toJSON()).catch(this.error);
    const card = change.event === 'started' ? this.cards.startedExporting : this.cards.stoppedExporting;
    await card.trigger(this, { power: change.power }).catch(this.error);
  }

  // For the Is exporting condition.
  isExporting() {
    return this.exporting.exporting;
  }

}

module.exports = GlowLocalElectricityDevice;
