'use strict';

const LocalMeterDriver = require('../../lib/glow/LocalMeterDriver');

class GlowLocalElectricityDriver extends LocalMeterDriver {

  get kind() {
    return 'electricitymeter';
  }

  async onInit() {
    await super.onInit();
    this.homey.flow.getConditionCard(`${this.id}_is_exporting`)
      .registerRunListener(({ device }) => device.isExporting());
  }

}

module.exports = GlowLocalElectricityDriver;
