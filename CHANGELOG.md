# Changelog

## 0.1.0-beta.2 (2026-10-06)
- H200 and H500 hubs (HTTPS login): their sensors (T310/T315, T100, T110, T300) and S210/S220 switches; cameras paired to the hub are skipped for now
- Kasa devices: plugs, power strips (one outlet per socket), dimmers, bulbs and light strips, over the older Kasa protocol (port 9999) or KLAP; found by discovery too
- Colour and white temperature for Tapo and Kasa colour bulbs and light strips
- Devices added by IP address are tried with every protocol

## 0.1.0-beta.1 (2026-10-06)
- First test build
- Local control of Tapo devices with the TP-Link account email/password, over KLAP or securePassthrough (detected per device); works on Node.js and Bun
- Automatic discovery on the local network, plus manual IP addresses (`hosts`)
- Plugs as outlets (or lights via `lightList`), power strip sockets as separate outlets, bulbs and dimmers as dimmable lights
- H100 hub sensors as separate devices: T310/T315 temperature and humidity, T100 motion, T110 door/window, T300 water leak, with battery level; S210/S220 hub switches
- State polling (`refreshInterval`, default 30 seconds) and unresponsive devices reported as unreachable
- `whiteList`/`blackList` to choose which devices are exposed
