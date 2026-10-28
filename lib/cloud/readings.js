'use strict';

// Daily figures from half-hourly /readings. The API pads every half hour up to
// `to` with zeros, including ones it has no data for yet, so only half hours
// at or before the resource's /last-time count. Up to then, zero is a real
// reading (no gas used).

const {
  HALF_HOUR_MS, addDays, dayBounds, londonDate,
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

/**
 * Totals one London day. Returns { date, total, halfHours, negative, complete }:
 * the sum and count of the half hours at or before `lastTime`, how many of
 * them are negative, and whether the day is complete (`lastTime` at or after
 * its last half hour).
 */
function dayTotal(rows, date, lastTime) {
  const { start, end } = dayBounds(date);
  const counted = rows.filter(([at]) => at >= start && at < end && Number.isFinite(lastTime) && at <= lastTime);
  return {
    date,
    total: counted.reduce((sum, [, value]) => sum + value, 0),
    halfHours: counted.length,
    negative: counted.filter(([, value]) => value < 0).length,
    complete: Number.isFinite(lastTime) && lastTime >= end - HALF_HOUR_MS,
  };
}

/**
 * Whether a complete day's electricity is final, meaning the DCC's import-only
 * half hours have replaced the display's, which are net of export.
 *
 * Provisional: a day with a negative half hour still holds display data. That
 * misses display data on a day without export, so the rule is to be set from
 * Jon's recordings on 28 and 29 Oct.
 */
function isFinalDay(day) {
  return day.complete && day.negative === 0;
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
  readingRows, latestCompleteDay, dayTotal, isFinalDay, round, pounds,
};
