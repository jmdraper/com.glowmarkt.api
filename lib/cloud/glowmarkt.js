'use strict';

const fetch = require('node-fetch');

// app ID for Bright app - used in API calls to Glowmarkt API
const BRIGHT_APP_ID = 'b0f1b774-a586-4f72-9edd-27ead8aa7a8d';
const BASE_URL = 'https://api.glowmarkt.com/api/v0-1';

/**
 * Logs in and returns a token, or null if the API rejects the credentials.
 * Network failures throw.
 */
async function authenticate(username, password) {
  const response = await fetch(`${BASE_URL}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'applicationId': BRIGHT_APP_ID },
    body: JSON.stringify({ username, password })
  });
  const authJSON = await response.json();
  return authJSON.valid === true && authJSON.token ? authJSON.token : null;
}

/**
 * GETs an API path. Never throws for HTTP errors: returns { status, body, ok,
 * authFailed }. authFailed is true for a 401 or any error body, either of which
 * calls for a fresh login before retrying. Network errors throw, as does
 * running past `timeoutMs` (0, the default, waits as long as it takes).
 */
async function apiGet(path, token, { timeoutMs = 0 } = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json', 'applicationId': BRIGHT_APP_ID, 'token': token },
    timeout: timeoutMs
  });
  let body = null;
  try {
    body = await response.json();
  } catch (error) {
    body = null;
  }
  return classify(response.status, body);
}

function classify(status, body) {
  const errorBody = Boolean(body && body.error);
  return {
    status,
    body,
    ok: status >= 200 && status < 300 && body !== null && !errorBody,
    authFailed: status === 401 || errorBody
  };
}

/**
 * True for a request that timed out or that the server cut off, as /tariff on
 * some resources does after about 30 s.
 */
function isSlowFailure(error) {
  return Boolean(error) && (error.type === 'request-timeout' || error.code === 'ECONNRESET' || /socket hang up/i.test(error.message || ''));
}

/**
 * Returns the token's expiry time in ms from its JWT `exp` claim, or null if it
 * can't be read.
 */
function tokenExpiry(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch (error) {
    return null;
  }
}

/**
 * Returns a short description of an error for the settings page, without
 * response bodies, URLs or resource IDs.
 */
function summarise(error) {
  if (error && error.summary) return error.summary;
  if (error && error.type === 'system') return `Network error (${error.code || 'unknown'})`;
  const message = String((error && error.message) || error || '');
  const short = message.split(/[:{[]|https?:\/\//)[0].replace(/[0-9a-f-]{16,}/gi, '…').trim();
  return short || 'Unknown error';
}

/**
 * Makes an error with a summary for the settings page alongside the full message
 * for the log.
 */
function apiError(summary, detail) {
  const error = new Error(detail ? `${summary}: ${detail}` : summary);
  error.summary = summary;
  return error;
}

module.exports = { BRIGHT_APP_ID, authenticate, apiGet, classify, isSlowFailure, tokenExpiry, summarise, apiError };
