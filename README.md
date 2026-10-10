# Matterbridge Tapo Plugin

[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-support-FFDD00?logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/6sjde6vkzl)

A [Matterbridge](https://github.com/Luligu/matterbridge) plugin that brings your TP-Link **Tapo** and **Kasa** plugs, power strips, bulbs, light strips and the sensors behind Tapo hubs to Matter, so you can use them in SmartThings, Apple Home, Google Home, Alexa, Home Assistant and any other Matter controller.

> This plugin is new. Please report what works and what doesn't in an [issue](https://github.com/tammeryousef1006/matterbridge-tapo/issues), with the Matterbridge log.

## Features

- Talks to your devices **directly on your local network** (no TP-Link cloud calls), using the same login as the Tapo/Kasa apps.
- Finds Tapo and Kasa devices on your network automatically; add IP addresses by hand when it can't.
- Sensors and switches behind a Tapo hub (H100, H200, H500) appear as their own devices.
- Each function is a separate device (e.g. "Bedroom Sensor" for the temperature and "Bedroom Sensor Humidity"; each power strip socket), so it shows up in SmartThings too.
- Colour and white temperature for colour bulbs and light strips.
- Changes made in the Tapo/Kasa apps, by hand or by automations are picked up by polling.
- Devices that stop answering show as "not responding" in your controller.
- Works with Matterbridge running on Node.js or on Bun.

## Supported devices

| Device | Examples | Exposed as |
|--------|----------|------------|
| Tapo smart plugs | P100, P105, P110, P115, P125M | Outlet (or light via `lightList`) |
| Tapo power strips | P300, P304M, P306 | One outlet per socket, e.g. "Strip Outlet 2" |
| Tapo bulbs and light strips | L510, L530, L630, L900, L920, L930 | Dimmable, white-tunable or colour light |
| Tapo dimmer switches | S500D | Dimmable light |
| Kasa plugs and switches | HS100/HS103/HS105/HS110, KP100/KP115/KP125, HS200 | Outlet |
| Kasa power strips | HS300, KP303, KP400, EP40, HS107 | One outlet per socket |
| Kasa dimmers | HS220, KS220 | Dimmable light |
| Kasa bulbs and light strips | KL110, KL125, KL130, KL400, KL420, KL430 | Dimmable, white-tunable or colour light |
| Tapo hubs | H100, H200, H500 | Not shown themselves; their sensors and switches are. Optionally the hub's siren as a switch (`sirenSwitch`) |
| Temperature/humidity sensors | T310, T315 | Temperature sensor + separate humidity sensor, with battery |
| Motion sensor | T100 | Occupancy sensor, with battery |
| Door/window sensor | T110 | Contact sensor, with battery |
| Water leak sensor | T300 | Water leak detector, with battery |
| Hub wall switches | S210, S220 | Outlet |

Not supported yet: cameras (also cameras paired to an H200/H500), S200 buttons and KE100 radiator valves. They are skipped and logged. Open an issue if you have one.

## Prerequisites

- [Matterbridge](https://github.com/Luligu/matterbridge) 3.0.0 or later, on Node.js 20+ or Bun
- Your devices set up in the Tapo or Kasa app, on the same network as Matterbridge
- The email and password of your TP-Link account (the same one for the Tapo and Kasa apps)

## Installation

```bash
npm install -g matterbridge-tapo
matterbridge -add matterbridge-tapo
```

Or install it from the Matterbridge frontend by searching for `matterbridge-tapo`.

## Setup

1. Open the plugin's settings in the Matterbridge frontend.
2. Enter the **email** and **password** of your TP-Link account (the ones you use in the Tapo app). Both are case-sensitive.
3. Save and restart the plugin. The log lists every device it finds, e.g. `Connected to P110 "Kettle" at 192.168.68.50 (KLAP).` or `Connected to H500 "HomeBase" at 192.168.68.60 (HTTPS).`

Your password is only sent to your own devices, never to the internet: Tapo devices check it locally.

If some devices are not found (discovery uses a network broadcast, which some networks or Docker setups block), give them a fixed IP address in your router and add those addresses under **Device IP addresses** (`hosts`).

## Configuration

| Option | Description |
|--------|-------------|
| `email` / `password` | Your TP-Link account (required) |
| `discovery` | Find devices automatically (default `true`) |
| `hosts` | IP addresses of devices to add by hand, e.g. `192.168.68.50` |
| `refreshInterval` | Seconds between state refreshes (default `30`, minimum `10`, `0` disables) |
| `hubRefreshInterval` | Seconds between reads of the sensors behind a hub (default `2`, minimum `1`, `0` disables) |
| `motionHoldTime` | Seconds a motion sensor stays "motion detected" after the last movement (default `30`) |
| `sirenSwitch` | Show each hub's siren as a separate switch, e.g. "Tapo_H500 Siren" (default `false`). Matter has no siren device type, so it is a switch: on starts the siren, off stops it, and it turns off by itself when the siren stops. A "turn everything on" command would start it too, which is why it is off by default |
| `sirenSound` / `sirenVolume` / `sirenDuration` | Optional siren sound (as named in the Tapo app, e.g. `Alarm 1`), volume (1-10) and duration in seconds; empty keeps the hub's settings |
| `lightList` | Plugs/switches (names or device IDs) to expose as lights instead of outlets |
| `whiteList` | Only expose devices with these names or device IDs |
| `blackList` | Never expose devices with these names or device IDs |
| `debug` | Enable debug logging |

## Troubleshooting

- **"the device did not accept the TP-Link email/password"**: check both (they are case-sensitive). If you recently changed your password, open the Tapo app once so the devices learn the new one.
- **No devices found**: check that Matterbridge is on the same network as the devices (with Docker, use host networking), or add their IP addresses under `hosts`.
- **A device shows "not responding"**: it didn't answer the last refresh. Check its Wi-Fi. It comes back by itself.
- **Sensor values update slowly**: door and motion sensors are read through the hub every `hubRefreshInterval` seconds (2 by default). Temperature and humidity sensors only report to the hub every few minutes themselves.
- **A device is skipped as unsupported**: enable `debug`, restart, and include the logged device info in an issue.

## How it works

TP-Link devices accept local commands, with one of these protocols. The plugin works out which one each device uses:

| Protocol | Devices | Login |
|----------|---------|-------|
| KLAP (HTTP) | Newer Tapo plugs, bulbs, strips; newer Kasa firmware | TP-Link account |
| securePassthrough (HTTP) | Older Tapo firmware, H100 hub | TP-Link account |
| HTTPS "smartcam" | H200 and H500 hubs | TP-Link account password |
| Kasa XOR (TCP 9999) | Older Kasa firmware | None |

Hub sensors are read and controlled through the hub. The protocol details come from the open-source [python-kasa](https://github.com/python-kasa/python-kasa) and [plugp100](https://github.com/petretiandrea/plugp100) projects.

## Development

```bash
npm install
npm install --no-save matterbridge   # provided by Matterbridge at runtime
npm test                             # Node
bun test ./test/                     # Bun (after npm run build)
```

The tests run against fake devices that speak each protocol (KLAP, securePassthrough, HTTPS hub and Kasa XOR).

## Support

If this plugin is useful to you, you can support its development:

<a href="https://buymeacoffee.com/6sjde6vkzl"><img src="https://img.shields.io/badge/Buy%20me%20a%20coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black" alt="Buy me a coffee"></a>

## License

ISC
