'use strict';

// Electricity imported today, from the meter's import register (/meterread):
// the register now minus the register at London midnight. It's live and
// import-only, unlike today's half-hourly readings, which are net of export
// until the DCC's data replaces them.
//
// The midnight register is the first reading of the day, used only if the
// reading before it was from the previous day and close to midnight, so
// polling ran across midnight. Otherwise, as after installing or with Homey
// off overnight, today is unknown until the next midnight. Pure: the caller
// passes each reading's time and stores toJSON() between restarts.

const { londonDate, londonMidnight } = require('./days');
const { round } = require('./readings');

// The longest gap before midnight that still counts as polling across it:
// 15 minutes, or a minute more than the poll interval if that's longer.
const MAX_GAP_MS = 15 * 60 * 1000;
const POLL_MARGIN_MS = 60 * 1000;

class ImportToday {

  constructor({
    date = null, midnightWh = null, lastAt = null, lastWh = null,
  } = {}) {
    Object.assign(this, {
      date, midnightWh, lastAt, lastWh,
    });
  }

  /**
   * Records a register reading in Wh, taken at `at` (ms), by polling every
   * `pollMs`. Returns kWh imported today, or null if that's not known.
   */
  reading(at, wh, pollMs = 0) {
    if (!Number.isFinite(at) || !Number.isFinite(wh) || (this.lastAt !== null && at < this.lastAt)) return this.kWh();
    const date = londonDate(at);
    if (date !== this.date) {
      const midnight = londonMidnight(date);
      const maxGap = Math.max(MAX_GAP_MS, pollMs + POLL_MARGIN_MS);
      const acrossMidnight = this.lastAt !== null && this.lastAt < midnight && midnight - this.lastAt <= maxGap;
      this.date = date;
      this.midnightWh = acrossMidnight ? wh : null;
    } else if (this.lastWh !== null && wh < this.lastWh) {
      // The register went backwards, as when a meter is exchanged.
      this.midnightWh = null;
    }
    this.lastAt = at;
    this.lastWh = wh;
    return this.kWh();
  }

  kWh() {
    return this.midnightWh === null ? null : round((this.lastWh - this.midnightWh) / 1000, 3);
  }

  toJSON() {
    return {
      date: this.date, midnightWh: this.midnightWh, lastAt: this.lastAt, lastWh: this.lastWh,
    };
  }

}

module.exports = ImportToday;
