'use strict';

// Which days New day's figures should announce. Electricity: yesterday, once
// its figures are final. Gas, which can arrive a day or more late: every final
// day since the last one announced, oldest first, so a gap that fills at once
// still gives one card per day.

const { addDays } = require('./days');

// the most days announced at once after a gap
const MAX_CATCH_UP_DAYS = 7;

/** The electricity day to announce now, or null. `announced` is the last date announced. */
function electricityDayToAnnounce(figures, announced) {
  const day = figures.electricityYesterday;
  if (!day || !day.final) return null;
  return announced !== null && announced >= day.date ? null : day;
}

/**
 * Gas dates to announce now, oldest first: those after `announced` up to the
 * latest final day, at most the last seven.
 */
function gasDaysToAnnounce(latestDay, announced) {
  if (!latestDay || (announced !== null && announced >= latestDay)) return [];
  const earliest = addDays(latestDay, 1 - MAX_CATCH_UP_DAYS);
  const dates = [];
  for (let date = announced === null || announced < earliest ? earliest : addDays(announced, 1); date <= latestDay; date = addDays(date, 1)) {
    dates.push(date);
  }
  return dates;
}

module.exports = { electricityDayToAnnounce, gasDaysToAnnounce, MAX_CATCH_UP_DAYS };
