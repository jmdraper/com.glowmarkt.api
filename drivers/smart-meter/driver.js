'use strict';

const CloudDriver = require('../../lib/cloud/CloudDriver');
const { apiGet } = require('../../lib/cloud/glowmarkt');
const { liveElectricityResource } = require('../../lib/cloud/resources');

class GlowmarktUKSmartMeter_driver extends CloudDriver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    await super.onInit();
    this.log('Glowmarkt UK Smart Meter driver has been initialized');
    this.kind = 'electricity';
    this.tariffChangedTrigger = this.homey.flow.getDeviceTriggerCard('tariff_changed');
    this.registerCards('cloud_', {
      stopped: 'stopped_reporting',
      resumed: 'resumed_reporting',
      accountAttention: 'account_attention',
      startedExporting: 'started_exporting',
      stoppedExporting: 'stopped_exporting',
      newDay: 'new_day_figures',
    }, {
      is_reporting: (device) => device.isReporting(),
      account_ok: (device) => device.isAccountOk(),
      is_exporting: (device) => device.isExporting(),
    });
  }

  /**
   * Returns a pairing entry for a virtual entity with a live electricity
   * reading, or { skipped: reason }. A stale entity lists its resources
   * normally but returns HTTP 401 on /current.
   */
  async entryToDevice(virtualEntity, resources, token, settings) {
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
