'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DAY_MS, londonDate, dayBounds, halfHoursIn, readingsQuery, readingsQueries,
} = require('../../lib/cloud/days');
const { recording } = require('../helpers/fake-cloud-api');

test('London days start at local midnight in winter and summer', () => {
  assert.equal(new Date(dayBounds('2026-01-15').start).toISOString(), '2026-01-15T00:00:00.000Z');
  assert.equal(new Date(dayBounds('2026-07-01').start).toISOString(), '2026-06-30T23:00:00.000Z');
  assert.equal(londonDate(Date.parse('2026-07-01T23:30:00Z')), '2026-07-02');
  assert.equal(londonDate(Date.parse('2026-12-01T23:30:00Z')), '2026-12-01');
});

test('clock-change days have 46 and 50 half hours', () => {
  assert.equal(halfHoursIn('2026-03-28'), 48);
  assert.equal(halfHoursIn('2026-03-29'), 46);
  assert.equal(halfHoursIn('2026-03-30'), 48);
  assert.equal(halfHoursIn('2026-10-24'), 48);
  assert.equal(halfHoursIn('2026-10-25'), 50);
  assert.equal(halfHoursIn('2026-10-26'), 48);
});

test('a day is asked for in UTC with offset 0, ending a second before the next midnight', () => {
  assert.deepEqual(readingsQueries('2026-10-25', '2026-10-25'), [{
    from: '2026-10-24T23:00:00', to: '2026-10-25T23:59:59', period: 'PT30M', function: 'sum', offset: '0',
  }]);
  assert.deepEqual(readingsQueries('2026-03-29', '2026-03-29')[0], readingsQuery(Date.parse('2026-03-29T00:00:00Z'), Date.parse('2026-03-29T23:00:00Z')));
});

test('the API returned whole days for those queries: 50 half hours on 25 Oct, 48 on 24 Oct', () => {
  for (const [date, expected] of [['2026-10-25', 50], ['2026-10-24', 48]]) {
    const [query] = readingsQueries(date, date);
    const calls = recording.calls.filter((call) => call.label === `readings:${date}:utc` && call.status === 200);
    assert.ok(calls.length > 0);
    for (const call of calls) {
      assert.deepEqual(call.query, query);
      assert.equal(call.body.data.length, expected);
      assert.equal(new Date(call.body.data[0][0] * 1000).toISOString(), new Date(dayBounds(date).start).toISOString());
    }
  }
});

test('long ranges are split into requests of at most 10 days, without gaps', () => {
  const queries = readingsQueries('2026-10-01', '2026-10-31');
  const spans = queries.map((q) => [Date.parse(`${q.from}Z`), Date.parse(`${q.to}Z`) + 1000]);
  assert.equal(spans[0][0], dayBounds('2026-10-01').start);
  assert.equal(spans[spans.length - 1][1], dayBounds('2026-10-31').end);
  for (let i = 0; i < spans.length; i++) {
    assert.ok(spans[i][1] - spans[i][0] <= 10 * DAY_MS, `request ${i} spans more than 10 days`);
    if (i > 0) assert.equal(spans[i][0], spans[i - 1][1]);
  }
  // 10 London days including the 25-hour 25 Oct are just over 10 days, so they're split.
  assert.equal(readingsQueries('2026-10-20', '2026-10-29').length, 2);
  assert.equal(readingsQueries('2026-10-01', '2026-10-10').length, 1);
});
