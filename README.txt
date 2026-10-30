The Glowmarkt Display and CAD (Consumer Access Display) shows real-time usage and tariff information from your UK smart meter. This app brings those readings into Homey in two ways.

Electricity meter (cloud), formerly Display and CAD (API), reads your electricity from the Glowmarkt cloud. Add it with your Bright app login. It shows current power and the imported energy total, and appears in Homey Energy as a whole-home meter. It also shows electricity used today and yesterday with its cost, your unit rate and standing charge, and has flow cards for each day's figures, exporting, and a meter or account that stops working. Power updates every 10 seconds by default.

Gas meter (cloud) shows your gas for the latest complete day, with its cost, unit rate and standing charge, and a flow card for each day as it arrives. It works with or without a display: Glowmarkt receives gas a day or more late on some accounts and through the day on others, and the device waits until a day's figures have stopped changing.

Daily costs on the cloud devices include the day's standing charge, as in the Bright app. Costs use the unit rate and standing charge Glowmarkt reports, which may not match a time-of-use tariff.

Electricity meter (local) and Gas meter (local) read your display's local MQTT feed directly, without the internet. The app runs its own MQTT broker, or connects to one you already have. The electricity meter shows live power (negative while you export) and imported and exported energy; the gas meter shows gas in m³ for Homey Energy, and gas energy in kWh. Both show the tariff, standing charge and the display's link to your smart meter, warn when the display stops sending data, and have flow cards, including started and stopped exporting on the electricity meter. They need display firmware 1.8.12 or later, and a fixed IP address for Homey.

Nothing runs for the local meters, and no network port is opened, until you add one. The app needs Homey 12.9.0 or later.
