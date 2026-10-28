'use strict';

// Records Glowmarkt API responses from a real account, for fixtures and for
// checking how the API behaves.
//
//   node scripts/record-cloud-fixtures.js                 full recording
//   node scripts/record-cloud-fixtures.js --current 20    /current only, every 10 s for 20 minutes
//   node scripts/record-cloud-fixtures.js --share         full recording, masked, to send to Jon
//
// Asks for the Bright app login. The password and token are never stored,
// printed or written to a file. Only GET requests follow the login, and never
// /catchup, which asks Hildebrand to fetch data again. Writes
// test/fixtures/raw/cloud/<name>-<time>.json (gitignored), one entry per call
// with its status, time taken and body. Run scripts/make-fixtures.js on that
// file to get a fixture that's safe to commit.
//
// With --share, it writes only glowmarkt-share-<time>.json in the current
// folder instead, with every identifier replaced by a stand-in as
// make-fixtures.js does (see scripts/cloud-recording.js), and lists the text
// it kept so you can check it before sending.
//
// A full recording takes a few minutes: /tariff on some resources hangs until
// the 35 s timeout. At the end it prints a summary with IDs cut to their last
// four characters, safe to paste into chat.
//
// The full recording covers, for every resource on every entry: /current,
// /last-time and 10 local days of half-hourly /readings; /meterread and /tariff
// on consumption resources; and, on consumption and cost resources, one local
// day requested three ways (local times with the London offset, UTC times with
// offset 0, and local times up to the next midnight) for yesterday, the latest
// clock-change day and the day before it.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const fetch = require('node-fetch');

const { BRIGHT_APP_ID, authenticate } = require('../lib/cloud/glowmarkt');
const { formatRecording, maskRecording, describeMasking } = require('./cloud-recording');

const BASE_URL = 'https://api.glowmarkt.com/api/v0-1';
const TIMEOUT_MS = 35 * 1000;
const CURRENT_EVERY_MS = 10 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const OUT_DIR = path.join(__dirname, '..', 'test', 'fixtures', 'raw', 'cloud');

const tail = (id) => (id && String(id).length > 4 ? `…${String(id).slice(-4)}` : String(id));

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    rl._writeToOutput = (text) => {
      if (!muted) rl.output.write(text);
    };
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
    muted = hidden;
  });
}

const calls = [];

/**
 * GETs an API path and records the call. Never throws: network errors and
 * timeouts are recorded with status null.
 */
async function get(token, label, apiPath, query) {
  if (/\/catchup\b/.test(apiPath)) throw new Error('This script never calls /catchup');
  const search = query ? `?${new URLSearchParams(query)}` : '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  const call = { label, path: apiPath, query: query || null };
  try {
    const response = await fetch(`${BASE_URL}${apiPath}${search}`, {
      headers: { 'Content-Type': 'application/json', applicationId: BRIGHT_APP_ID, token },
      signal: controller.signal,
    });
    const text = await response.text();
    call.status = response.status;
    try {
      call.body = JSON.parse(text);
    } catch (error) {
      call.text = text.slice(0, 2000);
    }
  } catch (error) {
    call.status = null;
    call.error = error.name === 'AbortError' ? `timeout after ${TIMEOUT_MS / 1000} s` : `${error.name}: ${error.code || error.message}`;
  } finally {
    clearTimeout(timer);
  }
  call.ms = Date.now() - started;
  call.at = new Date(started).toISOString();
  calls.push(call);
  return call;
}

// London time ---------------------------------------------------------------

const londonParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

/** London's offset from UTC at an instant, in minutes: 60 in summer, 0 in winter. */
function londonOffset(ms) {
  const p = Object.fromEntries(londonParts.formatToParts(new Date(ms)).map(({ type, value }) => [type, value]));
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/** The London date ('YYYY-MM-DD') at an instant. */
function londonDate(ms) {
  return new Date(ms + londonOffset(ms) * 60000).toISOString().slice(0, 10);
}

/**
 * The instant London's day starts. Clocks change at 01:00 UTC, so the offset at
 * 00:00 UTC is the offset at local midnight.
 */
function londonMidnight(date) {
  const utcMidnight = Date.parse(`${date}T00:00:00Z`);
  return utcMidnight - londonOffset(utcMidnight) * 60000;
}

const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const utcString = (ms) => new Date(ms).toISOString().slice(0, 19);
const londonString = (ms) => new Date(ms + londonOffset(ms) * 60000).toISOString().slice(0, 16).replace('T', ' ');

/** The latest London day before `today` that isn't 24 hours long. */
function latestClockChange(today) {
  for (let date = addDays(today, -1), i = 0; i < 400; date = addDays(date, -1), i++) {
    if (londonMidnight(addDays(date, 1)) - londonMidnight(date) !== DAY_MS) return date;
  }
  return null;
}

/** The three ways of asking for one local day's half hours. */
function dayQueries(date) {
  const start = londonMidnight(date);
  const end = londonMidnight(addDays(date, 1));
  const offset = String(-londonOffset(start));
  const base = { period: 'PT30M', function: 'sum' };
  return {
    local: { from: `${date}T00:00:00`, to: `${date}T23:59:59`, offset, ...base },
    utc: { from: utcString(start), to: utcString(end - 1000), offset: '0', ...base },
    localToMidnight: { from: `${date}T00:00:00`, to: `${addDays(date, 1)}T00:00:00`, offset, ...base },
  };
}

// Recording -----------------------------------------------------------------

async function recordAll(token, now) {
  const today = londonDate(now);
  const clockChange = latestClockChange(today);
  const probeDays = [...new Set([addDays(today, -1), clockChange, clockChange && addDays(clockChange, -1)].filter(Boolean))];
  const recentFrom = londonMidnight(addDays(today, -9));
  const recent = { from: utcString(recentFrom), to: utcString(now), offset: '0', period: 'PT30M', function: 'sum' };

  const list = await get(token, 'virtualentity', '/virtualentity');
  if (list.status !== 200 || !Array.isArray(list.body)) throw new Error(`Listing entries failed (HTTP ${list.status})`);

  for (const ve of list.body) {
    console.log(`Entry ${tail(ve.veId)} "${ve.name}"`);
    const resources = await get(token, 'resources', `/virtualentity/${ve.veId}/resources`);
    if (resources.status !== 200 || !Array.isArray(resources.body?.resources)) continue;

    for (const resource of resources.body.resources) {
      const id = resource.resourceId;
      const { classifier } = resource;
      console.log(`  ${classifier} (${resource.name}) ${tail(id)}`);
      await get(token, 'current', `/resource/${id}/current`);
      await get(token, 'last-time', `/resource/${id}/last-time`);
      await get(token, 'readings:recent', `/resource/${id}/readings`, recent);

      if (/\.(consumption|cost)$/.test(classifier)) {
        for (const date of probeDays) {
          for (const [how, query] of Object.entries(dayQueries(date))) {
            await get(token, `readings:${date}:${how}`, `/resource/${id}/readings`, query);
          }
        }
      }
      if (/\.consumption$/.test(classifier)) {
        await get(token, 'meterread', `/resource/${id}/meterread`);
        process.stdout.write('    /tariff… ');
        const tariff = await get(token, 'tariff', `/resource/${id}/tariff`);
        console.log(tariff.error || `HTTP ${tariff.status} in ${(tariff.ms / 1000).toFixed(1)} s`);
      }
    }
  }
  return { today, probeDays };
}

async function recordCurrent(token, minutes) {
  const list = await get(token, 'virtualentity', '/virtualentity');
  if (list.status !== 200 || !Array.isArray(list.body)) throw new Error(`Listing entries failed (HTTP ${list.status})`);
  const ids = [];
  for (const ve of list.body) {
    const resources = await get(token, 'resources', `/virtualentity/${ve.veId}/resources`);
    for (const resource of resources.body?.resources || []) {
      if (resource.classifier === 'electricity.consumption') ids.push(resource.resourceId);
    }
  }
  console.log(`Polling /current on ${ids.length} electricity resources every ${CURRENT_EVERY_MS / 1000} s for ${minutes} min.`);
  const until = Date.now() + minutes * 60000;
  while (Date.now() < until) {
    const started = Date.now();
    for (const id of ids) {
      const call = await get(token, 'current', `/resource/${id}/current`);
      const [time, watts] = call.body?.data?.[0] || [];
      console.log(`  ${tail(id)} ${call.status} ${watts ?? '-'} W at ${time ? londonString(time * 1000) : '-'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, CURRENT_EVERY_MS - (Date.now() - started))));
  }
}

// Summary -------------------------------------------------------------------

const rows = (call) => (Array.isArray(call.body?.data) ? call.body.data.filter((row) => Array.isArray(row)) : []);

function describeReadings(call) {
  if (call.status !== 200) return `HTTP ${call.status}${call.error ? ` (${call.error})` : ''}`;
  const data = rows(call);
  if (!data.length) return 'no rows';
  const nonZero = data.filter(([, value]) => value);
  const total = data.reduce((sum, [, value]) => sum + (Number(value) || 0), 0);
  return `${data.length} rows, ${londonString(data[0][0] * 1000)} to ${londonString(data[data.length - 1][0] * 1000)} London, `
    + `${nonZero.length} non-zero, total ${total.toFixed(3)}`
    + (nonZero.length ? `, last non-zero ${londonString(nonZero[nonZero.length - 1][0] * 1000)}` : '');
}

function printSummary(classifiers) {
  console.log('\nSummary (IDs cut to 4 characters)');
  const byResource = new Map();
  for (const call of calls) {
    const match = call.path.match(/^\/resource\/([^/]+)\//);
    if (!match) continue;
    if (!byResource.has(match[1])) byResource.set(match[1], []);
    byResource.get(match[1]).push(call);
  }
  for (const [id, resourceCalls] of byResource) {
    console.log(`\n${classifiers.get(id) || '?'} ${tail(id)}`);
    for (const call of resourceCalls) {
      let text;
      if (call.label === 'current') {
        const [time, value] = call.body?.data?.[0] || [];
        text = call.status === 200 ? `${value} at ${time ? londonString(time * 1000) : '?'}, units ${JSON.stringify(call.body?.units ?? null)}` : `HTTP ${call.status}`;
      } else if (call.label === 'meterread') {
        // the cloud device sets meter_power.imported to the electricity value / 1000;
        // gas says "m3" but counts litres
        const [time, value] = call.body?.data?.[0] || [];
        const scaled = /^electricity/.test(classifiers.get(id)) ? `the device would show ${value / 1000} kWh` : `${value / 1000} m³`;
        text = call.status === 200
          ? `${value} at ${time ? londonString(time * 1000) : '?'}, units ${JSON.stringify(call.body?.units ?? null)}; ${scaled}`
          : `HTTP ${call.status}`;
      } else if (call.label === 'last-time') {
        text = call.status === 200 ? JSON.stringify(call.body).replace(/[0-9a-f-]{32,}/gi, (s) => tail(s)) : `HTTP ${call.status}`;
      } else if (call.label === 'tariff') {
        const entry = call.body?.data?.[0];
        text = call.status === 200 ? `${(call.ms / 1000).toFixed(1)} s, ${entry?.type}, ${JSON.stringify(entry?.currentRates ?? null)}` : `${call.error || `HTTP ${call.status}`} after ${(call.ms / 1000).toFixed(1)} s`;
      } else {
        text = `${describeReadings(call)}${call.query ? `  [from ${call.query.from} to ${call.query.to} offset ${call.query.offset}]` : ''}`;
      }
      console.log(`  ${call.label}: ${text}`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const share = args.includes('--share');
  const currentIndex = args.indexOf('--current');
  const currentMinutes = currentIndex >= 0 ? Number(args[currentIndex + 1]) : null;
  if ((currentIndex >= 0 && !(currentMinutes > 0)) || (share && currentMinutes)) {
    console.error('Usage: node scripts/record-cloud-fixtures.js [--current <minutes> | --share]');
    process.exit(1);
  }

  const username = process.env.GLOWMARKT_USERNAME || (await ask('Bright app username (email): ')).trim();
  const token = await authenticate(username, await ask('Password (not shown): ', { hidden: true }));
  if (!token) {
    console.error('Login failed.');
    process.exit(1);
  }
  console.log('Logged in.');

  const now = Date.now();
  const stamp = utcString(now).replace(/[-:]/g, '').replace('T', '-');
  let meta = {};
  try {
    if (currentMinutes) await recordCurrent(token, currentMinutes);
    else meta = await recordAll(token, now);
  } finally {
    const recording = { recordedAt: new Date(now).toISOString(), meta, calls };
    let file;
    let text;
    if (share) {
      const result = maskRecording(recording);
      if (result.leaks.length) throw new Error(`Not written: ${result.leaks.length} replaced values still appear in the masked file.`);
      file = path.resolve(`glowmarkt-share-${stamp}.json`);
      text = result.text;
      console.log(`\n${describeMasking(result).join('\n')}`);
    } else {
      file = path.join(OUT_DIR, `${currentMinutes ? 'current' : 'account'}-${stamp}.json`);
      text = formatRecording(recording);
    }
    if (text.includes(token)) throw new Error('Not written: the token appears in the recording.');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    console.log(`\nWrote ${calls.length} calls to ${path.relative(process.cwd(), file) || file}`);
  }

  if (!currentMinutes) {
    const classifiers = new Map();
    for (const call of calls) {
      for (const resource of call.label === 'resources' ? call.body?.resources || [] : []) {
        classifiers.set(resource.resourceId, `${resource.classifier} (${resource.name})`);
      }
    }
    printSummary(classifiers);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { londonOffset, londonDate, londonMidnight, latestClockChange, dayQueries };
