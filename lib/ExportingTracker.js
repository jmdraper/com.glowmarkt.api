'use strict';

// Whether a meter is exporting, from its signed power (negative while
// exporting), held for a minute so a passing cloud or kettle doesn't flip it.
// Exporting starts below -50 W and stops above -20 W, so a grid hovering just
// below zero (a battery covering the house) can neither start it nor keep it
// going: in Jon's home, 29 Oct 18:13 sat at -5 to -21 W for over a minute,
// and on 30 Oct a few watts below zero after the export held off the stop
// for 11 minutes.
// Shared by the cloud display device and the local electricity device. Pure:
// the caller passes each reading's time and stores toJSON() so a restart
// doesn't announce a change that didn't happen.

const HOLD_MS = 60 * 1000;
const START_BELOW_W = -50;
const STOP_ABOVE_W = -20;

class ExportingTracker {

  constructor({ exporting = false, holdMs = HOLD_MS } = {}) {
    this.exporting = Boolean(exporting);
    this.holdMs = holdMs;
    // when the power first disagreed with the held state, or null
    this.changingSince = null;
  }

  /**
   * Records a power reading in W at `now`. Returns { event: 'started' |
   * 'stopped', power } once the power has been past the threshold for the
   * whole hold (below -50 W to start, above -20 W to stop), otherwise null.
   */
  power(watts, now) {
    if (!Number.isFinite(watts)) return null;
    const changing = this.exporting ? watts > STOP_ABOVE_W : watts < START_BELOW_W;
    if (!changing) {
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
