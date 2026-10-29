'use strict';

// The shared readings layer, against the recording of Jon's account on 28 Oct
// at 13:40: one live entry with two copies of each consumption and cost
// resource, and one dead entry that returns 401 for everything.

const test = require('node:test');
const assert = require('node:assert/strict');

const CloudReadings = require('../../lib/cloud/CloudReadings');
const ImportToday = require('../../lib/cloud/ImportToday');
const { TariffSource, parseTariff, nextTariffAt } = require('../../lib/cloud/TariffSource');
const { selectResources, liveElectricityResource, isDeadEntry } = require('../../lib/cloud/resources');
const {
  readingRows, latestCompleteDay, dayTotal, isFinalDay, gasDayFinality, GAS_SETTLED_MS, pounds,
} = require('../../lib/cloud/readings');
const { HALF_HOUR_MS, dayBounds, readingsQueries } = require('../../lib/cloud/days');
const {
  RECORDED_AT, ENTRIES, ID, recorded, fakeCloudApi, recordingApi,
} = require('../helpers/fake-cloud-api');

const [LIVE, DEAD] = ENTRIES;
const ELEC = ID['electricity.consumption|electricity consumption'];
const ELEC_SMART = ID['electricity.consumption|Smart Meter, electricity consumption'];
const GAS = ID['gas.consumption|gas consumption'];
const GAS_SMART = ID['gas.consumption|Smart Meter, gas consumption'];
const EXPORT = ID['electricity.export|active export'];
const at = (iso) => Date.parse(iso);
const lastTime = (id) => recorded('last-time', id).body.data.lastTs * 1000;

async function rowsFor(id, date) {
  const { request } = fakeCloudApi();
  const [query] = readingsQueries(date, date);
  return readingRows(await request(`/resource/${id}/readings?${new URLSearchParams(query)}`));
}

// Choosing resources

test('duplicate copies resolve to one per classifier: the first listed on a tie, the stored copy if there is one', () => {
  const times = new Map(LIVE.resources.map((r) => [r.resourceId, lastTime(r.resourceId)]));
  assert.equal(times.get(ELEC), times.get(ELEC_SMART));

  const selected = selectResources(LIVE.resources, times);
  assert.equal(selected['electricity.consumption'].resourceId, ELEC);
  assert.equal(selected['gas.consumption'].resourceId, GAS);
  assert.equal(Object.keys(selected).length, 7);

  const kept = selectResources(LIVE.resources, times, { 'electricity.consumption': ELEC_SMART });
  assert.equal(kept['electricity.consumption'].resourceId, ELEC_SMART);
});

test('a copy with a later /last-time wins over the stored one; with no answers the stored one is kept', () => {
  const times = new Map(LIVE.resources.map((r) => [r.resourceId, lastTime(r.resourceId)]));
  times.set(ELEC_SMART, times.get(ELEC) + 60000);
  assert.equal(selectResources(LIVE.resources, times, { 'electricity.consumption': ELEC })['electricity.consumption'].resourceId, ELEC_SMART);

  const none = new Map(LIVE.resources.map((r) => [r.resourceId, null]));
  const selected = selectResources(LIVE.resources, none, { 'gas.consumption': GAS_SMART });
  assert.deepEqual(selected['gas.consumption'], { resourceId: GAS_SMART, lastTime: null });
  assert.equal(selected['electricity.consumption'].resourceId, ELEC);
});

test('an existing device keeps its live resource unless it is not electricity.consumption', () => {
  assert.equal(liveElectricityResource(LIVE.resources, ELEC_SMART), ELEC_SMART);
  // The old pairing fell back to the first resource listed, which here is gas.
  assert.equal(liveElectricityResource(LIVE.resources, GAS), ELEC);
  assert.equal(liveElectricityResource(LIVE.resources, 'gone'), ELEC);
  assert.equal(liveElectricityResource([], ELEC), null);
});

test('the dead entry is recognised: every resource refuses', async () => {
  assert.equal(isDeadEntry([401, 401]), true);
  assert.equal(isDeadEntry([401, 200]), false);
  assert.equal(isDeadEntry([401, null]), false);
  assert.equal(isDeadEntry([]), false);

  const { request } = fakeCloudApi();
  const dead = new CloudReadings({ request, resources: DEAD.resources });
  const figures = await dead.refresh(RECORDED_AT);
  assert.equal(dead.dead, true);
  assert.deepEqual(figures, {
    dataUpTo: {
      'electricity.consumption': null, 'electricity.consumption.cost': null, 'gas.consumption': null, 'gas.consumption.cost': null,
    },
    electricityYesterday: null,
    gasLatestDay: null,
  });

  const live = new CloudReadings({ request, resources: LIVE.resources });
  await live.refresh(RECORDED_AT);
  assert.equal(live.dead, false);
});

// Days and completeness

test('the latest complete day comes from /last-time', () => {
  assert.equal(latestCompleteDay(lastTime(GAS)), '2026-10-27');
  assert.equal(latestCompleteDay(lastTime(ELEC)), '2026-10-27');
  assert.equal(latestCompleteDay(lastTime(EXPORT)), '2026-10-26');
  assert.equal(latestCompleteDay(at('2026-10-27T23:29:59Z')), '2026-10-26');
  assert.equal(latestCompleteDay(at('2026-10-25T23:30:00Z')), '2026-10-25');
  assert.equal(latestCompleteDay(null), null);
});

test('a day with no gas used is complete, its zero half hours real', async () => {
  const day = dayTotal(await rowsFor(GAS, '2026-10-27'), '2026-10-27', lastTime(GAS));
  assert.deepEqual(day, {
    date: '2026-10-27', total: 0, halfHours: 48, negative: 0, fractional: 0, last: 0, complete: true,
  });
  const gasToday = dayTotal(await rowsFor(GAS, '2026-10-28'), '2026-10-28', lastTime(GAS));
  assert.equal(gasToday.complete, false);
  assert.equal(gasToday.halfHours, 0);
});

test('zero padding after /last-time is not counted', async () => {
  // Export data ends on 26 Oct, but the API still returns 48 zero rows for 27 Oct.
  const rows = await rowsFor(EXPORT, '2026-10-27');
  assert.equal(rows.length, 48);
  const day = dayTotal(rows, '2026-10-27', lastTime(EXPORT));
  assert.equal(day.halfHours, 0);
  assert.equal(day.complete, false);
});

test('the clock-change day counts all 50 half hours', async () => {
  const day = dayTotal(await rowsFor(ELEC, '2026-10-25'), '2026-10-25', lastTime(ELEC));
  assert.equal(day.halfHours, 50);
  assert.equal(Math.round(day.total * 1000) / 1000, 13.701);
});

test('today is not final while it holds net half hours from the display', async () => {
  const today = dayTotal(await rowsFor(ELEC, '2026-10-28'), '2026-10-28', lastTime(ELEC));
  assert.ok(today.negative > 0);
  assert.equal(isFinalDay(today), false);
  const yesterday = dayTotal(await rowsFor(ELEC, '2026-10-27'), '2026-10-27', lastTime(ELEC));
  assert.equal(yesterday.fractional, 0);
  assert.equal(isFinalDay(yesterday), true);
});

test("the display's half hours aren't whole Wh, with or without export", async () => {
  // 28 Oct before the sun was up: display half hours, none negative
  const morning = dayTotal(await rowsFor(ELEC, '2026-10-28'), '2026-10-28', at('2026-10-28T08:00:00Z'));
  assert.equal(morning.halfHours, 17);
  assert.equal(morning.negative, 0);
  assert.equal(morning.fractional, 15);
});

test('a complete day of display half hours without export is not final', () => {
  const { start } = dayBounds('2026-10-28');
  const rows = (value) => Array.from({ length: 48 }, (_, i) => [start + i * HALF_HOUR_MS, value]);
  const lastHalfHour = start + 47 * HALF_HOUR_MS;
  const display = dayTotal(rows(0.117216666666667), '2026-10-28', lastHalfHour);
  assert.deepEqual([display.complete, display.negative, display.fractional], [true, 0, 48]);
  assert.equal(isFinalDay(display), false);
  assert.equal(isFinalDay(dayTotal(rows(0.119), '2026-10-28', lastHalfHour)), true);
});

test("28 Oct's display half hours give way to the meter's between 06:30 and 15:00 the next day", async () => {
  const yesterdayAt = async (name) => {
    const api = recordingApi(name);
    const readings = new CloudReadings({ request: api.fakeCloudApi().request, resources: api.ENTRIES[0].resources });
    const elec = api.ID['electricity.consumption|electricity consumption'];
    const rows = readingRows(api.recorded('readings:recent', elec).body);
    const lastTs = api.recorded('last-time', elec).body.data.lastTs * 1000;
    return { day: dayTotal(rows, '2026-10-28', lastTs), figures: await readings.refresh(api.RECORDED_AT) };
  };

  const early = await yesterdayAt('display-account-29oct-0630');
  assert.deepEqual([early.day.complete, early.day.negative, early.day.fractional], [true, 16, 45]);
  assert.equal(early.figures.electricityYesterday.date, '2026-10-28');
  assert.equal(early.figures.electricityYesterday.kWh, 4.681);
  assert.equal(early.figures.electricityYesterday.final, false);

  const later = await yesterdayAt('display-account-29oct-1500');
  assert.deepEqual([later.day.complete, later.day.negative, later.day.fractional], [true, 0, 0]);
  assert.equal(later.figures.electricityYesterday.kWh, 14.114);
  assert.equal(later.figures.electricityYesterday.final, true);
});

test('pence become pounds to the penny', () => {
  assert.equal(pounds(286.953), 2.87);
  assert.equal(pounds(0), 0);
  assert.equal(pounds(222.4), 2.22);
});

// Figures for the device

test('yesterday and the latest gas day, from the readings layer', async () => {
  const { request } = fakeCloudApi();
  const readings = new CloudReadings({ request, resources: LIVE.resources });
  const figures = await readings.refresh(RECORDED_AT);
  assert.deepEqual(figures.electricityYesterday, {
    date: '2026-10-27', kWh: 11.196, pounds: 2.87, final: true,
  });
  // gas runs to 27 Oct 23:30 exactly: 27 Oct isn't final until a poll an hour later
  assert.deepEqual(figures.gasLatestDay, { date: '2026-10-26', kWh: 6.84, pounds: 0.54 });
  assert.equal(figures.dataUpTo['electricity.consumption'], at('2026-10-28T13:18:00Z'));
  assert.equal(figures.dataUpTo['electricity.export'], at('2026-10-26T23:30:00Z'));
});

// Gas days

const HOUR = 60 * 60 * 1000;
const gasOnly = (overrides) => new CloudReadings({ request: fakeCloudApi({ overrides }).request, resources: LIVE.resources, commodity: 'gas' });
const gasUpTo = (iso) => {
  const body = { data: { lastTs: at(iso) / 1000 } };
  return { [`last-time ${GAS}`]: body, [`last-time ${GAS_SMART}`]: body };
};

test("a gas day is final at once when the data runs past it, as on Jon's account by 29 Oct", async () => {
  const api = recordingApi('display-account-29oct-0630');
  const readings = new CloudReadings({ request: api.fakeCloudApi().request, resources: api.ENTRIES[0].resources, commodity: 'gas' });
  const { dataUpTo, gasLatestDay } = await readings.refresh(api.RECORDED_AT);
  assert.equal(dataUpTo['gas.consumption'], at('2026-10-29T06:30:00Z'));
  assert.deepEqual(gasLatestDay, { date: '2026-10-28', kWh: 0, pounds: 0 });
});

test('a gas day the data ends with is final once its last half hour is unchanged an hour later', async () => {
  const readings = gasOnly({});
  assert.equal((await readings.refresh(RECORDED_AT)).gasLatestDay.date, '2026-10-26');
  assert.equal((await readings.refresh(RECORDED_AT + 30 * 60 * 1000)).gasLatestDay.date, '2026-10-26');

  // what was seen survives a restart
  const restarted = new CloudReadings({
    request: fakeCloudApi().request, resources: LIVE.resources, commodity: 'gas', state: readings.toJSON(),
  });
  assert.deepEqual(restarted.toJSON().gasSeen, { date: '2026-10-27', last: 0, at: RECORDED_AT });
  assert.deepEqual((await restarted.refresh(RECORDED_AT + HOUR)).gasLatestDay, { date: '2026-10-27', kWh: 0, pounds: 0 });
});

test('a gas day is not final between 23:30 and midnight while its data comes through the day', async () => {
  // gas in to 27 Oct 23:30, polled at 23:45 while that half hour may still be filling
  const readings = gasOnly(gasUpTo('2026-10-27T23:30:00Z'));
  assert.equal((await readings.refresh(at('2026-10-27T23:45:00Z'))).gasLatestDay.date, '2026-10-26');
  assert.equal(readings.toJSON().gasSeen, null);

  // an hour later the data runs past midnight
  const next = gasOnly(gasUpTo('2026-10-28T00:30:00Z'));
  assert.equal((await next.refresh(at('2026-10-28T00:45:00Z'))).gasLatestDay.date, '2026-10-27');
});

test("a gas day's last half hour changing starts the hour again", () => {
  const { start, end } = dayBounds('2026-10-27');
  const day = (last) => dayTotal(Array.from({ length: 48 }, (_, i) => [start + i * HALF_HOUR_MS, i === 47 ? last : 0]), '2026-10-27', end - HALF_HOUR_MS);
  const lastTime = end - HALF_HOUR_MS;

  let poll = gasDayFinality(day(0), lastTime, end + 5 * 60 * 1000, null);
  assert.deepEqual(poll, { final: false, seen: { date: '2026-10-27', last: 0, at: end + 5 * 60 * 1000 } });
  poll = gasDayFinality(day(0.321), lastTime, end + 65 * 60 * 1000, poll.seen);
  assert.equal(poll.final, false);
  assert.equal(poll.seen.at, end + 65 * 60 * 1000);
  assert.equal(gasDayFinality(day(0.321), lastTime, end + 125 * 60 * 1000, poll.seen).final, true);
  assert.equal(GAS_SETTLED_MS, 59 * 60 * 1000);
});

test('a gas day missing a half hour is not final, even with data past it', () => {
  const { start, end } = dayBounds('2026-10-27');
  const rows = Array.from({ length: 48 }, (_, i) => [start + i * HALF_HOUR_MS, 0]).filter((_, i) => i !== 20);
  assert.equal(gasDayFinality(dayTotal(rows, '2026-10-27', end + HOUR), end + HOUR, end + 2 * HOUR, null).final, false);
});

test('copies are chosen once a day; later polls ask only the chosen copies for /last-time', async () => {
  const api = fakeCloudApi();
  const readings = new CloudReadings({ request: api.request, resources: LIVE.resources });
  await readings.select(RECORDED_AT);
  assert.equal(api.calls.filter((c) => c.path.endsWith('/last-time')).length, 9);

  api.calls.length = 0;
  await readings.select(RECORDED_AT + 15 * 60 * 1000);
  assert.equal(api.calls.filter((c) => c.path.endsWith('/last-time')).length, 5);

  // The choice survives a restart, and a new day chooses again.
  const restored = new CloudReadings({ request: api.request, resources: LIVE.resources, state: JSON.parse(JSON.stringify(readings)) });
  api.calls.length = 0;
  await restored.select(at('2026-10-29T09:00:00Z'));
  assert.equal(api.calls.filter((c) => c.path.endsWith('/last-time')).length, 9);
});

// Tariffs

test('the tariff comes from one response: electricity and gas rates and standing charges', async () => {
  assert.deepEqual(parseTariff(recorded('tariff', GAS).body), { rate: 7.92, standingCharge: 28.84 });
  assert.equal(parseTariff({ data: [] }), null);

  const api = fakeCloudApi();
  const readings = new CloudReadings({ request: api.request, resources: LIVE.resources });
  assert.deepEqual(await readings.fetchTariffs(RECORDED_AT), {
    electricity: { rate: 25.63, standingCharge: 60.7 },
    gas: { rate: 7.92, standingCharge: 28.84 },
  });
  assert.deepEqual(api.calls.map((c) => [c.path, c.options.timeoutMs]), [
    [`/resource/${ELEC}/tariff`, 35000],
    [`/resource/${GAS}/tariff`, 35000],
  ]);
});

test('a copy that times out is not asked again that day; the copy that answers is used', async () => {
  const timeout = Object.assign(new Error('network timeout'), { type: 'request-timeout' });
  const api = fakeCloudApi({ overrides: { [`tariff ${ELEC}`]: timeout } });
  const source = new TariffSource({ copies: [ELEC, ELEC_SMART] });

  assert.deepEqual(await source.fetch(api.request, RECORDED_AT), { rate: 25.63, standingCharge: 60.7 });
  assert.deepEqual(api.calls.map((c) => c.path), [`/resource/${ELEC}/tariff`, `/resource/${ELEC_SMART}/tariff`]);
  assert.deepEqual(source.attempts.map((a) => [a.id, a.outcome]), [[ELEC, 'slow'], [ELEC_SMART, 'answered']]);

  api.calls.length = 0;
  await source.fetch(api.request, at('2026-10-28T23:00:30Z'));
  assert.deepEqual(api.calls.map((c) => c.path), [`/resource/${ELEC_SMART}/tariff`]);

  // The next day it may be tried again, after the copy that answered.
  assert.deepEqual(source.candidates(at('2026-10-29T00:00:30Z')), [ELEC_SMART, ELEC]);
  assert.deepEqual(new TariffSource({ copies: [ELEC, ELEC_SMART], ...JSON.parse(JSON.stringify(source)) }).candidates(RECORDED_AT), [ELEC_SMART]);
});

test('a copy the server cuts off is treated like a timeout; other failures are not', async () => {
  const cutOff = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  const source = new TariffSource({ copies: [ELEC, ELEC_SMART] });
  await source.fetch(fakeCloudApi({ overrides: { [`tariff ${ELEC}`]: cutOff } }).request, RECORDED_AT);
  assert.deepEqual(source.candidates(RECORDED_AT), [ELEC_SMART]);

  const busy = Object.assign(new Error('HTTP 503'), { status: 503 });
  const other = new TariffSource({ copies: [ELEC, ELEC_SMART] });
  await other.fetch(fakeCloudApi({ overrides: { [`tariff ${ELEC}`]: busy } }).request, RECORDED_AT);
  assert.deepEqual(other.candidates(RECORDED_AT), [ELEC_SMART, ELEC]);
});

test('the last good tariff is kept when no copy answers; with no answer ever it stays empty', async () => {
  const timeout = Object.assign(new Error('network timeout'), { type: 'request-timeout' });
  const failing = fakeCloudApi({ overrides: { tariff: timeout } });

  const source = new TariffSource({ copies: [GAS, GAS_SMART] });
  assert.equal(await source.fetch(failing.request, RECORDED_AT), null);
  assert.equal(source.last, null);
  assert.deepEqual(source.candidates(RECORDED_AT), []);

  const answered = new TariffSource({ copies: [GAS, GAS_SMART] });
  await answered.fetch(fakeCloudApi().request, RECORDED_AT);
  assert.equal(await answered.fetch(failing.request, at('2026-10-29T08:00:30Z')), null);
  assert.deepEqual(answered.last, { rate: 7.92, standingCharge: 28.84, at: RECORDED_AT });
});

test('the tariff is fetched 30 s after each hour and half hour', () => {
  const next = (iso) => new Date(nextTariffAt(at(iso))).toISOString().slice(11, 19);
  assert.equal(next('2026-10-28T13:41:10Z'), '14:00:30');
  assert.equal(next('2026-10-28T14:00:20Z'), '14:00:30');
  assert.equal(next('2026-10-28T14:00:30Z'), '14:30:30');
  assert.equal(next('2026-10-28T23:59:00Z'), '00:00:30');
});

// Electricity today from the import register

test('electricity today is the register now minus the register at midnight', () => {
  const today = new ImportToday();
  assert.equal(today.reading(at('2026-10-27T23:59:50Z'), 10_360_000), null);
  assert.equal(today.reading(at('2026-10-28T00:00:00Z'), 10_360_010), 0);
  assert.equal(today.reading(at('2026-10-28T13:18:00Z'), 10_365_770), 5.76);

  // It carries on after a restart.
  const restored = new ImportToday(JSON.parse(JSON.stringify(today)));
  assert.equal(restored.reading(at('2026-10-28T14:00:00Z'), 10_366_010), 6);
});

test('without a reading just before midnight, today stays empty until the next midnight', () => {
  const installed = new ImportToday();
  assert.equal(installed.reading(at('2026-10-28T13:00:00Z'), 10_365_000), null);
  assert.equal(installed.reading(at('2026-10-28T23:59:55Z'), 10_368_000), null);
  assert.equal(installed.reading(at('2026-10-29T00:00:05Z'), 10_368_010), 0);

  // Homey off for an hour across midnight
  const gap = new ImportToday();
  gap.reading(at('2026-10-28T23:30:00Z'), 10_368_000);
  assert.equal(gap.reading(at('2026-10-29T00:30:00Z'), 10_368_300), null);
});

test('polling less often than every 15 minutes still crosses midnight', () => {
  const HOUR = 60 * 60 * 1000;
  const hourly = new ImportToday();
  hourly.reading(at('2026-10-28T23:10:00Z'), 10_368_000, HOUR);
  assert.equal(hourly.reading(at('2026-10-29T00:10:00Z'), 10_368_300, HOUR), 0);

  // A gap longer than the poll interval plus a minute still doesn't count.
  const missed = new ImportToday();
  missed.reading(at('2026-10-28T22:50:00Z'), 10_368_000, HOUR);
  assert.equal(missed.reading(at('2026-10-29T00:10:00Z'), 10_368_300, HOUR), null);
});

test('midnight is London midnight, and a register that goes backwards empties today', () => {
  const summer = new ImportToday();
  summer.reading(at('2026-07-01T22:59:50Z'), 1_000_000);
  assert.equal(summer.reading(at('2026-07-01T23:00:00Z'), 1_000_005), 0);
  assert.equal(summer.date, '2026-07-02');

  assert.equal(summer.reading(at('2026-07-02T08:00:00Z'), 500), null);
  // An older reading arriving late is ignored.
  assert.equal(summer.reading(at('2026-07-02T07:00:00Z'), 1_000_100), null);
});
