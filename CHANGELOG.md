# Changelog

## 1.1.0-beta.2 (2026-10-10)
- The log shows the plugin version and whether hub sirens are shown at startup

## 1.1.0-beta.1 (2026-10-10)
- Hub siren as a switch (`sirenSwitch`, off by default): H100, H200 and H500 hubs get a separate "<hub> Siren" switch that starts and stops the siren and turns off by itself when the siren stops
- Optional siren sound, volume (1-10) and duration (`sirenSound`, `sirenVolume`, `sirenDuration`); empty keeps the hub's own settings

## 1.0.0 (2026-10-06)
- First release, tested with an H500 hub (T110, T100), a Kasa KP303 strip, L930/L920 light strips, L535 bulbs and P110/P110M plugs on SmartThings
- Local control of Tapo and Kasa devices with the TP-Link account, over KLAP, securePassthrough, HTTPS (H200/H500) or the Kasa XOR protocol; works on Node.js and Bun
- Everything from the 0.1.0 betas below

## 0.1.0-beta.3 (2026-10-06)
- Hub sensors respond within seconds: hubs are read every 2 seconds (`hubRefreshInterval`) instead of with the 30 second refresh
- Motion sensors (T100) also read their event log, so a short movement between two reads is still reported; motion is held for `motionHoldTime` (default 30 seconds)
- Door and motion changes are written to the log

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
