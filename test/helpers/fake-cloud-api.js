'use strict';

// Answers request(path, options) from the masked recording of Jon's account,
// the way the cloud device's request() does: a response body, or an error with
// the HTTP status. /readings serves any window within the ten recorded days,
// including the zero padding the API adds after /last-time.

const fs = require('fs');
const path = require('path');

const recording = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'cloud', 'display-account.json'), 'utf8'));

const RECORDED_AT = Date.parse(recording.recordedAt);

// [{ veId, resources }] for each entry, in the order the account lists them
const ENTRIES = recording.calls
  .filter((call) => call.label === 'resources')
  .map((call) => ({ veId: call.path.split('/')[2], resources: call.body.resources }));

// resource IDs by classifier and name, e.g. ID['electricity.consumption|Smart Meter, electricity consumption']
const ID = Object.fromEntries(ENTRIES[0].resources.map((r) => [`${r.classifier}|${r.name}`, r.resourceId]));

function recorded(label, resourceId) {
  return recording.calls.find((call) => call.label === label && call.path === `/resource/${resourceId}/${label.split(':')[0]}`);
}

function httpError(status) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

/**
 * Returns { request, calls }. `overrides` maps 'endpoint' or 'endpoint
 * resourceId' to a body, an Error to throw, or a function of (path, options)
 * returning either.
 */
function fakeCloudApi({ overrides = {} } = {}) {
  const calls = [];
  async function request(apiPath, options = {}) {
    calls.push({ path: apiPath, options });
    const [pathname, search] = apiPath.split('?');
    const [, , id, endpoint] = pathname.split('/');
    let override = overrides[`${endpoint} ${id}`] || overrides[endpoint];
    if (typeof override === 'function') override = override(apiPath, options);
    if (override instanceof Error) throw override;
    if (override) return override;

    const call = recorded(endpoint === 'readings' ? 'readings:recent' : endpoint, id);
    if (!call) throw httpError(404);
    if (call.status !== 200) throw httpError(call.status);
    if (endpoint !== 'readings') return call.body;

    const query = new URLSearchParams(search);
    if (query.get('offset') !== '0') throw new Error('The fake API only serves offset=0');
    const from = Date.parse(`${query.get('from')}Z`);
    const to = Date.parse(`${query.get('to')}Z`);
    return { ...call.body, data: call.body.data.filter(([seconds]) => seconds * 1000 >= from && seconds * 1000 <= to) };
  }
  return { request, calls };
}

module.exports = {
  recording, RECORDED_AT, ENTRIES, ID, recorded, fakeCloudApi,
};
