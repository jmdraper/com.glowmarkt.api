'use strict';

// Which days New day's figures should announce. Electricity: yesterday, once
// its figures are final. Gas, which can arrive a day or more late: every final
// day since the last one announced, oldest first, so a gap that fills at once
// still gives one card per day. Either way a day waits for its standing
// charge, so its cost matches Bright's, until the day's deadline (see
// CloudReadings.refresh()); after that it goes out without one.

const { addDays } = require('./days');

// the most days announced at once after a gap
const MAX_CATCH_UP_DAYS = 7;

/** Whether a final day can be announced at `now`: its standing charge is known, or its deadline has passed. */
function readyToAnnounce(day, now) {
  return day.standingCharge !== null || now >= day.deadline;
}

/** The electricity day to announce now, or null. `announced` is the last date announced. */
function electricityDayToAnnounce(figures, announced, now) {
  const day = figures.electricityYesterday;
  if (!day || !day.final || !readyToAnnounce(day, now)) return null;
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

module.exports = {
  readyToAnnounce, electricityDayToAnnounce, gasDaysToAnnounce, MAX_CATCH_UP_DAYS,
};
