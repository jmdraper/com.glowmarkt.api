'use strict';

// Whether a cloud device's account needs attention: logging in has failed for
// 30 minutes, or the entry still returns 401 straight after a fresh login.
// Announced once, then not again until a request succeeds. Pure: the caller
// reports what happens and checks once a minute.

const LOGIN_FAILING_MS = 30 * 60 * 1000;

const REASONS = { loginFailing: 'login_failing', notAuthorised: 'not_authorised' };

class AccountHealth {

  constructor({ attention = null, loginFailingSince = null } = {}) {
    // the reason announced, or null while the account is OK
    this.attention = attention;
    this.loginFailingSince = loginFailingSince;
  }

  isOk() {
    return this.attention === null;
  }

  /** A login failed. Returns an event if that makes 30 minutes of failures. */
  loginFailed(now) {
    if (this.loginFailingSince === null) this.loginFailingSince = now;
    return this.check(now);
  }

  loginSucceeded() {
    this.loginFailingSince = null;
  }

  /** The entry returned 401 after a fresh login. */
  refused() {
    return this.announce(REASONS.notAuthorised);
  }

  /** A request succeeded: the account is OK again. */
  succeeded() {
    this.loginFailingSince = null;
    this.attention = null;
  }

  /** Returns { event: 'attention', reason } the first time logging in has been failing for 30 minutes. */
  check(now) {
    if (this.loginFailingSince !== null && now - this.loginFailingSince >= LOGIN_FAILING_MS) {
      return this.announce(REASONS.loginFailing);
    }
    return null;
  }

  announce(reason) {
    if (this.attention !== null) return null;
    this.attention = reason;
    return { event: 'attention', reason };
  }

  toJSON() {
    return { attention: this.attention, loginFailingSince: this.loginFailingSince };
  }

}

AccountHealth.REASONS = REASONS;

module.exports = AccountHealth;
