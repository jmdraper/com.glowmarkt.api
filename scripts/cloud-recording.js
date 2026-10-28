'use strict';

// Writing and masking Glowmarkt recordings, shared by record-cloud-fixtures.js
// (its --share file) and make-fixtures.js.
//
// Masking replaces every UUID (entry, resource and owner IDs, in bodies and in
// paths), email address, UK postcode, run of 12+ hex characters or 8+ digits,
// and any value under a key that names a meter, device, address or person, with
// a stand-in numbered in order of first appearance, so the same value always
// gets the same stand-in. Resource type IDs and the Bright app ID are the same
// on every account and are kept.

const { BRIGHT_APP_ID } = require('../lib/cloud/glowmarkt');

// Keys whose values say who or where someone is, whatever they look like.
const PRIVATE_KEY = /mpan|mprn|serial|mac|eui|hardware|deviceid|meterid|address|street|town|city|county|region|locality|district|house|building|premise|postal|postcode|owner|user|email|phone|firstname|lastname|surname|^(lat|lon|lng|latitude|longitude)$/i;

// UUIDs, email addresses, UK postcodes, and runs of 12+ hex characters or 8+ digits.
const IDENTIFIER = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b|\b[0-9a-f]{12,}\b|\b\d{8,}\b/gi;

const STAND_INS = {
  uuid: (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  email: (n) => `user${n}@example.com`,
  postcode: (n) => `ZZ${n} 9ZZ`,
  digits: (n) => `77${String(n).padStart(11, '0')}`,
  hex: (n) => `FFFF${n.toString(16).toUpperCase().padStart(12, '0')}`,
  private: (n) => `private-${n}`,
};

/** A recording as text: its header on the first line, then one call per line. */
function formatRecording({ calls, ...head }) {
  return `${JSON.stringify(head).slice(0, -1)},"calls":[\n${calls.map((call) => JSON.stringify(call)).join(',\n')}\n]}\n`;
}

/**
 * Masks a recording. Returns { text, counts, kept, leaks }: the masked text,
 * the number of stand-ins of each kind, the text values left unchanged by key
 * (to check by eye), and any replaced value that still appears in the text
 * (which should never happen; don't write the text if there are any).
 */
function maskRecording(recording) {
  const maps = Object.fromEntries(Object.keys(STAND_INS).map((kind) => [kind, new Map()]));
  const standIn = (kind, value) => {
    if (!maps[kind].has(value)) maps[kind].set(value, STAND_INS[kind](maps[kind].size + 1));
    return maps[kind].get(value);
  };

  const publicIds = new Set([BRIGHT_APP_ID]);
  const collectTypes = (value) => {
    if (Array.isArray(value)) value.forEach(collectTypes);
    else if (value && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        if (key === 'resourceTypeId' && typeof inner === 'string') publicIds.add(inner.toLowerCase());
        else collectTypes(inner);
      }
    }
  };
  collectTypes(recording);

  const replaced = new Set();
  const maskText = (text) => text.replace(IDENTIFIER, (match) => {
    let kind;
    if (match.includes('@')) kind = 'email';
    else if (/^[0-9a-f]{8}-/i.test(match)) kind = publicIds.has(match.toLowerCase()) ? null : 'uuid';
    else if (/^\d+$/.test(match)) kind = 'digits';
    else if (/^[0-9a-f]+$/i.test(match)) kind = /\d/.test(match) ? 'hex' : null;
    else kind = 'postcode';
    if (!kind) return match;
    replaced.add(match);
    return standIn(kind, kind === 'uuid' ? match.toLowerCase() : match);
  });

  const kept = new Map();
  const maskValue = (value, key) => {
    if (Array.isArray(value)) return value.map((inner) => maskValue(inner, key));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([innerKey, inner]) => [innerKey, maskValue(inner, innerKey)]));
    }
    if (key && PRIVATE_KEY.test(key) && value !== null && value !== '' && typeof value !== 'boolean') {
      // an ID gets the same stand-in here as anywhere else it appears
      if (typeof value === 'string' && maskText(value) !== value) return maskText(value);
      replaced.add(String(value));
      const replacement = standIn('private', String(value));
      return typeof value === 'number' ? Number(replacement.replace(/\D/g, '')) : replacement;
    }
    if (typeof value !== 'string') return value;
    if (key === 'resourceTypeId') return value;
    const masked = maskText(value);
    if (key && masked === value) {
      if (!kept.has(key)) kept.set(key, new Set());
      kept.get(key).add(value);
    }
    return masked;
  };

  const text = formatRecording(maskValue(recording));
  const lower = text.toLowerCase();
  const leaks = [...replaced].filter((value) => value.length >= 6 && lower.includes(value.toLowerCase()));
  const counts = Object.fromEntries(Object.entries(maps).filter(([, map]) => map.size).map(([kind, map]) => [kind, map.size]));
  return { text, counts, kept, leaks };
}

/** Lines describing a masking result, for the console. */
function describeMasking({ counts, kept }) {
  const lines = [`Masked ${Object.entries(counts).map(([kind, n]) => `${n} ${kind}`).join(', ') || 'nothing'}.`,
    'Text kept unchanged, by key (check none of it identifies anyone):'];
  for (const [key, values] of [...kept].sort(([a], [b]) => a.localeCompare(b))) {
    const samples = [...values].slice(0, 3).map((value) => JSON.stringify(value.length > 50 ? `${value.slice(0, 47)}...` : value));
    lines.push(`  ${key} (${values.size}): ${samples.join(', ')}`);
  }
  return lines;
}

module.exports = { formatRecording, maskRecording, describeMasking };
