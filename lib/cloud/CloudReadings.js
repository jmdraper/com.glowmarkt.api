'use strict';

// What the cloud devices read for one account entry, beyond live power: which
// copy of each resource to use, "data up to" times, daily figures and the
// tariffs. Built on a `request(path, options)` function that returns a
// response body or throws, such as the device's request() with its shared
// login, token renewal and 401 back-off. State that should survive a restart
// comes back from toJSON().

const { londonDate, addDays, readingsQueries } = require('./days');
const {
  lastTimeOf, copiesOf, selectResources, isDeadEntry,
} = require('./resources');
const {
  readingRows, latestCompleteDay, dayTotal, isFinalDay, round, pounds,
} = require('./readings');
const { TariffSource } = require('./TariffSource');

// the classifiers read for daily figures and "data up to"
const CLASSIFIERS = ['electricity.consumption', 'electricity.consumption.cost', 'gas.consumption', 'gas.consumption.cost', 'electricity.export'];

class CloudReadings {

  /**
   * `resources` are the entry's resources from /virtualentity/{veId}/resources.
   */
  constructor({ request, resources, state = {} }) {
    this.request = request;
    this.resources = resources.filter((resource) => CLASSIFIERS.includes(resource.classifier));
    this.stored = state.selected || {};
    this.selectedOn = state.selectedOn || null;
    this.selected = null;
    // true once a full check found every resource refused (HTTP 401)
    this.dead = false;
    this.tariffs = {};
    for (const commodity of ['electricity', 'gas']) {
      const copies = copiesOf(resources, `${commodity}.consumption`);
      if (copies.length) this.tariffs[commodity] = new TariffSource({ copies, ...(state.tariffs || {})[commodity] });
    }
  }

  hasGas() {
    return this.resources.some((resource) => resource.classifier === 'gas.consumption');
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
   * - electricityYesterday: { date, kWh, pounds, final }, or null if unknown
   * - gasLatestDay: { date, kWh, pounds } for the latest complete gas day, or
   *   null without gas or a gas /last-time
   */
  async refresh(now) {
    const selected = await this.select(now);
    const dataUpTo = Object.fromEntries(Object.entries(selected).map(([classifier, { lastTime }]) => [classifier, lastTime]));

    const yesterday = addDays(londonDate(now), -1);
    const [energy, cost] = await Promise.all([
      this.day('electricity.consumption', yesterday), this.day('electricity.consumption.cost', yesterday),
    ]);
    const electricityYesterday = energy && energy.complete ? {
      date: yesterday,
      kWh: round(energy.total, 3),
      pounds: cost && cost.complete ? pounds(cost.total) : null,
      final: isFinalDay(energy),
    } : null;

    let gasLatestDay = null;
    const gasDate = this.hasGas() && latestCompleteDay(dataUpTo['gas.consumption']);
    if (gasDate) {
      const [gas, gasCost] = await Promise.all([this.day('gas.consumption', gasDate), this.day('gas.consumption.cost', gasDate)]);
      if (gas) {
        gasLatestDay = {
          date: gasDate,
          kWh: round(gas.total, 3),
          pounds: gasCost && gasCost.complete ? pounds(gasCost.total) : null,
        };
      }
    }

    return { dataUpTo, electricityYesterday, gasLatestDay };
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
      tariffs: Object.fromEntries(Object.entries(this.tariffs).map(([commodity, source]) => [commodity, source.toJSON()])),
    };
  }

}

module.exports = CloudReadings;
