'use strict';

// Whether a meter is exporting, from its signed power (negative while
// exporting), held for a minute so a passing cloud or kettle doesn't flip it.
// Shared by the cloud display device and, once build 14 is live, the local
// electricity device. Pure: the caller passes each reading's time and stores
// toJSON() so a restart doesn't announce a change that didn't happen.

const HOLD_MS = 60 * 1000;

class ExportingTracker {

  constructor({ exporting = false, holdMs = HOLD_MS } = {}) {
    this.exporting = Boolean(exporting);
    this.holdMs = holdMs;
    // when the power first disagreed with the held state, or null
    this.changingSince = null;
  }

  /**
   * Records a power reading in W at `now`. Returns { event: 'started' |
   * 'stopped', power } once the power has been on the other side of zero for
   * the whole hold, otherwise null.
   */
  power(watts, now) {
    if (!Number.isFinite(watts)) return null;
    if ((watts < 0) === this.exporting) {
      this.changingSince = null;
      return null;
    }
    if (this.changingSince === null) this.changingSince = now;
    if (now - this.changingSince < this.holdMs) return null;
    this.exporting = !this.exporting;
    this.changingSince = null;
    return { event: this.exporting ? 'started' : 'stopped', power: watts };
  }

  toJSON() {
    return { exporting: this.exporting };
  }

}

module.exports = ExportingTracker;
