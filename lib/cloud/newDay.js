'use strict';

// When to fire New day's figures, and with what. A day is announced once its
// electricity is final and, where the entry has gas, its gas has arrived too,
// so the gas tokens aren't zero just because the gas data is late. Gas that
// still hasn't arrived by 18:00 the next day is given as 0 rather than
// holding the card back for good.

const { addDays, londonMidnight, dayLabel } = require('./days');

const GAS_WAIT_UNTIL_MS = 18 * 60 * 60 * 1000;

/**
 * Returns { date, tokens } for the day to announce now, or null. `figures` come
 * from CloudReadings.refresh(); `announced` is the last date announced.
 */
function dayToAnnounce(figures, { now, hasGas, announced = null }) {
  const electricity = figures.electricityYesterday;
  if (!electricity || !electricity.final) return null;
  const { date } = electricity;
  if (announced !== null && announced >= date) return null;

  const gas = hasGas && figures.gasLatestDay && figures.gasLatestDay.date === date ? figures.gasLatestDay : null;
  if (hasGas && !gas && now < londonMidnight(addDays(date, 1)) + GAS_WAIT_UNTIL_MS) return null;

  return {
    date,
    tokens: {
      date: dayLabel(date),
      electricity_kwh: electricity.kWh,
      electricity_cost: electricity.pounds ?? 0,
      gas_kwh: gas ? gas.kWh : 0,
      gas_cost: gas ? gas.pounds ?? 0 : 0,
    },
  };
}

module.exports = { dayToAnnounce };
