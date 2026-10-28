'use strict';

// London dates, and the UTC times the Glowmarkt API is asked for. Readings are
// requested with offset=0 and the UTC start and end of each London day: a
// London offset only relabels the timestamps, and one offset can't cover a
// clock-change day. Dates are 'YYYY-MM-DD' strings; times are ms since 1970.

const HALF_HOUR_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// The API serves at most 10 days of half-hourly readings per request.
const MAX_REQUEST_MS = 10 * DAY_MS;

const londonParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** London's offset from UTC at an instant, in minutes: 60 in summer, 0 in winter. */
function londonOffset(ms) {
  const p = Object.fromEntries(londonParts.formatToParts(new Date(ms)).map(({ type, value }) => [type, value]));
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/** The London date at an instant. */
function londonDate(ms) {
  return new Date(ms + londonOffset(ms) * 60000).toISOString().slice(0, 10);
}

/** London date and time at an instant, as 'YYYY-MM-DD HH:MM'. */
function londonDateTime(ms) {
  return new Date(ms + londonOffset(ms) * 60000).toISOString().slice(0, 16).replace('T', ' ');
}

function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The instant a London day starts. Clocks change at 01:00 UTC, so the offset at
 * 00:00 UTC is the offset at local midnight.
 */
function londonMidnight(date) {
  const utcMidnight = Date.parse(`${date}T00:00:00Z`);
  return utcMidnight - londonOffset(utcMidnight) * 60000;
}

/** A London day's start and end (the next day's start). */
function dayBounds(date) {
  return { start: londonMidnight(date), end: londonMidnight(addDays(date, 1)) };
}

/** Half hours in a London day: 48, or 46 and 50 on the clock-change days. */
function halfHoursIn(date) {
  const { start, end } = dayBounds(date);
  return (end - start) / HALF_HOUR_MS;
}

const utcString = (ms) => new Date(ms).toISOString().slice(0, 19);

/**
 * The /readings query for half-hourly sums from `start` up to `end`. `to` is
 * inclusive, so it stops a second before `end`.
 */
function readingsQuery(start, end) {
  return {
    from: utcString(start), to: utcString(end - 1000), period: 'PT30M', function: 'sum', offset: '0',
  };
}

/**
 * Queries for whole London days, `first` to `last` inclusive, split so that no
 * request spans more than 10 days.
 */
function readingsQueries(first, last) {
  const queries = [];
  for (let date = first; date <= last;) {
    const start = londonMidnight(date);
    let next = addDays(date, 1);
    while (next <= last && londonMidnight(addDays(next, 1)) - start <= MAX_REQUEST_MS) next = addDays(next, 1);
    queries.push(readingsQuery(start, londonMidnight(next)));
    date = next;
  }
  return queries;
}

module.exports = {
  HALF_HOUR_MS,
  DAY_MS,
  londonOffset,
  londonDate,
  londonDateTime,
  addDays,
  londonMidnight,
  dayBounds,
  halfHoursIn,
  utcString,
  readingsQuery,
  readingsQueries,
};
