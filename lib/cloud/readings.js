'use strict';

// Daily figures from half-hourly /readings. The API pads every half hour up to
// `to` with zeros, including ones it has no data for yet, so only half hours
// at or before the resource's /last-time count. Up to then, zero is a real
// reading (no gas used).

const {
  HALF_HOUR_MS, addDays, dayBounds, halfHoursIn, londonDate,
} = require('./days');

/** Half-hour rows from a /readings response as [ms, value], or [] if there are none. */
function readingRows(body) {
  const data = body && Array.isArray(body.data) ? body.data : [];
  return data
    .filter((row) => Array.isArray(row) && Number.isFinite(row[0]) && Number.isFinite(row[1]))
    .map(([seconds, value]) => [seconds * 1000, value]);
}

/**
 * The latest London day whose last half hour is at or before `lastTime`, or
 * null without a time.
 */
function latestCompleteDay(lastTime) {
  if (!Number.isFinite(lastTime)) return null;
  const date = londonDate(lastTime);
  return lastTime >= dayBounds(date).end - HALF_HOUR_MS ? date : addDays(date, -1);
}

/** Whether a kWh value is a whole number of Wh, allowing for floating point. */
function isWholeWh(kWh) {
  return Math.abs(kWh * 1000 - Math.round(kWh * 1000)) < 1e-6;
}

/**
 * Totals one London day. Returns { date, total, halfHours, negative,
 * fractional, last, complete }: the sum and count of the half hours at or
 * before `lastTime`, how many of them are negative and how many aren't a whole
 * Wh, the latest one's value (null if none), and whether the day is complete
 * (`lastTime` at or after its last half hour).
 */
function dayTotal(rows, date, lastTime) {
  const { start, end } = dayBounds(date);
  const counted = rows.filter(([at]) => at >= start && at < end && Number.isFinite(lastTime) && at <= lastTime);
  return {
    date,
    total: counted.reduce((sum, [, value]) => sum + value, 0),
    halfHours: counted.length,
    negative: counted.filter(([, value]) => value < 0).length,
    fractional: counted.filter(([, value]) => !isWholeWh(value)).length,
    last: counted.length ? counted.reduce((latest, row) => (row[0] > latest[0] ? row : latest))[1] : null,
    complete: Number.isFinite(lastTime) && lastTime >= end - HALF_HOUR_MS,
  };
}

/**
 * Whether a complete day's electricity is final, meaning the DCC's import-only
 * half hours have replaced the display's, which are net of export.
 *
 * The DCC's half hours are whole Wh. The display's are averages of its
 * per-minute readings, in sixtieths of a Wh, so nearly all of them aren't,
 * whether or not anything was exported. In Jon's recordings, 28 Oct still
 * held display half hours at 06:30 the next morning (45 of 48 not whole Wh,
 * 16 negative) and the DCC's by 15:00 (all whole Wh, none negative). A
 * negative half hour is the display's even when it happens to be whole Wh.
 */
function isFinalDay(day) {
  return day.complete && day.negative === 0 && day.fractional === 0;
}

// How long a gas day's last half hour must stay the same: an hour, less a
// minute. The gas device polls on an hourly timer, so consecutive polls are an
// hour apart give or take a few ms; a strict hour would often miss by those ms
// and wait for the poll after.
const GAS_SETTLED_MS = 59 * 60 * 1000;

/**
 * Whether a complete day's gas is final: every half hour is in, and either the
 * data runs past the end of the day, or the day's last half hour has stayed the
 * same between two polls an hour apart, both after the day ended.
 *
 * Gas comes in whole days on some accounts, its last half hour settled when it
 * arrives. On others it comes through the day, and the half hour at /last-time
 * can still be filling: in Jon's recordings, 06:30 on 29 Oct read 0 at 06:30
 * and 0.321 by 15:00. Waiting for the next day's data would delay whole-day
 * accounts by a day; this delays them by a poll.
 *
 * `seen` is { date, last, at } from the previous poll, or null. Returns
 * { final, seen }, `seen` to pass to the next poll.
 */
function gasDayFinality(day, lastTime, now, seen) {
  const { end } = dayBounds(day.date);
  if (!day.complete || day.halfHours !== halfHoursIn(day.date)) return { final: false, seen: null };
  if (lastTime >= end) return { final: true, seen: null };
  if (now < end) return { final: false, seen: null };
  if (seen && seen.date === day.date && seen.last === day.last) return { final: now - seen.at >= GAS_SETTLED_MS, seen };
  return { final: false, seen: { date: day.date, last: day.last, at: now } };
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Pence to pounds, to the penny. */
function pounds(pence) {
  return round(pence / 100, 2);
}

module.exports = {
  readingRows, latestCompleteDay, dayTotal, isFinalDay, gasDayFinality, GAS_SETTLED_MS, round, pounds,
};
