import {
  DeviceTypeDefinition,
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  PlatformConfig,
  PlatformMatterbridge,
  bridgedNode,
  contactSensor,
  dimmableLight,
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
  LevelControl,
  OccupancySensing,
  OnOff,
  PowerSource,
  RelativeHumidityMeasurement,
  TemperatureMeasurement,
} from 'matterbridge/matter/clusters';

import { DeviceFunction, DeviceState, baseModel, brightnessToLevel, decodeNickname, deviceFunctions, deviceState, hasBattery, hasChildren, isBulb, levelToBrightness } from './deviceMapper.js';
import { DiscoveredDevice, discover } from './discovery.js';
import { TapoAuthError, TapoClient, TapoParams, errorMessage } from './tapoClient.js';

export interface TapoPlatformConfig extends PlatformConfig {
  email?: string;
  password?: string;
  discovery?: boolean;
  hosts?: string[];
  refreshInterval?: number;
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
}

/** One device on the network that the plugin talks to (a plug, bulb, strip or hub). */
interface TapoHost {
  ip: string;
  client: TapoClient;
  deviceId: string;
  name: string;
  model: string;
  online: boolean;
  /** Units reached through this host: the device itself and its children. */
  units: Map<string, TapoUnit>;
}

const DEFAULT_REFRESH_INTERVAL_S = 30;
const MIN_REFRESH_INTERVAL_S = 10;
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
          if (!device.protocol) {
            this.log.info(`Skipping ${device.model} at ${device.ip}: it uses the ${device.https ? 'HTTPS' : device.encryptType ?? 'unknown'} protocol, not supported yet.`);
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

  private async connectHost(ip: string, discovered: DiscoveredDevice | undefined): Promise<void> {
    // "192.168.1.20" or "192.168.1.20:8080"
    const [address, port] = ip.split(':');
    const client = new TapoClient({
      host: address,
      port: discovered?.httpPort ?? (port ? Number(port) : undefined),
      credentials: this.credentials!,
      protocol: discovered?.protocol,
      loginVersion: discovered?.loginVersion,
      log: this.log,
    });
    const info = await client.getDeviceInfo();
    const deviceId = String(info.device_id ?? discovered?.deviceId ?? ip);
    const model = baseModel(info.model ?? discovered?.model);
    const name = decodeNickname(info.nickname) || `${model} ${ip}`;
    if ([...this.hosts.values()].some((host) => host.deviceId === deviceId)) {
      this.log.debug(`${name} at ${ip} is already connected under another address.`);
      return;
    }
    // Read everything before registering anything, so a failure here can simply be retried later
    const children = hasChildren(info) ? await client.getChildDeviceList() : [];
    this.log.info(`Connected to ${model} "${name}" at ${ip} (${client.protocol?.toUpperCase()}).`);
    this.log.debug(`Device info of ${name}: ${JSON.stringify(redactInfo(info))}`);

    const host: TapoHost = { ip, client, deviceId, name, model, online: true, units: new Map() };
    this.hosts.set(ip, host);

    await this.addUnit(host, { id: deviceId, name, model, info });
    if (hasChildren(info)) {
      this.log.info(`${name} has ${children.length} connected device(s).`);
      children.sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0));
      for (const child of children) {
        const childModel = baseModel(child.model);
        const position = Number(child.position);
        const childName =
          decodeNickname(child.nickname) || (Number.isFinite(position) && position > 0 ? `${name} Outlet ${position}` : `${name} ${childModel || 'Device'}`);
        await this.addUnit(host, { id: String(child.device_id), parentId: deviceId, name: childName, model: childModel, info: child });
      }
    }
  }

  private async addUnit(host: TapoHost, unitInfo: Omit<TapoUnit, 'functions' | 'endpoints'>): Promise<void> {
    const { id, name, model, info } = unitInfo;
    const functions = deviceFunctions(info);
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
      endpoint.addRequiredClusterServers();
      await this.registerDevice(endpoint);
      unit.endpoints.set(fn.id, endpoint);
    }
    host.units.set(id, unit);
    this.log.info(`Registered ${name} (${model}) as ${functions.map((fn) => this.functionLabel(unit, fn)).join(', ')}${state.online ? '' : ' [offline]'}`);
  }

  private functionLabel(unit: TapoUnit, fn: DeviceFunction): string {
    if (fn.kind !== 'onOff') return fn.kind;
    return this.deviceType(unit, fn) === onOffPlugInUnit ? 'outlet' : fn.dimmable ? 'dimmable light' : 'light';
  }

  private deviceType(unit: TapoUnit, fn: DeviceFunction): DeviceTypeDefinition {
    switch (fn.kind) {
      case 'onOff': {
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
    }
    return endpoint;
  }

  /** Send set_device_info to a device, or through its hub/strip for a child. */
  private async setDeviceInfo(host: TapoHost, unit: TapoUnit, params: TapoParams): Promise<void> {
    if (unit.parentId) await host.client.controlChild(unit.id, 'set_device_info', params);
    else await host.client.setDeviceInfo(params);
    unit.info = { ...unit.info, ...params };
  }

  private addOnOffHandlers(host: TapoHost, unit: TapoUnit, endpoint: MatterbridgeEndpoint, fn: DeviceFunction): void {
    // Throwing from a handler fails the Matter command, so controllers show the error
    const run = async (what: string, params: TapoParams): Promise<void> => {
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
  }

  override async onShutdown(reason?: string): Promise<void> {
    this.log.info(`onShutdown called with reason: ${reason ?? 'none'}`);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
    await super.onShutdown(reason);
    if (this.config.unregisterOnShutdown === true) await this.unregisterAllDevices();
  }

  private refreshIntervalSeconds(): number {
    const value = Number(this.tapoConfig.refreshInterval ?? DEFAULT_REFRESH_INTERVAL_S);
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.max(MIN_REFRESH_INTERVAL_S, Math.round(value));
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
    try {
      const info = await host.client.getDeviceInfo();
      const children = hasChildren(info) && [...host.units.values()].some((unit) => unit.parentId) ? await host.client.getChildDeviceList() : [];
      if (!host.online) this.log.info(`${host.name} (${host.ip}) is back online.`);
      host.online = true;
      const own = host.units.get(host.deviceId);
      if (own) own.info = info;
      for (const child of children) {
        const unit = host.units.get(String(child.device_id));
        if (unit) unit.info = child;
      }
    } catch (error) {
      if (host.online) this.log.warn(`${host.name} (${host.ip}) is not responding: ${errorMessage(error)}`);
      host.online = false;
      host.client.reset();
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
            break;
          case 'temperature':
            if (state.temperature !== undefined) await update(endpoint, TemperatureMeasurement.Cluster.id, 'measuredValue', Math.round(state.temperature * 100));
            break;
          case 'humidity':
            if (state.humidity !== undefined) await update(endpoint, RelativeHumidityMeasurement.Cluster.id, 'measuredValue', Math.round(state.humidity * 100));
            break;
          case 'contact':
            if (state.open !== undefined) await update(endpoint, BooleanState.Cluster.id, 'stateValue', !state.open);
            break;
          case 'motion':
            if (state.motion !== undefined) {
              const current = endpoint.getAttribute(OccupancySensing.Cluster.id, 'occupancy') as { occupied?: boolean } | undefined;
              if (current?.occupied !== state.motion) await endpoint.setAttribute(OccupancySensing.Cluster.id, 'occupancy', { occupied: state.motion }, endpoint.log);
            }
            break;
          case 'waterLeak':
            if (state.leak !== undefined) await update(endpoint, BooleanState.Cluster.id, 'stateValue', state.leak);
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
