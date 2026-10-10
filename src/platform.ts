import {
  DeviceTypeDefinition,
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  PlatformConfig,
  PlatformMatterbridge,
  bridgedNode,
  contactSensor,
  colorTemperatureLight,
  dimmableLight,
  extendedColorLight,
  humiditySensor,
  occupancySensor,
  onOffLight,
  onOffPlugInUnit,
  powerSource,
  temperatureSensor,
  waterLeakDetector,
} from 'matterbridge';
import { AnsiLogger } from 'matterbridge/logger';
import {
  BooleanState,
  BridgedDeviceBasicInformation,
  ColorControl,
  LevelControl,
  OccupancySensing,
  OnOff,
  PowerSource,
  RelativeHumidityMeasurement,
  TemperatureMeasurement,
} from 'matterbridge/matter/clusters';

import {
  DeviceFunction,
  DeviceState,
  baseModel,
  brightnessToLevel,
  deviceFunctions,
  deviceState,
  hasBattery,
  hasChildren,
  hueToMatter,
  isBulb,
  isHub,
  kelvinToMireds,
  levelToBrightness,
  matterToHue,
  matterToSaturation,
  miredsToKelvin,
  saturationToMatter,
  unitName,
  xyToHueSaturation,
} from './deviceMapper.js';
import { DiscoveredDevice, discover } from './discovery.js';
import { DeviceDriver, KasaDriver, LightParams, SirenConfig, SmartCamHubDriver, SmartDriver } from './drivers.js';
import { KasaClient } from './kasaClient.js';
import { SmartCamClient } from './smartCamClient.js';
import { TapoAuthError, TapoClient, TapoParams, errorMessage } from './tapoClient.js';

export interface TapoPlatformConfig extends PlatformConfig {
  email?: string;
  password?: string;
  discovery?: boolean;
  hosts?: string[];
  refreshInterval?: number;
  hubRefreshInterval?: number;
  motionHoldTime?: number;
  sirenSwitch?: boolean;
  sirenSound?: string;
  sirenVolume?: number;
  sirenDuration?: number;
  lightList?: string[];
  whiteList?: string[];
  blackList?: string[];
}

/** One Tapo device or hub/strip child, with the Matter devices made for its functions. */
interface TapoUnit {
  /** Tapo device_id. */
  id: string;
  /** Set for hub and strip children. */
  parentId?: string;
  name: string;
  model: string;
  info: TapoParams;
  functions: DeviceFunction[];
  /** One bridged Matter device per function, keyed by function id. */
  endpoints: Map<string, MatterbridgeEndpoint>;
  /** Motion sensors: id of the newest trigger log entry seen. */
  lastLogId?: number;
  /** Motion sensors: report motion until this time (epoch ms), so short detections are not lost. */
  motionUntil?: number;
}

/** One device on the network that the plugin talks to (a plug, bulb, strip or hub). */
interface TapoHost {
  ip: string;
  driver: DeviceDriver;
  deviceId: string;
  name: string;
  model: string;
  online: boolean;
  /** Units reached through this host: the device itself and its children. */
  units: Map<string, TapoUnit>;
  /** A read is in progress (the fast hub loop and the refresh must not overlap). */
  busy: boolean;
}

const DEFAULT_REFRESH_INTERVAL_S = 30;
const MIN_REFRESH_INTERVAL_S = 10;
/** Hub sensors are read much more often: door and motion changes should show within seconds. */
const DEFAULT_HUB_REFRESH_INTERVAL_S = 2;
const MIN_HUB_REFRESH_INTERVAL_S = 1;
const DEFAULT_MOTION_HOLD_S = 30;
const LOW_BATTERY_PERCENT = 20;
const CRITICAL_BATTERY_PERCENT = 10;
const DISCOVERY_TIMEOUT_MS = 5000;
const SENSITIVE_KEYS = ['password'];

export class TapoPlatform extends MatterbridgeDynamicPlatform {
  private readonly tapoConfig: TapoPlatformConfig;
  private readonly hosts = new Map<string, TapoHost>();
  /** Addresses found or configured that could not be connected yet; retried on every refresh. */
  private readonly pending = new Map<string, DiscoveredDevice | undefined>();
  private refreshTimer: NodeJS.Timeout | undefined;
  private hubTimer: NodeJS.Timeout | undefined;
  private refreshing = false;
  private configured = false;

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig) {
    super(matterbridge, log, config);

    if (typeof this.verifyMatterbridgeVersion === 'function' && !this.verifyMatterbridgeVersion('3.0.0')) {
      throw new Error(
        `This plugin requires Matterbridge version >= "3.0.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend.`,
      );
    }

    this.tapoConfig = config as TapoPlatformConfig;
    this.log.debug('Received configuration:', JSON.stringify(redact(config), null, 2));
    this.log.info('Tapo platform initialized.');
  }

  private get credentials(): { username: string; password: string } | undefined {
    const username = this.tapoConfig.email?.trim();
    const password = this.tapoConfig.password ?? '';
    return username && password ? { username, password } : undefined;
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();

    if (!this.credentials) {
      this.log.error('Enter the email and password of your TP-Link (Tapo app) account in the plugin settings, then restart the plugin.');
      return;
    }

    if (this.tapoConfig.discovery !== false) {
      try {
        const found = await discover({ timeoutMs: DISCOVERY_TIMEOUT_MS });
        this.log.info(`Discovery found ${found.length} TP-Link device(s).`);
        for (const device of found) {
          if (device.family === 'camera') {
            this.log.info(`Skipping ${device.model} at ${device.ip}: cameras are not supported yet.`);
            continue;
          }
          if (device.family === 'other') {
            this.log.info(`Skipping ${device.model} at ${device.ip} (${device.deviceType}): not supported.`);
            continue;
          }
          this.pending.set(device.ip, device);
        }
      } catch (error) {
        this.log.error(`Discovery failed: ${errorMessage(error)}. Add your devices' IP addresses under "hosts" instead.`);
      }
    }
    for (const host of this.tapoConfig.hosts ?? []) {
      const ip = host.trim();
      if (ip && !this.pending.has(ip)) this.pending.set(ip, undefined);
    }
    if (this.pending.size === 0) this.log.warn('No Tapo devices found. If discovery does not work on your network, add the IP addresses under "hosts".');

    await this.connectPending();
  }

  /** Connect to every address not connected yet and register its devices. */
  private async connectPending(): Promise<void> {
    for (const [ip, discovered] of [...this.pending]) {
      try {
        await this.connectHost(ip, discovered);
        this.pending.delete(ip);
      } catch (error) {
        if (error instanceof TapoAuthError) {
          this.log.error(`${discovered?.model ?? 'Device'} at ${ip}: ${error.message}. Check the email and password in the plugin settings.`);
          this.pending.delete(ip);
        } else {
          this.log.warn(`Could not connect to ${discovered?.model ?? 'the device'} at ${ip}: ${errorMessage(error)}. Will retry.`);
        }
      }
    }
  }

  /** The drivers to try for an address: the one discovery points to, or every family for a manual address. */
  private driversFor(ip: string, discovered: DiscoveredDevice | undefined): DeviceDriver[] {
    // "192.168.1.20" or "192.168.1.20:8080"
    const [address, portText] = ip.split(':');
    const port = portText ? Number(portText) : undefined;
    const credentials = this.credentials!;
    const smart = (): DeviceDriver =>
      new SmartDriver(
        new TapoClient({ host: address, port: discovered?.httpPort ?? port, credentials, protocol: discovered?.protocol, loginVersion: discovered?.loginVersion, log: this.log }),
      );
    const smartCam = (): DeviceDriver => new SmartCamHubDriver(new SmartCamClient({ host: address, port: discovered?.httpPort ?? (port && port !== 80 ? port : undefined), credentials, log: this.log }));
    const kasa = (): DeviceDriver =>
      new KasaDriver(new KasaClient({ host: address, transport: discovered?.kasaTransport, port: discovered?.kasaTransport === 'klap' ? discovered.httpPort : port, credentials, log: this.log }));
    switch (discovered?.family) {
      case 'smart':
        return [smart()];
      case 'smartcam':
        return [smartCam()];
      case 'kasa':
        return [kasa()];
      default:
        return [smart(), smartCam(), kasa()];
    }
  }

  /** Read a device with the first driver that works. */
  private async readDevice(ip: string, discovered: DiscoveredDevice | undefined): Promise<{ driver: DeviceDriver; info: TapoParams; children: TapoParams[] }> {
    const errors: unknown[] = [];
    for (const driver of this.driversFor(ip, discovered)) {
      try {
        return { driver, ...(await driver.read()) };
      } catch (error) {
        // Wrong credentials are reported at once; anything else may just be the wrong family
        if (error instanceof TapoAuthError) throw error;
        this.log.debug(`${ip}: ${driver.constructor.name} failed: ${errorMessage(error)}`);
        errors.push(error);
      }
    }
    throw errors[0];
  }

  private async connectHost(ip: string, discovered: DiscoveredDevice | undefined): Promise<void> {
    // Read everything before registering anything, so a failure here can simply be retried later
    const { driver, info, children } = await this.readDevice(ip, discovered);
    if (this.tapoConfig.sirenSwitch === true && isHub(info) && driver.readSiren && typeof info._siren !== 'boolean') {
      try {
        info._siren = await driver.readSiren();
      } catch (error) {
        this.log.info(`${unitName(info) || ip} has no siren that can be controlled: ${errorMessage(error)}`);
      }
    }
    const deviceId = String(info.device_id ?? discovered?.deviceId ?? ip);
    const model = baseModel(info.model ?? discovered?.model);
    const name = unitName(info) || `${model} ${ip}`;
    if ([...this.hosts.values()].some((host) => host.deviceId === deviceId)) {
      this.log.debug(`${name} at ${ip} is already connected under another address.`);
      return;
    }
    this.log.info(`Connected to ${model} "${name}" at ${ip} (${driver.protocol}).`);
    this.log.debug(`Device info of ${name}: ${JSON.stringify(redactInfo(info))}`);

    const host: TapoHost = { ip, driver, deviceId, name, model, online: true, units: new Map(), busy: false };
    this.hosts.set(ip, host);

    await this.addUnit(host, { id: deviceId, name, model, info });
    if (hasChildren(info) || children.length > 0) {
      this.log.info(`${name} has ${children.length} connected device(s).`);
      children.sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0));
      for (const child of children) {
        const childModel = baseModel(child.model);
        const position = Number(child.position);
        const childName =
          unitName(child) || (Number.isFinite(position) && position > 0 ? `${name} Outlet ${position}` : `${name} ${childModel || 'Device'}`);
        await this.addUnit(host, { id: String(child.device_id), parentId: deviceId, name: childName, model: childModel, info: child });
      }
    }
  }

  private async addUnit(host: TapoHost, unitInfo: Omit<TapoUnit, 'functions' | 'endpoints'>): Promise<void> {
    const { id, name, model, info } = unitInfo;
    const functions = deviceFunctions(info);
    // The hub's siren, as its own switch ("Hub Siren"), only when enabled in the settings
    if (!unitInfo.parentId && this.tapoConfig.sirenSwitch === true && typeof info._siren === 'boolean') functions.push({ kind: 'siren', id: 'siren', label: 'Siren' });
    if (functions.length === 0) {
      if (!unitInfo.parentId && hasChildren(info)) return;
      this.log.info(`Skipping ${name} (${model || info.category}): not supported yet.`);
      this.log.debug(`Info of ${name}: ${JSON.stringify(redactInfo(info))}`);
      return;
    }
    const serial = `tapo-${id}`;
    this.setSelectDevice(serial, name, undefined, 'hub');
    if (!this.validateDevice([name, serial, id])) return;

    const unit: TapoUnit = { ...unitInfo, functions, endpoints: new Map() };
    const state = deviceState(info);
    for (const fn of functions) {
      // Each function is its own bridged device with a stable id ("tapo-<id>" or "tapo-<id>-humidity")
      const endpointId = fn.id ? `${serial}-${fn.id}` : serial;
      const label = fn.label ? `${name} ${fn.label}` : name;
      const endpoint = this.createEndpoint(unit, fn, endpointId, label, state);
      if (fn.kind === 'onOff') this.addOnOffHandlers(host, unit, endpoint, fn);
      if (fn.kind === 'siren') this.addSirenHandlers(host, unit, endpoint);
      endpoint.addRequiredClusterServers();
      await this.registerDevice(endpoint);
      unit.endpoints.set(fn.id, endpoint);
    }
    host.units.set(id, unit);
    this.log.info(`Registered ${name} (${model}) as ${functions.map((fn) => this.functionLabel(unit, fn)).join(', ')}${state.online ? '' : ' [offline]'}`);
  }

  private functionLabel(unit: TapoUnit, fn: DeviceFunction): string {
    if (fn.kind === 'siren') return 'siren switch';
    if (fn.kind !== 'onOff') return fn.kind;
    const type = this.deviceType(unit, fn);
    if (type === extendedColorLight) return 'color light';
    if (type === colorTemperatureLight) return 'white-tunable light';
    return type === onOffPlugInUnit ? 'outlet' : fn.dimmable ? 'dimmable light' : 'light';
  }

  private deviceType(unit: TapoUnit, fn: DeviceFunction): DeviceTypeDefinition {
    switch (fn.kind) {
      case 'onOff': {
        if (fn.color) return extendedColorLight;
        if (fn.colorTempRange) return colorTemperatureLight;
        if (fn.dimmable) return dimmableLight;
        const lights = this.tapoConfig.lightList ?? [];
        return isBulb(unit.info) || lights.includes(unit.name) || lights.includes(unit.id) ? onOffLight : onOffPlugInUnit;
      }
      case 'temperature':
        return temperatureSensor;
      case 'humidity':
        return humiditySensor;
      case 'contact':
        return contactSensor;
      case 'motion':
        return occupancySensor;
      case 'waterLeak':
        return waterLeakDetector;
      case 'siren':
        // Matter has no siren device type; an outlet stays out of "all lights" commands
        return onOffPlugInUnit;
    }
  }

  private createEndpoint(unit: TapoUnit, fn: DeviceFunction, endpointId: string, name: string, state: DeviceState): MatterbridgeEndpoint {
    const endpoint = new MatterbridgeEndpoint([this.deviceType(unit, fn), bridgedNode, powerSource], { id: endpointId }, this.config.debug === true)
      .createDefaultIdentifyClusterServer()
      .createDefaultBridgedDeviceBasicInformationClusterServer(
        name,
        endpointId,
        0xfff1,
        'TP-Link',
        unit.model ? `Tapo ${unit.model}` : 'Tapo',
        parseInt(this.version.replace(/\D/g, '')) || 1,
        this.version,
        1,
        String(unit.info.fw_ver ?? '1.0.0').split(' ')[0] || '1.0.0',
      );
    if (hasBattery(unit.info)) {
      endpoint.createDefaultPowerSourceReplaceableBatteryClusterServer(state.battery ?? 100, chargeLevel(state.battery ?? 100), 3000, 'Battery', 1);
    } else {
      endpoint.createDefaultPowerSourceWiredClusterServer();
    }
    endpoint.addCommandHandler('identify', ({ request }) => {
      this.log.info(`Identify request for ${name}: ${JSON.stringify(request)}`);
    });

    switch (fn.kind) {
      case 'onOff':
        endpoint.createDefaultOnOffClusterServer(state.on ?? false);
        if (fn.dimmable) endpoint.createDefaultLevelControlClusterServer(brightnessToLevel(state.brightness ?? 100));
        if (fn.color || fn.colorTempRange) {
          // Matter takes white temperatures in mireds: the warmest white is the largest value
          const [minK, maxK] = fn.colorTempRange ?? [2500, 6500];
          const mireds = Math.min(kelvinToMireds(minK), Math.max(kelvinToMireds(maxK), kelvinToMireds(state.colorTemp || minK)));
          if (fn.color) {
            endpoint.createDefaultColorControlClusterServer(undefined, undefined, hueToMatter(state.hue ?? 0), saturationToMatter(state.saturation ?? 0), mireds, kelvinToMireds(maxK), kelvinToMireds(minK));
          } else {
            endpoint.createCtColorControlClusterServer(mireds, kelvinToMireds(maxK), kelvinToMireds(minK));
          }
        }
        break;
      case 'temperature':
        endpoint.createDefaultTemperatureMeasurementClusterServer(state.temperature === undefined ? null : Math.round(state.temperature * 100));
        break;
      case 'humidity':
        endpoint.createDefaultRelativeHumidityMeasurementClusterServer(state.humidity === undefined ? null : Math.round(state.humidity * 100));
        break;
      case 'contact':
        // Matter contact sensors report true while closed
        endpoint.createDefaultBooleanStateClusterServer(!(state.open ?? false));
        break;
      case 'motion':
        endpoint.createDefaultOccupancySensingClusterServer(state.motion ?? false);
        break;
      case 'waterLeak':
        endpoint.createDefaultBooleanStateClusterServer(state.leak ?? false);
        break;
      case 'siren':
        endpoint.createDefaultOnOffClusterServer(state.siren ?? false);
        break;
    }
    return endpoint;
  }

  /** Change a device, or a child through its hub/strip. */
  private async setDeviceInfo(host: TapoHost, unit: TapoUnit, params: LightParams): Promise<void> {
    await host.driver.set(unit.parentId ? unit.id : undefined, params);
    const changes: TapoParams = { ...params };
    if (params.hue !== undefined || params.saturation !== undefined) changes.color_temp = 0;
    for (const key of Object.keys(changes)) if (changes[key] === undefined) delete changes[key];
    unit.info = { ...unit.info, ...changes };
  }

  private addOnOffHandlers(host: TapoHost, unit: TapoUnit, endpoint: MatterbridgeEndpoint, fn: DeviceFunction): void {
    // Throwing from a handler fails the Matter command, so controllers show the error
    const run = async (what: string, params: LightParams): Promise<void> => {
      this.log.info(`${unit.name}: ${what}...`);
      try {
        await this.setDeviceInfo(host, unit, params);
        this.log.info(`${unit.name}: ${what} done.`);
      } catch (error) {
        this.log.error(`${unit.name}: ${what} failed: ${errorMessage(error)}`);
        throw error;
      }
    };
    endpoint.addCommandHandler('on', () => run('turning on', { device_on: true }));
    endpoint.addCommandHandler('off', () => run('turning off', { device_on: false }));
    endpoint.addCommandHandler('toggle', () => {
      const on = endpoint.getAttribute(OnOff.Cluster.id, 'onOff') !== true;
      return run(on ? 'turning on' : 'turning off', { device_on: on });
    });
    if (!fn.dimmable) return;
    const setLevel = (level: number, withOnOff: boolean): Promise<void> => {
      if (withOnOff && level === 0) return run('turning off', { device_on: false });
      const brightness = levelToBrightness(level);
      return run(`setting brightness to ${brightness}%`, withOnOff ? { device_on: true, brightness } : { brightness });
    };
    endpoint.addCommandHandler('moveToLevel', ({ request }) => setLevel((request as { level: number }).level, false));
    endpoint.addCommandHandler('moveToLevelWithOnOff', ({ request }) => setLevel((request as { level: number }).level, true));

    if (fn.color) {
      const current = (attribute: string): number => Number(endpoint.getAttribute(ColorControl.Cluster.id, attribute) ?? 0);
      const setColor = (hue: number, saturation: number): Promise<void> => run(`setting colour to hue ${hue}°, saturation ${saturation}%`, { hue, saturation });
      endpoint.addCommandHandler('moveToHue', ({ request }) => setColor(matterToHue((request as { hue: number }).hue), matterToSaturation(current('currentSaturation'))));
      endpoint.addCommandHandler('moveToSaturation', ({ request }) =>
        setColor(matterToHue(current('currentHue')), matterToSaturation((request as { saturation: number }).saturation)),
      );
      endpoint.addCommandHandler('moveToHueAndSaturation', ({ request }) => {
        const { hue, saturation } = request as { hue: number; saturation: number };
        return setColor(matterToHue(hue), matterToSaturation(saturation));
      });
      endpoint.addCommandHandler('enhancedMoveToHue', ({ request }) =>
        setColor(Math.round(((request as { enhancedHue: number }).enhancedHue * 360) / 65536), matterToSaturation(current('currentSaturation'))),
      );
      endpoint.addCommandHandler('enhancedMoveToHueAndSaturation', ({ request }) => {
        const { enhancedHue, saturation } = request as { enhancedHue: number; saturation: number };
        return setColor(Math.round((enhancedHue * 360) / 65536), matterToSaturation(saturation));
      });
      endpoint.addCommandHandler('moveToColor', ({ request }) => {
        const { colorX, colorY } = request as { colorX: number; colorY: number };
        const { hue, saturation } = xyToHueSaturation(colorX, colorY);
        return setColor(hue, saturation);
      });
    }
    if (fn.color || fn.colorTempRange) {
      const [minK, maxK] = fn.colorTempRange ?? [2500, 6500];
      endpoint.addCommandHandler('moveToColorTemperature', ({ request }) => {
        const kelvin = Math.max(minK, Math.min(maxK, miredsToKelvin((request as { colorTemperatureMireds: number }).colorTemperatureMireds)));
        return run(`setting white to ${kelvin} K`, { color_temp: kelvin });
      });
    }
  }

  private sirenConfig(): SirenConfig {
    const { sirenSound, sirenVolume, sirenDuration } = this.tapoConfig;
    const config: SirenConfig = {};
    if (typeof sirenSound === 'string' && sirenSound.trim()) config.sound = sirenSound.trim();
    if (Number.isFinite(Number(sirenVolume)) && sirenVolume !== undefined && sirenVolume !== null) config.volume = Math.max(1, Math.min(10, Math.round(Number(sirenVolume))));
    if (Number.isFinite(Number(sirenDuration)) && sirenDuration !== undefined && sirenDuration !== null && Number(sirenDuration) > 0) {
      config.duration = Math.round(Number(sirenDuration));
    }
    return config;
  }

  private addSirenHandlers(host: TapoHost, unit: TapoUnit, endpoint: MatterbridgeEndpoint): void {
    const label = `${unit.name} Siren`;
    const switchSiren = async (on: boolean): Promise<void> => {
      this.log.info(`${label}: ${on ? 'starting the siren' : 'stopping the siren'}...`);
      try {
        await host.driver.setSiren!(on, this.sirenConfig());
        unit.info = { ...unit.info, _siren: on };
        this.log.info(`${label}: siren ${on ? 'on' : 'off'}.`);
      } catch (error) {
        this.log.error(`${label}: ${on ? 'starting' : 'stopping'} the siren failed: ${errorMessage(error)}`);
        throw error;
      }
    };
    endpoint.addCommandHandler('on', () => switchSiren(true));
    endpoint.addCommandHandler('off', () => switchSiren(false));
    endpoint.addCommandHandler('toggle', () => switchSiren(endpoint.getAttribute(OnOff.Cluster.id, 'onOff') !== true));
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');
    this.configured = true;

    for (const host of this.hosts.values()) for (const unit of host.units.values()) await this.applyState(unit, host.online);

    const interval = this.refreshIntervalSeconds();
    if (interval > 0) {
      this.log.info(`Refreshing device state every ${interval} seconds.`);
      this.refreshTimer = setInterval(() => void this.refresh(), interval * 1000);
      this.refreshTimer.unref?.();
    }
    const hubInterval = this.hubRefreshIntervalSeconds();
    if (hubInterval > 0) {
      this.log.info(`Reading hub sensors every ${hubInterval} seconds.`);
      this.hubTimer = setInterval(() => void this.refreshHubs(), hubInterval * 1000);
      this.hubTimer.unref?.();
    }
  }

  override async onShutdown(reason?: string): Promise<void> {
    this.log.info(`onShutdown called with reason: ${reason ?? 'none'}`);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.hubTimer) clearInterval(this.hubTimer);
    this.refreshTimer = undefined;
    this.hubTimer = undefined;
    await super.onShutdown(reason);
    if (this.config.unregisterOnShutdown === true) await this.unregisterAllDevices();
  }

  private refreshIntervalSeconds(): number {
    const value = Number(this.tapoConfig.refreshInterval ?? DEFAULT_REFRESH_INTERVAL_S);
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.max(MIN_REFRESH_INTERVAL_S, Math.round(value));
  }

  private hubRefreshIntervalSeconds(): number {
    const value = Number(this.tapoConfig.hubRefreshInterval ?? DEFAULT_HUB_REFRESH_INTERVAL_S);
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.max(MIN_HUB_REFRESH_INTERVAL_S, value);
  }

  private motionHoldMs(): number {
    const value = Number(this.tapoConfig.motionHoldTime ?? DEFAULT_MOTION_HOLD_S);
    return (Number.isFinite(value) && value >= 0 ? value : DEFAULT_MOTION_HOLD_S) * 1000;
  }

  /** Quick read of every hub's children (sensors), with the event logs of motion sensors. */
  private async refreshHubs(): Promise<void> {
    await Promise.all(
      [...this.hosts.values()]
        .filter((host) => host.online && !host.busy && host.driver.readHubChildren && [...host.units.values()].some((unit) => unit.parentId))
        .map(async (host) => {
          host.busy = true;
          try {
            const motionIds = [...host.units.values()].filter((unit) => unit.parentId && unit.functions.some((fn) => fn.kind === 'motion')).map((unit) => unit.id);
            const { children, logs, siren } = await host.driver.readHubChildren!(motionIds);
            const hubUnit = host.units.get(host.deviceId);
            if (hubUnit && siren !== undefined) {
              hubUnit.info = { ...hubUnit.info, _siren: siren };
              await this.applyState(hubUnit, true);
            }
            for (const child of children) {
              const unit = host.units.get(String(child.device_id));
              if (unit) unit.info = child;
            }
            for (const [id, entries] of logs) {
              const unit = host.units.get(id);
              if (unit) this.processMotionLogs(unit, entries);
            }
            for (const unit of host.units.values()) if (unit.parentId) await this.applyState(unit, true);
          } catch (error) {
            // The regular refresh reports devices that stop answering; this loop just tries again
            this.log.debug(`Quick read of ${host.name} failed: ${errorMessage(error)}`);
          } finally {
            host.busy = false;
          }
        }),
    );
  }

  /** New "motion" entries in a sensor's event log mean motion, even if it was over before we looked. */
  private processMotionLogs(unit: TapoUnit, entries: TapoParams[]): void {
    const ids = entries.map((entry) => Number(entry.id)).filter(Number.isFinite);
    if (ids.length === 0) return;
    const newest = Math.max(...ids);
    const previous = unit.lastLogId;
    unit.lastLogId = newest;
    // The first read only learns where the log is
    if (previous === undefined || newest <= previous) return;
    if (entries.some((entry) => Number(entry.id) > previous && entry.event === 'motion')) unit.motionUntil = Date.now() + this.motionHoldMs();
  }

  /** Poll every device (changes made in the Tapo app, by hand or by automations) and retry ones not connected yet. */
  private async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      await Promise.all([...this.hosts.values()].map((host) => this.refreshHost(host)));
      if (this.pending.size > 0) await this.connectPending();
    } finally {
      this.refreshing = false;
    }
  }

  private async refreshHost(host: TapoHost): Promise<void> {
    if (host.busy) return;
    host.busy = true;
    try {
      const { info, children } = await host.driver.read();
      if (!host.online) this.log.info(`${host.name} (${host.ip}) is back online.`);
      host.online = true;
      const own = host.units.get(host.deviceId);
      if (own) own.info = typeof info._siren === 'boolean' || typeof own.info._siren !== 'boolean' ? info : { ...info, _siren: own.info._siren };
      for (const child of children) {
        const unit = host.units.get(String(child.device_id));
        if (unit) unit.info = child;
      }
    } catch (error) {
      if (host.online) this.log.warn(`${host.name} (${host.ip}) is not responding: ${errorMessage(error)}`);
      host.online = false;
      host.driver.reset();
    } finally {
      host.busy = false;
    }
    if (!this.configured) return;
    for (const unit of host.units.values()) await this.applyState(unit, host.online);
  }

  private async applyState(unit: TapoUnit, hostOnline: boolean): Promise<void> {
    const state = deviceState(unit.info);
    const reachable = hostOnline && state.online;
    try {
      for (const fn of unit.functions) {
        const endpoint = unit.endpoints.get(fn.id)!;
        await update(endpoint, BridgedDeviceBasicInformation.Cluster.id, 'reachable', reachable);
        switch (fn.kind) {
          case 'onOff':
            if (state.on !== undefined) await update(endpoint, OnOff.Cluster.id, 'onOff', state.on);
            if (fn.dimmable && state.brightness !== undefined) await update(endpoint, LevelControl.Cluster.id, 'currentLevel', brightnessToLevel(state.brightness));
            await this.applyColor(endpoint, fn, state);
            break;
          case 'temperature':
            if (state.temperature !== undefined) await update(endpoint, TemperatureMeasurement.Cluster.id, 'measuredValue', Math.round(state.temperature * 100));
            break;
          case 'humidity':
            if (state.humidity !== undefined) await update(endpoint, RelativeHumidityMeasurement.Cluster.id, 'measuredValue', Math.round(state.humidity * 100));
            break;
          case 'contact':
            if (state.open !== undefined && endpoint.getAttribute(BooleanState.Cluster.id, 'stateValue') !== !state.open) {
              this.log.info(`${unit.name}: ${state.open ? 'opened' : 'closed'}`);
              await update(endpoint, BooleanState.Cluster.id, 'stateValue', !state.open);
            }
            break;
          case 'motion': {
            // A detection holds the sensor occupied for motionHoldTime, so short ones are not lost between reads
            if (state.motion) unit.motionUntil = Math.max(unit.motionUntil ?? 0, Date.now() + this.motionHoldMs());
            const occupied = state.motion === true || Date.now() < (unit.motionUntil ?? 0);
            const current = endpoint.getAttribute(OccupancySensing.Cluster.id, 'occupancy') as { occupied?: boolean } | undefined;
            if (current?.occupied !== occupied) {
              this.log.info(`${unit.name}: ${occupied ? 'motion detected' : 'no motion'}`);
              await endpoint.setAttribute(OccupancySensing.Cluster.id, 'occupancy', { occupied }, endpoint.log);
            }
            break;
          }
          case 'waterLeak':
            if (state.leak !== undefined) await update(endpoint, BooleanState.Cluster.id, 'stateValue', state.leak);
            break;
          case 'siren':
            if (state.siren !== undefined && endpoint.getAttribute(OnOff.Cluster.id, 'onOff') !== state.siren) {
              this.log.info(`${unit.name} Siren: ${state.siren ? 'sounding' : 'stopped'}`);
              await update(endpoint, OnOff.Cluster.id, 'onOff', state.siren);
            }
            break;
        }
        if (state.battery !== undefined && hasBattery(unit.info)) {
          await update(endpoint, PowerSource.Cluster.id, 'batPercentRemaining', state.battery * 2);
          await update(endpoint, PowerSource.Cluster.id, 'batChargeLevel', chargeLevel(state.battery));
          await update(endpoint, PowerSource.Cluster.id, 'batReplacementNeeded', state.battery <= LOW_BATTERY_PERCENT);
        }
      }
    } catch (error) {
      this.log.debug(`Could not update ${unit.name}: ${errorMessage(error)}`);
    }
  }

  /** Show the light's colour or white temperature, and which of the two it is in. */
  private async applyColor(endpoint: MatterbridgeEndpoint, fn: DeviceFunction, state: DeviceState): Promise<void> {
    if (!fn.color && !fn.colorTempRange) return;
    const whiteMode = !fn.color || (state.colorTemp ?? 0) > 0;
    if (whiteMode && fn.colorTempRange && state.colorTemp) {
      const [minK, maxK] = fn.colorTempRange;
      await update(endpoint, ColorControl.Cluster.id, 'colorTemperatureMireds', kelvinToMireds(Math.max(minK, Math.min(maxK, state.colorTemp))));
    }
    if (fn.color && !whiteMode) {
      if (state.hue !== undefined) await update(endpoint, ColorControl.Cluster.id, 'currentHue', hueToMatter(state.hue));
      if (state.saturation !== undefined) await update(endpoint, ColorControl.Cluster.id, 'currentSaturation', saturationToMatter(state.saturation));
    }
    if (fn.color) {
      const mode = whiteMode && fn.colorTempRange ? ColorControl.ColorMode.ColorTemperatureMireds : ColorControl.ColorMode.CurrentHueAndCurrentSaturation;
      await update(endpoint, ColorControl.Cluster.id, 'colorMode', mode);
      await update(endpoint, ColorControl.Cluster.id, 'enhancedColorMode', mode);
    }
  }
}

type ClusterIdArg = Parameters<MatterbridgeEndpoint['setAttribute']>[0];

/** Set an attribute only when it changed, to avoid flooding controllers with identical reports. */
async function update(endpoint: MatterbridgeEndpoint, clusterId: ClusterIdArg, attribute: string, value: boolean | number): Promise<void> {
  if (endpoint.getAttribute(clusterId, attribute) === value) return;
  await endpoint.setAttribute(clusterId, attribute, value, endpoint.log);
}

function chargeLevel(percent: number): PowerSource.BatChargeLevel {
  if (percent > LOW_BATTERY_PERCENT) return PowerSource.BatChargeLevel.Ok;
  return percent > CRITICAL_BATTERY_PERCENT ? PowerSource.BatChargeLevel.Warning : PowerSource.BatChargeLevel.Critical;
}

function redact(config: PlatformConfig): PlatformConfig {
  const copy: PlatformConfig = { ...config };
  for (const key of SENSITIVE_KEYS) if (copy[key]) copy[key] = '********';
  return copy;
}

/** Device info without location and network identifiers, for debug logs people paste in issues. */
function redactInfo(info: TapoParams): TapoParams {
  const copy = { ...info };
  for (const key of ['latitude', 'longitude', 'ssid', 'mac', 'ip', 'oem_id', 'hw_id', 'fw_id']) if (key in copy) copy[key] = '...';
  return copy;
}
