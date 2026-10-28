# Homey app for Glowmarkt UK Smart Meter

The [Glowmarkt Display and CAD \(Consumer Access Display\)](https://shop.glowmarkt.com) allows you to see real time usage and tariff information from your UK smart meter. Versions are available to connect to most UK SMETS 1 and SMETS 2 meters. This app brings your smart meter readings into Homey in two ways:

* **Electricity meter (cloud)** and **Gas meter (cloud):** devices that read your meter data from the Glowmarkt cloud. The electricity meter, formerly *Display and CAD (API)*, shows live power and daily figures; the gas meter shows each day's gas once Glowmarkt has it.
* **Glow electricity meter (local) and Glow gas meter (local):** devices that read your display's local MQTT feed directly, without the internet. These add live gas, exported electricity and display link status.

You can use either or both. Nothing changes for the cloud devices if you never add a local one: the app doesn't run anything for the local devices, or open any network port, until you add one.

You will need to download the Bright app by Hildebrand Technology Limited and create an account to get started. You must have an account before you can purchase a Display and CAD from the Glowmarkt shop. Make sure you get the right version of the device for your meter (SMETS1 or SMETS2). See here for more information: https://energyguide.org.uk/smets2-smart-meters/.

The app needs Homey firmware 12.9.0 or later.

## Setting up the cloud devices

Once you have your device set up and working with the Bright app, you can add it to Homey. (In theory, you should also be able to use this to connect a Glowmarkt Zigbee CAD as well but I don't have one of those devices so have not been able to test.)

When you add a cloud device in Homey, you will be asked to enter your Bright app credentials. This is the same username and password you use to connect in your Bright app. The pairing process will then show any 'virtual entities' connected to your account. A virtual entity broadly equates to a single metered supply so generally there should be exactly one of these. Entries that Glowmarkt won't give readings for, or that have no electricity (or gas, for the gas meter), are left out. Add the electricity meter and the gas meter separately; they share the login.

The app's settings page has a Cloud section showing, for each account, when each device last read successfully, the last error, any entries left out at pairing, and when the login next renews. For each device it also shows which of Glowmarkt's copies of each reading it uses, how recent each one's data is, and the last tariff Glowmarkt gave. A list of recent cloud events (logins, errors, each tariff request and the flow cards fired) can be copied from there for a bug report.

Costs come from Glowmarkt, which prices each half hour, and are for energy only, without the standing charge.

### Electricity meter (cloud)

Once you have paired the device, you should see current power usage readings appearing right away on the tile and the tariff is shown in the device view. The device will also appear as a Smart Meter in the energy tab in the Homey app. The smart meter measures your home's total energy usage and so Homey subtracts the power usage of all other devices it knows about from this figure and shows the difference as 'Other'. More information on this feature here: https://support.homey.app/hc/en-us/articles/360010187820-Saving-energy-with-Homey-Energy

By default, the current power usage is updated every 10s (which is approximately the frequency with which the Glowmarkt CAD updates the Glowmarkt API). You can change this in the device's advanced settings to anything from 10s to 3600s (1 hour). The tariff is updated every half hour, just after the hour and half hour, and the daily figures every 15 minutes.

It shows:

* **Power, energy and tariff:** live power, the imported energy total that feeds Homey Energy, and the unit rate.
* **Electricity today:** energy imported since midnight, from the meter's import register. It needs a reading from just before midnight, so it stays empty until the next midnight after you add the device, or if Homey was off over midnight.
* **Electricity yesterday** and **Electricity cost yesterday:** Glowmarkt first fills each day from your display, then replaces it with the meter's own figures. These show yesterday only once that has happened, and are empty until then.
* **Standing charge**, from your tariff in Glowmarkt.
* **Data up to:** the time of Glowmarkt's latest electricity reading.

Only the power and imported energy total feed Homey Energy.

Flow cards:

* *Meter stopped reporting* and *Meter resumed reporting*, and the *Meter is reporting* condition: Glowmarkt's live power reading hasn't moved, or couldn't be fetched, for longer than the device's *Stale after* setting (5 minutes by default).
* *Account needs attention*, with the reason, and the *Account is OK* condition: fires once when logging in has failed for 30 minutes, or Glowmarkt refuses the meter even after logging in again, and again only after the account has worked in between.
* *Started exporting* and *Stopped exporting*, with the power, and the *Is exporting* condition: power has been negative, or zero or positive, for a minute.
* *New day's figures*: once a day, when yesterday's figures are final, with the date, kWh and cost in £.
* *Tariff changed*: the unit rate has changed.

### Gas meter (cloud)

Glowmarkt receives gas from your meter's data service in whole days, a day or more late, whether or not you have a display. So this device shows the latest complete day rather than anything live, and it can't feed Homey Energy. For live gas, use the local gas meter with a Glow display.

It shows:

* **Latest complete day**: its date, the gas used and its cost.
* **Tariff** and **Standing charge**, from your gas tariff in Glowmarkt. If Glowmarkt never gives a gas tariff for your meter, you can enter the standing charge in the device's settings.
* **Data up to:** the end of the latest half hour Glowmarkt has gas for.

The daily figures are checked every hour and the tariff every half hour.

Flow cards:

* *New day's figures*: once for each day of gas as it arrives, with the date, kWh and cost in £. If several days arrive at once, it fires once for each, oldest first.
* *Data is late*, with the days behind, and the *Data is up to date* condition: Glowmarkt's gas data is more than 3 days old. Fires once, and again only after the data has caught up.
* *Account needs attention* and the *Account is OK* condition, as on the electricity meter.

## Local meters (display MQTT)

### What you need

* A Glow display with firmware 1.8.12 or later, or a Glow Ethernet CAD.
* A fixed IP address for Homey: set up a DHCP reservation in your router. The display needs an IP address, not a name, and the feed stops if Homey's address changes.

### Setting up

1. Open the app's settings in Homey. By default the app runs its own MQTT broker on port 1884. You can change the port, require a username and password, or use an external MQTT broker instead.
2. Add a *Glow electricity meter (local)* or *Glow gas meter (local)* device. The pairing screen shows exactly what to enter on the display.
3. On the display, open Settings → Metering → MQTT and enter Homey's IP address, the port, the topic prefix (`glow` by default) and, if you turned it on, the username and password. An Ethernet CAD without a screen is set up at managecads.glowmarkt.com instead.
4. As soon as the display sends a reading, the pairing screen lists it. Choose it and add it.

The broker accepts readings from the display without a password unless you turn authentication on. It never lets other devices on your network subscribe and read your meter data, unless authentication is on and they log in with the same username and password. That's useful for checking the feed with a tool such as `mosquitto_sub`.

The settings page shows the broker's status, each display it has heard from, and a debug log of recent messages. Meter numbers (MPAN, MPRN) and other identifiers are masked to their last four characters there and in the app's logs.

### The devices

* **Glow electricity meter (local):** live power in W (negative while you're exporting), imported and exported energy totals, tariff, standing charge and display link status.
* **Glow gas meter (local):** gas used in m³, gas energy in kWh, tariff, standing charge and display link status. Gas meters report every half hour, so the reading moves in half-hourly steps.

Both devices feed Homey Energy. **The electricity device registers as a whole-home meter.** If you already have one, such as a P1 meter, an inverter's meter or the *Electricity meter (cloud)* device, exclude one of them in Energy so your usage isn't counted twice.

If your display doesn't report gas volume, the gas device shows a warning and can't feed Homey Energy.

The tariff and standing charge are shown in pence. *Tariff changed* fires only if your supplier has programmed time-of-use rates into the meter. Many tariffs, including Octopus Flux, hold a single rate in the meter and bill time-of-use rates from half-hourly data, so the meter's rate never changes.

Readings that are clearly wrong, such as a total going backwards, a jump bigger than a home could use, or the protocol's "no reading" values, are skipped and counted on the settings page rather than shown.

### When a meter stops reporting

If no data arrives from the display for a meter for longer than the device's *Stale after* setting (5 minutes by default), the device shows "No data from the display for N minutes" and fires *Meter stopped reporting*. The next message clears it and fires *Meter resumed reporting*. *Meter is reporting* is also available as a condition.

**What this can't detect.** A gas meter, or the smart meter hub's copy of its readings, that has stopped reporting while the display keeps re-sending its last value looks exactly like a house using no gas. A flat reading is normal with the heating off or the house empty, so there's no "no change for N hours" check: it would cause false alarms. *Meter stopped reporting* means the display itself has gone quiet.

*Display link status changed* and the *Display link is connected* condition show the display's connection to the smart meter hub, not the gas meter's. A new status counts only once it has lasted a minute, so a brief blip doesn't fire the card.

## Limitations

* The cloud devices need an internet connection and the Glowmarkt service. The local devices don't.
* Historical data isn't supported.
* The display's day, week and month counters and its own cost figures aren't used: they can be unreliable around midnight, clock changes and some tariffs.
