'use strict';

// Fetches the tariff for one commodity (electricity or gas) from whichever
// copy of its consumption resource answers. /tariff on some copies hangs until
// the server cuts it off after about 30 s, some days on every call: a copy
// that times out or is cut off isn't asked again that London day. Other
// failures only end that attempt. The last good answer is kept, and the
// standing charge last given on each London day, for that day's cost; a day
// with no answer takes the charge either side if they agree.
//
// Fetched every half hour, just after the hour and half hour, since
// time-of-use bands change on half hours.

const { isSlowFailure } = require('./glowmarkt');
const { HALF_HOUR_MS, londonDate } = require('./days');

const TARIFF_TIMEOUT_MS = 35 * 1000;
// days of standing charges kept, enough for gas that arrives days late
const STANDING_CHARGE_DAYS = 14;
const AFTER_HALF_HOUR_MS = 30 * 1000;

/** The unit rate (p/kWh) and standing charge (p/day) in a /tariff response, or null. */
function parseTariff(body) {
  const rates = body && Array.isArray(body.data) && body.data[0] && body.data[0].currentRates;
  const rate = Number(rates && rates.rate);
  const standingCharge = Number(rates && rates.standingCharge);
  if (!rates || (!Number.isFinite(rate) && !Number.isFinite(standingCharge))) return null;
  return {
    rate: Number.isFinite(rate) ? rate : null,
    standingCharge: Number.isFinite(standingCharge) ? standingCharge : null,
  };
}

/** When to fetch next: 30 s after the next hour or half hour. */
function nextTariffAt(now) {
  return Math.floor((now - AFTER_HALF_HOUR_MS) / HALF_HOUR_MS) * HALF_HOUR_MS + HALF_HOUR_MS + AFTER_HALF_HOUR_MS;
}

class TariffSource {

  /**
   * `copies` are the commodity's consumption resource IDs in the order the
   * entry lists them. The rest can be restored from toJSON().
   */
  constructor({
    copies, preferred = null, slowOn = {}, last = null, standingCharges = {},
  }) {
    this.copies = copies;
    this.preferred = copies.includes(preferred) ? preferred : null;
    this.slowOn = { ...slowOn };
    this.last = last;
    // { date: p/day }, the last standing charge given on each London day
    this.standingCharges = { ...standingCharges };
  }

  /**
   * The standing charge (p/day) for a London day: the last one given that
   * day, or if none was (every request timed out, say), the one either side
   * when the last day before and the first day after with one agree. Null
   * otherwise, including when the charge changed across the gap.
   */
  standingChargeOn(date) {
    if (date in this.standingCharges) return this.standingCharges[date];
    const dates = Object.keys(this.standingCharges).sort();
    const before = dates.filter((d) => d < date).pop();
    const after = dates.find((d) => d > date);
    if (!before || !after || this.standingCharges[before] !== this.standingCharges[after]) return null;
    return this.standingCharges[before];
  }

  /** Copies to try, in order: the one that last answered first, leaving out any that timed out today. */
  candidates(now) {
    const today = londonDate(now);
    const ordered = this.preferred ? [this.preferred, ...this.copies.filter((id) => id !== this.preferred)] : this.copies;
    return ordered.filter((id) => this.slowOn[id] !== today);
  }

  /**
   * Asks each candidate in turn until one answers, using `request(path,
   * options)`, which returns a response body or throws. Returns the rates, or
   * null if no copy answered; `last` keeps the last good rates either way.
   * `attempts` describes this fetch's requests, as { id, outcome, ms, rates,
   * error } with outcome 'answered', 'no_rates', 'slow' or 'failed'.
   */
  async fetch(request, now) {
    this.attempts = [];
    for (const id of this.candidates(now)) {
      const started = Date.now();
      try {
        const rates = parseTariff(await request(`/resource/${id}/tariff`, { timeoutMs: TARIFF_TIMEOUT_MS }));
        if (!rates) {
          this.attempts.push({ id, outcome: 'no_rates', ms: Date.now() - started });
          continue;
        }
        this.attempts.push({ id, outcome: 'answered', ms: Date.now() - started, rates });
        this.preferred = id;
        this.last = { ...rates, at: now };
        if (rates.standingCharge !== null) this.recordStandingCharge(londonDate(now), rates.standingCharge);
        return rates;
      } catch (error) {
        const slow = isSlowFailure(error);
        this.attempts.push({ id, outcome: slow ? 'slow' : 'failed', ms: Date.now() - started, error });
        if (slow) this.slowOn[id] = londonDate(now);
      }
    }
    return null;
  }

  recordStandingCharge(date, standingCharge) {
    this.standingCharges[date] = standingCharge;
    const dates = Object.keys(this.standingCharges).sort();
    for (const old of dates.slice(0, -STANDING_CHARGE_DAYS)) delete this.standingCharges[old];
  }

  toJSON() {
    return {
      preferred: this.preferred, slowOn: this.slowOn, last: this.last, standingCharges: this.standingCharges,
    };
  }

}

module.exports = {
  TariffSource, parseTariff, nextTariffAt, TARIFF_TIMEOUT_MS,
};
