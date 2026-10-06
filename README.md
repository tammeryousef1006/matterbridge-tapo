# Matterbridge Tapo Plugin

[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-support-FFDD00?logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/6sjde6vkzl)

A [Matterbridge](https://github.com/Luligu/matterbridge) plugin that brings your TP-Link Tapo plugs, power strips, bulbs and Tapo hub sensors to Matter, so you can use them in SmartThings, Apple Home, Google Home, Alexa, Home Assistant and any other Matter controller.

> **Beta:** this plugin is new. Please report what works and what doesn't in an issue, with the Matterbridge log.

## Features

- Talks to your devices **directly on your local network** (no TP-Link cloud calls), using the same login the Tapo app uses.
- Finds Tapo devices on your network automatically; add IP addresses by hand when it can't.
- Sensors behind a Tapo hub (H100) appear as their own devices.
- Each function is a separate device (e.g. "Bedroom Sensor" for the temperature and "Bedroom Sensor Humidity"), so it shows up in SmartThings too.
- Changes made in the Tapo app, by hand or by automations are picked up by polling.
- Devices that stop answering show as "not responding" in your controller.
- Works with Matterbridge running on Node.js or on Bun.

## Supported devices

| Device | Examples | Exposed as |
|--------|----------|------------|
| Smart plugs | P100, P105, P110, P115, P125M, Tapo Matter plugs | Outlet (or light via `lightList`) |
| Power strips and multi-outlet plugs | P300, P304M, P306 | One outlet per socket, e.g. "Strip Outlet 2" |
| Bulbs and light strips | L510, L530, L630, L900, L920 | Dimmable light (on/off and brightness) |
| Dimmer switches | S500D | Dimmable light |
| Hub | H100 | Not shown itself; its sensors are |
| Temperature/humidity sensors | T310, T315 | Temperature sensor + separate humidity sensor, with battery |
| Motion sensor | T100 | Occupancy sensor, with battery |
| Door/window sensor | T110 | Contact sensor, with battery |
| Water leak sensor | T300 | Water leak detector, with battery |
| Hub wall switches | S210, S220 | Outlet |

Not supported yet: S200 buttons, KE100 radiator valves, the **H200 hub** (it uses a different, camera-style login) and cameras. They are skipped and logged. Open an issue if you have one.

## Prerequisites

- [Matterbridge](https://github.com/Luligu/matterbridge) 3.0.0 or later, on Node.js 20+ or Bun
- Your Tapo devices set up in the Tapo app, on the same network as Matterbridge
- The email and password of your TP-Link (Tapo app) account

## Installation

```bash
npm install -g matterbridge-tapo
matterbridge -add matterbridge-tapo
```

Or install it from the Matterbridge frontend by searching for `matterbridge-tapo`.

## Setup

1. Open the plugin's settings in the Matterbridge frontend.
2. Enter the **email** and **password** of your TP-Link account (the ones you use in the Tapo app). Both are case-sensitive.
3. Save and restart the plugin. The log lists every device it finds, e.g. `Connected to P110 "Kettle" at 192.168.68.50 (KLAP).`

Your password is only sent to your own devices, never to the internet: Tapo devices check it locally.

If some devices are not found (discovery uses a network broadcast, which some networks or Docker setups block), give them a fixed IP address in your router and add those addresses under **Device IP addresses** (`hosts`).

## Configuration

| Option | Description |
|--------|-------------|
| `email` / `password` | Your TP-Link account (required) |
| `discovery` | Find devices automatically (default `true`) |
| `hosts` | IP addresses of devices to add by hand, e.g. `192.168.68.50` |
| `refreshInterval` | Seconds between state refreshes (default `30`, minimum `10`, `0` disables) |
| `lightList` | Plugs/switches (names or device IDs) to expose as lights instead of outlets |
| `whiteList` | Only expose devices with these names or device IDs |
| `blackList` | Never expose devices with these names or device IDs |
| `debug` | Enable debug logging |

## Troubleshooting

- **"the device did not accept the TP-Link email/password"**: check both (they are case-sensitive). If you recently changed your password, open the Tapo app once so the devices learn the new one.
- **No devices found**: check that Matterbridge is on the same network as the devices (with Docker, use host networking), or add their IP addresses under `hosts`.
- **A device shows "not responding"**: it didn't answer the last refresh. Check its Wi-Fi. It comes back by itself.
- **Sensor values update slowly**: hub sensors report every few minutes to the hub; the plugin reads the hub every `refreshInterval` seconds.
- **A device is skipped as unsupported**: enable `debug`, restart, and include the logged device info in an issue.

## How it works

Tapo devices accept local commands over HTTP, encrypted with one of two protocols: **KLAP** (newer firmware) or **securePassthrough** (older firmware, H100 hub). Both use your TP-Link account to log in. The plugin works out which one each device uses. Hub sensors are read and controlled through the hub. The protocol details come from the open-source [python-kasa](https://github.com/python-kasa/python-kasa) and [plugp100](https://github.com/petretiandrea/plugp100) projects.

## Development

```bash
npm install
npm install --no-save matterbridge   # provided by Matterbridge at runtime
npm test                             # Node
bun test ./test/                     # Bun (after npm run build)
```

The tests run against a fake Tapo device that speaks both protocols.

## Support

If this plugin is useful to you, you can support its development:

<a href="https://buymeacoffee.com/6sjde6vkzl"><img src="https://img.shields.io/badge/Buy%20me%20a%20coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black" alt="Buy me a coffee"></a>

## License

ISC
