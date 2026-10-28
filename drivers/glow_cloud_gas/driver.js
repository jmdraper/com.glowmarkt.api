'use strict';

const CloudDriver = require('../../lib/cloud/CloudDriver');
const { apiGet } = require('../../lib/cloud/glowmarkt');
const { copiesOf, lastTimeOf } = require('../../lib/cloud/resources');

class GlowCloudGasDriver extends CloudDriver {

  async onInit() {
    await super.onInit();
    this.kind = 'gas';
    this.registerCards('cloud_gas_', {
      newDay: 'new_day_figures',
      dataLate: 'data_late',
      accountAttention: 'account_attention',
    }, {
      up_to_date: (device) => device.isUpToDate(),
      account_ok: (device) => device.isAccountOk(),
    });
  }

  /**
   * Returns a pairing entry for a virtual entity with gas that Glowmarkt has
   * data for, or { skipped: reason }. /current isn't needed: gas comes in
   * whole days, with or without a display.
   */
  async entryToDevice(virtualEntity, resources, token, settings) {
    const copies = copiesOf(resources, 'gas.consumption');
    if (!copies.length) {
      this.log(`Skipping virtual entity ${virtualEntity.name}: no gas consumption resource`);
      return { skipped: { code: 'no_gas' } };
    }

    const answers = await Promise.all(copies.map((id) => apiGet(`/resource/${id}/last-time`, token)));
    if (!answers.some((answer) => answer.ok && lastTimeOf(answer.body) !== null)) {
      const { status } = answers[0];
      this.log(`Skipping virtual entity ${virtualEntity.name}: its gas resource returned HTTP ${status}`);
      return { skipped: { code: 'read_failed', status } };
    }

    return {
      name: `${virtualEntity.name} gas for ${virtualEntity.postalCode}`,
      data: { id: virtualEntity.veId },
      settings,
      store: { token },
    };
  }

}

module.exports = GlowCloudGasDriver;
