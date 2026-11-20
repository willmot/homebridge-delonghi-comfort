## Homebridge De'Longhi Comfort (PAC) Plugin

[![verified-by-homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins) [![license-apache-2](https://badgen.net/static/license/apache%202/blue)](https://github.com/willmot/homebridge-delonghi-comfort/blob/main/LICENSE) 

Provides HomeKit control for De'Longhi Comfort-connected PAC air conditioners via Homebridge.

### Install

```bash
npm i -g homebridge-delonghi-comfort
```

### Configure (config.json)

```json
{
  "platforms": [
    {
      "platform": "DelonghiComfortPlatform",
      "name": "De'Longhi Comfort",
      "username": "you@example.com",
      "password": "your-password",
      "language": "en",
      "scanInterval": 60
    }
  ]
}
```

- username/password: De'Longhi Comfort account
- language: app locale (e.g. "en", "it", "pt-br").
- scanInterval: seconds between cloud polls (30–300)

### Behavior

- Cooling-only Heater/Cooler mapping implemented (no heat mode for PAC models).
- Uses your De'Longhi Comfort account and the Ayla cloud. The plugin renews the session automatically when a polling request is unauthorized.
- Polling with accessory updates and device removal handling.
- Target state: AUTO switches device to Eco Real Feel mode; COOL switches to standard cooling.
- The PAC EL110 exposes humidity, Silent Mode, and Swing in Home when those properties are available. Its minimum cooling setpoint is 19 °C.
- Doesn't support Dehumidify Only or Fan Only modes.

### Credits

Based on the functionality described in the Home Assistant integration: `philm5/delonghi-comfort-integration` ([link](https://github.com/philm5/delonghi-comfort-integration)).

### Disclaimer

This was mostly vibe-coded to get something useful working quickly. Expect some rough edges and limited test coverage. Feedback, issues, and PRs are very welcome.

### License

Licensed under the Apache License, Version 2.0. See [LICENSE](./LICENSE) for details.
