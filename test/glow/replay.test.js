'use strict';

// Replays every fixture file in test/fixtures through the parser and validator,
// keeping validation state per unit and meter kind as a device would, and
// electricity power through the exporting hold.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { parseTopic, parsePayload } = require('../../lib/glow/parse');
const { emptyState, validateReading, validateState } = require('../../lib/glow/validate');
const ExportingTracker = require('../../lib/ExportingTracker');

const FIXTURES = path.join(__dirname, '..', 'fixtures');

function replay(file) {
  const counts = { messages: 0, ignored: 0, accepted: 0 };
  const rejections = {};
  const states = new Map();
  const gasSteps = [];
  const exporting = new Map();
  const exportEvents = [];
  const count =(key) => { rejections[key] = (rejections[key] || 0) + 1; };

  for (const line of zlib.gunzipSync(fs.readFileSync(file)).toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    const { received, topic, payload } = JSON.parse(line);
    counts.messages++;

    const route = parseTopic(topic, 'glow');
    if (!route) {
      counts.ignored++;
      continue;
    }
    const parsed = parsePayload(route.kind, payload);
    if (!parsed.ok) {
      count(`${route.kind} rule ${parsed.rule} ${parsed.reason}`);
      continue;
    }

    if (route.kind === 'STATE') {
      validateState(parsed.reading).rejections.forEach((r) => count(`STATE ${r.field} rule ${r.rule} ${r.reason}`));
      continue;
    }

    const key = `${route.unitId}/${route.kind}`;
    const previous = states.get(key) || emptyState();
    const result = validateReading(parsed.reading, previous, { now: Date.parse(received) });
    states.set(key, result.state);
    result.rejections.forEach((r) => count(`${route.kind} ${r.field ?? 'message'} rule ${r.rule} ${r.reason}`));
    if (result.ok) counts.accepted++;

    const volume = result.accepted && result.accepted.gasVolumeM3;
    const lastVolume = previous.lastGood.gasVolumeM3;
    if (volume !== undefined && (!lastVolume || volume !== lastVolume.value)) gasSteps.push({ received, volume });

    const power = result.accepted && result.accepted.powerKw;
    if (power !== undefined) {
      if (!exporting.has(key)) exporting.set(key, new ExportingTracker());
      const change = exporting.get(key).power(Math.round(power * 1000), Date.parse(received));
      if (change) exportEvents.push({ received, ...change });
    }
  }
  return {
    counts, rejections, gasSteps, exportEvents,
  };
}

const files = fs.existsSync(FIXTURES) ? fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.jsonl.gz')) : [];

for (const file of files) {
  test(`replay ${file} without exceptions`, (t) => {
    const { counts, rejections } = replay(path.join(FIXTURES, file));
    t.diagnostic(`messages ${counts.messages}, ignored topics ${counts.ignored}, meter readings accepted ${counts.accepted}`);
    const reasons = Object.entries(rejections).sort();
    if (!reasons.length) t.diagnostic('no rejections');
    for (const [reason, n] of reasons) t.diagnostic(`rejected: ${reason} × ${n}`);
    assert.ok(counts.messages > 0);
  });
}

// Findings from the full capture (25–26 Oct), which have to keep holding.
test('full capture: the 05:30 gas step is accepted at once, with no rule 8 rejections', () => {
  const { rejections, gasSteps } = replay(path.join(FIXTURES, 'glow-capture.jsonl.gz'));
  assert.equal(Object.keys(rejections).filter((reason) => / rule 8 /.test(reason)).length, 0);
  // The first gas reading sets the baseline; the boiler run's 0.309 m³ step is
  // accepted in the first message that carries it.
  assert.deepEqual(gasSteps, [
    { received: '2026-10-25T16:08:22.000Z', volume: 3182.181 },
    { received: '2026-10-26T05:30:43.000Z', volume: 3182.49 },
  ]);
});

test('full capture: three export runs start and stop, and power hovering near zero at 19:00–20:00 starts none', () => {
  const { exportEvents } = replay(path.join(FIXTURES, 'glow-capture.jsonl.gz'));
  assert.deepEqual(exportEvents.map(({ received, event, power }) => `${received.slice(11, 19)} ${event} ${power}`), [
    '16:09:23 started -3877',
    '17:58:43 stopped 0',
    '18:28:23 started -3843',
    '18:35:23 stopped 0',
    '08:35:23 started -3849',
    '08:37:23 stopped 241',
  ]);
});

test('full capture: the only rejection is the impossible RSSI of +73', () => {
  const { rejections } = replay(path.join(FIXTURES, 'glow-capture.jsonl.gz'));
  assert.deepEqual(rejections, { 'STATE rssi rule 6 out_of_range': 1 });
});
