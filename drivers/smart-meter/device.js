'use strict';

const { Device } = require('homey');
const fetch = require('node-fetch');
const BRIGHT_APP_ID = 'b0f1b774-a586-4f72-9edd-27ead8aa7a8d';

class GlowmarktUKSmartMeter_device extends Device {

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('Display and CAD (API) initialized');

    const elec_cons_res = this.getStoreValue('elec_cons_res');

    // Set device unavailable until first successful poll
    this.setUnavailable().catch(this.error);

    const fetchCurrentPower = (token) => fetch(`https://api.glowmarkt.com/api/v0-1/resource/${elec_cons_res}/current`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json', 'token': token, 'applicationId': BRIGHT_APP_ID }
    }).then(r => r.json());

    const fetchTariff = (token) => fetch(`https://api.glowmarkt.com/api/v0-1/resource/${elec_cons_res}/tariff`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json', 'token': token, 'applicationId': BRIGHT_APP_ID }
    }).then(r => r.json());

    const updateDevice = async () => {
      try {
        let token = this.getStoreValue('token');
        let resource = await fetchCurrentPower(token);
        if (resource.error) {
          this.log('Power API returned error, attempting token refresh');
          token = await this.refreshToken();
          if (!token) throw new Error('Token refresh failed');
          resource = await fetchCurrentPower(token);
          if (resource.error) throw new Error(`Power API error after token refresh: ${JSON.stringify(resource.error)}`);
        }
        if (!this.getAvailable()) this.setAvailable().catch(this.error);
        this.setCapabilityValue('measure_power', resource.data[0][1]).catch(this.error);
      } catch (error) {
        this.error('updateDevice failed:', error);
        if (this.getAvailable()) {
          this.log('Device set as unavailable');
          this.setUnavailable().catch(this.error);
        }
      }
    };

    // updateTariff does not control device availability — a missing/failed tariff
    // should not mark the device unavailable if the power API is working.
    const updateTariff = async () => {
      try {
        let token = this.getStoreValue('token');
        let resource = await fetchTariff(token);
        if (resource.error) {
          this.log('Tariff API returned error, attempting token refresh');
          token = await this.refreshToken();
          if (!token) throw new Error('Token refresh failed');
          resource = await fetchTariff(token);
          if (resource.error) throw new Error(`Tariff API error after token refresh: ${JSON.stringify(resource.error)}`);
        }
        this.setCapabilityValue('tariff', Number(resource.data[0].currentRates.rate)).catch(this.error);
      } catch (error) {
        this.error('updateTariff failed:', error);
      }
    };

    // Fire initial polls without awaiting — awaiting setAvailable() inside onInit
    // breaks the Homey pairing wizard (device state must not be set before onAdded fires).
    updateDevice();
    updateTariff();

    // if pollFrequency not already set, get poll frequency from device settings or default to 10
    const settings = this.getSettings();
    if (!this.pollFrequency) {
      if (settings.pollFrequency) {
        this.pollFrequency = (settings.pollFrequency * 1000);
        this.log(`Poll frequency read from settings as ${this.pollFrequency}`);
      } else {
        this.log('Could not get poll frequency from settings; defaulting to 10000');
        this.pollFrequency = 10000;
      }
    }

    this.log(`Initiating power polling with frequency ${this.pollFrequency}`);
    this.poll = this.homey.setInterval(updateDevice, this.pollFrequency);

    this.log('Initiating tariff polling');
    this.tariffPoll = this.homey.setInterval(updateTariff, 60000);
  }

  /**
   * Refreshes the API token using stored credentials. Returns the new token or null on failure.
   * Concurrent calls are coalesced — only one refresh runs at a time.
   */
  async refreshToken() {
    if (this.refreshingToken) return null;
    this.refreshingToken = true;
    try {
      const settings = this.getSettings();
      const authResponse = await fetch('https://api.glowmarkt.com/api/v0-1/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'applicationId': BRIGHT_APP_ID },
        body: JSON.stringify({ username: settings.username, password: settings.password })
      });
      const authJSON = await authResponse.json();
      if (authJSON.valid) {
        await this.setStoreValue('token', authJSON.token);
        this.log('Token refreshed successfully');
        return authJSON.token;
      }
      this.error('Token refresh failed: credentials rejected by API');
      return null;
    } catch (error) {
      this.error('Token refresh failed:', error);
      return null;
    } finally {
      this.refreshingToken = false;
    }
  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log('Display and CAD (API) device added');
  }

  /**
   * onSettings is called when the user updates the device's settings.
   * @param {object} event the onSettings event data
   * @param {object} event.oldSettings The old settings object
   * @param {object} event.newSettings The new settings object
   * @param {string[]} event.changedKeys An array of keys changed since the previous version
   * @returns {Promise<string|void>} return a custom message that will be displayed
   */
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Display and CAD (API) settings changed');

    // if username or password changed, get new token from API and write it to token in device store
    if (changedKeys.includes('username') || changedKeys.includes('password')) {
      this.log('Credentials changed - getting new token from API');
      const authResponse = await fetch('https://api.glowmarkt.com/api/v0-1/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'applicationId': BRIGHT_APP_ID },
        body: JSON.stringify({ username: newSettings.username, password: newSettings.password })
      });
      const authJSON = await authResponse.json();
      await this.setStoreValue('token', authJSON.valid ? authJSON.token : 'VOID');
    }

    // if poll frequency changed, update variable
    if (changedKeys.includes('pollFrequency')) {
      this.pollFrequency = (newSettings.pollFrequency * 1000);
    }

    // for all changes, cancel existing polling and re-initialise device
    this.log('Re-initialising device');
    if (this.poll) this.homey.clearInterval(this.poll);
    if (this.tariffPoll) this.homey.clearInterval(this.tariffPoll);
    this.onInit();
  }

  /**
   * onRenamed is called when the user updates the device's name.
   * @param {string} name The new name
   */
  async onRenamed(name) {
    this.log('Display and CAD (API) was renamed');
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    this.log('Display and CAD (API) has been deleted');
    if (this.poll) {
      this.homey.clearInterval(this.poll);
      this.homey.clearInterval(this.tariffPoll);
    }
  }
}

module.exports = GlowmarktUKSmartMeter_device;
