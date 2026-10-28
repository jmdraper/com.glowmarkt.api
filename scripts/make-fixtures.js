'use strict';

// Turns a raw recording into a fixture file that's safe to commit.
//
//   node scripts/make-fixtures.js test/fixtures/raw/glow-capture.log [output.jsonl.gz]
//   node scripts/make-fixtures.js test/fixtures/raw/cloud/account-….json [output.json]
//
// A .log input is a Glow MQTT capture: `mosquitto_sub -v -F '%I %t %p'` output,
// an ISO time, the topic and the payload on each line. The output defaults to
// test/fixtures/<input name>.jsonl.gz, gzipped, one { received, topic, payload }
// object per line, with the payload kept as the original string. MPAN, MPRN,
// EUI, supplier and unit ID (the display MAC) are replaced by stand-ins numbered
// in order of first appearance, so the same value always gets the same stand-in.
// Placeholders the display sends instead of a value, such as "not available" or
// "---", are kept.
//
// A .json input is a Glowmarkt recording from scripts/record-cloud-fixtures.js.
// The output defaults to test/fixtures/cloud/<input name>.json, masked as
// described in scripts/cloud-recording.js. It refuses to write if any replaced
// value is still in the output, and lists the text values it kept, to check by
// eye.
//
// An output name not ending in .gz is written uncompressed.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { isPlaceholder } = require('../lib/glow/mask');
const { maskRecording, describeMasking } = require('./cloud-recording');

const [input, outputArg] = process.argv.slice(2);
if (!input) {
  console.error('Usage: node scripts/make-fixtures.js <capture.log | cloud-recording.json> [output]');
  process.exit(1);
}
const cloud = input.endsWith('.json');
const name = path.basename(input, path.extname(input));
const output = outputArg || (cloud
  ? path.join(__dirname, '..', 'test', 'fixtures', 'cloud', `${name}.json`)
  : path.join(__dirname, '..', 'test', 'fixtures', `${name}.jsonl.gz`));

const standIns = {
  unit: { map: new Map(), make: (n) => n.toString(16).toUpperCase().padStart(12, '0') },
  mpan: { map: new Map(), make: (n) => `99${String(n).padStart(11, '0')}` },
  mprn: { map: new Map(), make: (n) => `88${String(n).padStart(8, '0')}` },
  eui: { map: new Map(), make: (n) => `00:00:00:00:00:00:00:${n.toString(16).toUpperCase().padStart(2, '0')}` },
  supplier: { map: new Map(), make: (n) => `Supplier ${n}` },
};

function standIn(kind, value) {
  const { map, make } = standIns[kind];
  if (!map.has(value)) map.set(value, make(map.size + 1));
  return map.get(value);
}

function write(text) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, output.endsWith('.gz') ? zlib.gzipSync(text, { level: 9 }) : text);
}

function maskedCounts() {
  return Object.entries(standIns).filter(([, { map }]) => map.size).map(([kind, { map }]) => `${map.size} ${kind}`).join(', ') || 'nothing';
}

// Glow MQTT capture -----------------------------------------------------------

const KEY_KINDS = {
  mpan: 'mpan', mprn: 'mprn', eui: 'eui', supplier: 'supplier', ethmac: 'unit', wifistamac: 'unit',
};

function maskPayload(payload, unitIds) {
  let masked = payload.replace(/"(mpan|mprn|eui|supplier|ethmac|wifistamac)"\s*:\s*"([^"]*)"/g, (match, key, value) => {
    if (isPlaceholder(value)) return match;
    const kind = KEY_KINDS[key];
    const replacement = kind === 'unit' ? standIn('unit', value.toUpperCase()) : standIn(kind, value);
    return `"${key}":"${replacement}"`;
  });
  // Catch the unit ID anywhere else it appears.
  for (const [unitId, replacement] of unitIds) masked = masked.split(unitId).join(replacement);
  return masked;
}

// mosquitto's %I gives +0000-style offsets; make them ISO 8601 with a colon.
function toIso(time) {
  const ms = Date.parse(time.replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function glowCapture() {
  const lines = fs.readFileSync(input, 'utf8').split(/\r?\n/);
  const out = [];
  let skipped = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    const match = line.match(/^(\S+) (\S+) (.*)$/);
    const received = match && toIso(match[1]);
    if (!received) {
      skipped++;
      continue;
    }
    const [, , topic, payload] = match;

    const parts = topic.split('/');
    const unitIndex = parts.length >= 3 ? parts.length - (parts[parts.length - 1] === 'STATE' ? 2 : 3) : -1;
    if (unitIndex >= 0) parts[unitIndex] = standIn('unit', parts[unitIndex].toUpperCase());

    out.push(JSON.stringify({ received, topic: parts.join('/'), payload: maskPayload(payload, standIns.unit.map) }));
  }

  write(`${out.join('\n')}\n`);
  console.log(`Wrote ${out.length} messages to ${path.relative(process.cwd(), output)}; skipped ${skipped} unreadable lines; masked ${maskedCounts()}.`);
}

// Glowmarkt recording ---------------------------------------------------------

function cloudRecording() {
  const result = maskRecording(JSON.parse(fs.readFileSync(input, 'utf8')));
  if (result.leaks.length) {
    console.error(`Not written: ${result.leaks.length} replaced values still appear in the output.`);
    process.exit(1);
  }
  write(result.text);
  console.log(`Wrote ${path.relative(process.cwd(), output)}.`);
  console.log(describeMasking(result).join('\n'));
}

if (cloud) cloudRecording();
else glowCapture();
