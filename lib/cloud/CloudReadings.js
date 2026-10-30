'use strict';

// What the cloud devices read for one account entry, beyond live power: which
// copy of each resource to use, "data up to" times, daily figures and the
// tariffs. Built on a `request(path, options)` function that returns a
// response body or throws, such as the device's request() with its shared
// login, token renewal and 401 back-off. State that should survive a restart
// comes back from toJSON().

const {
  londonDate, addDays, halfHoursIn, readingsQueries,
} = require('./days');
const {
  lastTimeOf, copiesOf, selectResources, isDeadEntry,
} = require('./resources');
const {
  readingRows, latestCompleteDay, dayTotal, isFinalDay, gasDayFinality, round, pounds,
} = require('./readings');
const { TariffSource } = require('./TariffSource');

// the classifiers read for daily figures and "data up to", by commodity
const CLASSIFIERS = {
  electricity: ['electricity.consumption', 'electricity.consumption.cost', 'electricity.export'],
  gas: ['gas.consumption', 'gas.consumption.cost'],
};

/**
 * A day's cost in £: the energy cost from Glowmarkt plus the day's standing
 * charge, or the energy cost alone if the standing charge isn't known. Null
 * without a complete energy cost.
 */
function dayCost(cost, standingCharge) {
  if (!cost || !cost.complete) return null;
  return pounds(cost.total + (standingCharge ?? 0));
}

class CloudReadings {

  /**
   * `resources` are the entry's resources from /virtualentity/{veId}/resources.
   * `commodity` ('electricity' or 'gas') limits it to one; by default it reads both.
   */
  constructor({
    request, resources, state = {}, commodity = null,
  }) {
    this.request = request;
    const commodities = commodity ? [commodity] : Object.keys(CLASSIFIERS);
    const classifiers = commodities.flatMap((c) => CLASSIFIERS[c]);
    this.resources = resources.filter((resource) => classifiers.includes(resource.classifier));
    this.stored = state.selected || {};
    this.selectedOn = state.selectedOn || null;
    this.selected = null;
    // the latest gas day's last half hour as last seen, { date, last, at }, for gasDayFinality()
    this.gasSeen = state.gasSeen || null;
    // true once a full check found every resource refused (HTTP 401)
    this.dead = false;
    this.tariffs = {};
    for (const c of commodities) {
      const copies = copiesOf(resources, `${c}.consumption`);
      if (copies.length) this.tariffs[c] = new TariffSource({ copies, ...(state.tariffs || {})[c] });
    }
  }

  hasGas() {
    return this.resources.some((resource) => resource.classifier === 'gas.consumption');
  }

  hasElectricity() {
    return this.resources.some((resource) => resource.classifier === 'electricity.consumption');
  }

  /**
   * /last-time for each resource ID, in ms, or null where it failed. Also
   * returns each call's HTTP status (200, or the failure's status if it had one).
   */
  async lastTimes(ids) {
    const results = await Promise.all(ids.map((id) => this.request(`/resource/${id}/last-time`)
      .then((body) => ({ time: lastTimeOf(body), status: 200 }), (error) => ({ time: null, status: error.status ?? null }))));
    const times = new Map(ids.map((id, i) => [id, results[i].time]));
    return Object.assign(times, { statuses: results.map(({ status }) => status) });
  }

  /**
   * Chooses the copy of each classifier to read, once a London day, and
   * returns { classifier: { resourceId, lastTime } }. Between choices, only the
   * chosen copies are asked for /last-time.
   */
  async select(now) {
    const today = londonDate(now);
    if (this.selected && this.selectedOn === today) {
      const ids = Object.values(this.selected).map(({ resourceId }) => resourceId);
      const times = await this.lastTimes(ids);
      for (const choice of Object.values(this.selected)) choice.lastTime = times.get(choice.resourceId);
      return this.selected;
    }
    const times = await this.lastTimes(this.resources.map((resource) => resource.resourceId));
    this.dead = isDeadEntry(times.statuses);
    this.selected = selectResources(this.resources, times, this.stored);
    this.stored = Object.fromEntries(Object.entries(this.selected).map(([classifier, { resourceId }]) => [classifier, resourceId]));
    this.selectedOn = today;
    return this.selected;
  }

  /** One London day's total for a chosen classifier, or null if it can't be read. */
  async day(classifier, date) {
    const choice = this.selected && this.selected[classifier];
    if (!choice || choice.lastTime === null) return null;
    const rows = [];
    for (const query of readingsQueries(date, date)) {
      rows.push(...readingRows(await this.request(`/resource/${choice.resourceId}/readings?${new URLSearchParams(query)}`)));
    }
    return dayTotal(rows, date, choice.lastTime);
  }

  /**
   * Daily figures, for the readings poll:
   * - dataUpTo: { classifier: ms or null } for each chosen classifier
   * - electricityYesterday: { date, kWh, pounds, standingCharge, final }, or
   *   null if unknown
   * - gasLatestDay: { date, kWh, pounds, standingCharge } for the latest final
   *   gas day, or null without gas or a gas /last-time
   * `pounds` includes the day's standing charge, which is null if it isn't
   * known; `pounds` is then the energy cost alone.
   */
  async refresh(now) {
    const selected = await this.select(now);
    const dataUpTo = Object.fromEntries(Object.entries(selected).map(([classifier, { lastTime }]) => [classifier, lastTime]));

    const yesterday = addDays(londonDate(now), -1);
    const [energy, cost] = this.hasElectricity() ? await Promise.all([
      this.day('electricity.consumption', yesterday), this.day('electricity.consumption.cost', yesterday),
    ]) : [null, null];
    const standingCharge = this.standingChargeOn('electricity', yesterday);
    const electricityYesterday = energy && energy.complete ? {
      date: yesterday,
      kWh: round(energy.total, 3),
      pounds: dayCost(cost, standingCharge),
      standingCharge,
      final: isFinalDay(energy),
    } : null;

    const gasLatestDay = this.hasGas() ? await this.latestGasDay(dataUpTo['gas.consumption'], now) : null;

    return { dataUpTo, electricityYesterday, gasLatestDay };
  }

  /**
   * The latest complete gas day if it's final (see gasDayFinality()), else
   * the day before, as gasDay() gives it.
   */
  async latestGasDay(lastTime, now) {
    const date = latestCompleteDay(lastTime);
    if (!date) return null;
    const totals = await this.gasTotals(date);
    if (!totals.gas) return null;
    const { final, seen } = gasDayFinality(totals.gas, lastTime, now, this.gasSeen);
    this.gasSeen = seen;
    return final ? this.gasFigures(totals) : this.gasDay(addDays(date, -1));
  }

  /**
   * { date, kWh, pounds, standingCharge } for a gas day with every half hour
   * in, or null if it can't be read. For a day before the latest, which the
   * data runs past.
   */
  async gasDay(date) {
    const totals = await this.gasTotals(date);
    if (!totals.gas || !totals.gas.complete || totals.gas.halfHours !== halfHoursIn(date)) return null;
    return this.gasFigures(totals);
  }

  gasFigures({ gas, cost }) {
    const standingCharge = this.standingChargeOn('gas', gas.date);
    return {
      date: gas.date,
      kWh: round(gas.total, 3),
      pounds: dayCost(cost, standingCharge),
      standingCharge,
    };
  }

  /** The standing charge (p/day) Glowmarkt gave for a commodity on a London day, or null. */
  standingChargeOn(commodity, date) {
    const source = this.tariffs[commodity];
    return source ? source.standingChargeOn(date) : null;
  }

  async gasTotals(date) {
    const [gas, cost] = await Promise.all([this.day('gas.consumption', date), this.day('gas.consumption.cost', date)]);
    return { gas, cost };
  }

  /** Fetches each commodity's tariff. Returns { electricity, gas }: the rates, or null if no copy answered. */
  async fetchTariffs(now) {
    const result = {};
    for (const [commodity, source] of Object.entries(this.tariffs)) {
      result[commodity] = await source.fetch(this.request, now);
    }
    return result;
  }

  toJSON() {
    return {
      selected: this.stored,
      selectedOn: this.selectedOn,
      gasSeen: this.gasSeen,
      tariffs: Object.fromEntries(Object.entries(this.tariffs).map(([commodity, source]) => [commodity, source.toJSON()])),
    };
  }

}

module.exports = CloudReadings;
