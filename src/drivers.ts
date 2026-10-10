import { decodeNickname, hasChildren } from './deviceMapper.js';
import { KasaClient } from './kasaClient.js';
import { SmartCamClient } from './smartCamClient.js';
import { TapoClient, TapoParams } from './tapoClient.js';

/**
 * One device on the network, whatever protocol it speaks. Drivers return device and child info in
 * the shape of the Tapo "SMART" protocol (device_on, brightness, hue, category, current_temp...)
 * plus a decoded `_name`, so the rest of the plugin handles every family the same way.
 */
export interface DeviceDriver {
  /** Protocol name for the log, e.g. "KLAP", "AES", "HTTPS", "Kasa XOR". */
  readonly protocol: string;
  /** Read the device and, for hubs and strips, its children. */
  read(): Promise<{ info: TapoParams; children: TapoParams[] }>;
  /** Change the device (childId undefined) or one of its children. Params use SMART names. */
  set(childId: string | undefined, params: LightParams): Promise<void>;
  /**
   * Hubs only: a quick read of the children, plus the latest trigger log entries ({id, event,
   * timestamp}, newest first) of the given children, which catch motion between two reads.
   */
  readHubChildren?(logChildIds: string[]): Promise<{ children: TapoParams[]; logs: Map<string, TapoParams[]>; siren?: boolean }>;
  /** Hubs only: whether the siren is sounding; throws when the hub has no siren. */
  readSiren?(): Promise<boolean>;
  /** Hubs only: start or stop the siren. */
  setSiren?(on: boolean, config: SirenConfig): Promise<void>;
  /** Drop the session so the next request logs in again. */
  reset(): void;
}

/** Optional siren settings from the plugin config; unset values keep the hub's own settings. */
export interface SirenConfig {
  sound?: string;
  /** 1-10. */
  volume?: number;
  /** Seconds. */
  duration?: number;
}

export interface LightParams {
  device_on?: boolean;
  /** 1-100. */
  brightness?: number;
  /** Degrees 0-360; with saturation, sets a colour. */
  hue?: number;
  /** 0-100. */
  saturation?: number;
  /** Kelvin; 0 selects the colour (hue/saturation). */
  color_temp?: number;
}

/** Tapo plugs, strips, bulbs, light strips and the H100 hub (KLAP or securePassthrough). */
export class SmartDriver implements DeviceDriver {
  constructor(readonly client: TapoClient) {}

  get protocol(): string {
    return this.client.protocol?.toUpperCase() ?? 'SMART';
  }

  async read(): Promise<{ info: TapoParams; children: TapoParams[] }> {
    const info = await this.client.getDeviceInfo();
    // A Kasa device on KLAP accepts the login but does not understand Tapo requests
    if (!info || typeof info !== 'object' || (!info.device_id && !info.model)) throw new Error('not a Tapo device (no device info)');
    const children = hasChildren(info) ? await this.client.getChildDeviceList() : [];
    const own = named(info, decodeNickname(info.nickname));
    // H100: in_alarm tells whether the siren is sounding
    if (typeof info.in_alarm === 'boolean') own._siren = info.in_alarm;
    return { info: own, children: children.map((child) => named(child, decodeNickname(child.nickname))) };
  }

  async readHubChildren(logChildIds: string[]): Promise<{ children: TapoParams[]; logs: Map<string, TapoParams[]> }> {
    const children = (await this.client.getChildDeviceList()).map((child) => named(child, decodeNickname(child.nickname)));
    const logs = new Map<string, TapoParams[]>();
    for (const id of logChildIds) {
      try {
        const result = await this.client.controlChild<{ logs?: TapoParams[] }>(id, 'get_trigger_logs', { start_id: 0 });
        if (Array.isArray(result?.logs)) logs.set(id, result.logs);
      } catch {
        // Not every child keeps logs; the plain state still works
      }
    }
    return { children, logs };
  }

  async readSiren(): Promise<boolean> {
    const info = await this.client.getDeviceInfo();
    if (typeof info.in_alarm !== 'boolean') throw new Error('this device has no siren');
    return info.in_alarm;
  }

  async setSiren(on: boolean, config: SirenConfig): Promise<void> {
    if (!on) {
      await this.client.request('stop_alarm');
      return;
    }
    const params: TapoParams = {};
    if (config.sound) params.alarm_type = config.sound;
    if (config.duration !== undefined) params.alarm_duration = config.duration;
    // The H100 takes named volumes
    if (config.volume !== undefined) params.alarm_volume = config.volume <= 0 ? 'mute' : config.volume <= 3 ? 'low' : config.volume <= 7 ? 'normal' : 'high';
    await this.client.request('play_alarm', params);
  }

  async set(childId: string | undefined, params: LightParams): Promise<void> {
    const request = smartLightParams(params);
    if (childId) await this.client.controlChild(childId, 'set_device_info', request);
    else await this.client.setDeviceInfo(request);
  }

  reset(): void {
    this.client.reset();
  }
}

/** The H200/H500 hubs (HTTPS "smartcam" protocol); their sensors are SMART devices reached through the hub. */
export class SmartCamHubDriver implements DeviceDriver {
  readonly protocol = 'HTTPS';

  constructor(readonly client: SmartCamClient) {}

  async read(): Promise<{ info: TapoParams; children: TapoParams[] }> {
    const basic = await this.client.getDeviceInfo();
    const info = named(
      {
        device_id: basic.dev_id,
        model: basic.device_model,
        type: basic.device_type,
        fw_ver: basic.sw_version,
        mac: basic.mac,
      },
      String(basic.device_alias ?? basic.device_name ?? ''),
    );
    const children = await this.client.getChildDeviceList();
    if (this.hasSiren) {
      try {
        info._siren = await this.client.getSirenStatus();
      } catch {
        // Keep the last known state
      }
    }
    return {
      info,
      // Sensors carry a base64 nickname like on the H100; cameras a plain alias
      children: children.map((child) => named(child, decodeNickname(child.nickname) || String(child.alias ?? ''))),
    };
  }

  /** Set once the hub answered a siren status read; the quick reads then include it. */
  private hasSiren = false;

  async readHubChildren(logChildIds: string[]): Promise<{ children: TapoParams[]; logs: Map<string, TapoParams[]>; siren?: boolean }> {
    const { children, logs, siren } = await this.client.getChildrenAndLogs(logChildIds, this.hasSiren);
    return { children: children.map((child) => named(child, decodeNickname(child.nickname) || String(child.alias ?? ''))), logs, siren };
  }

  async readSiren(): Promise<boolean> {
    const active = await this.client.getSirenStatus();
    this.hasSiren = true;
    return active;
  }

  async setSiren(on: boolean, config: SirenConfig): Promise<void> {
    await this.client.setSiren(on, config);
  }

  async set(childId: string | undefined, params: LightParams): Promise<void> {
    if (!childId) throw new Error('the hub itself has nothing to switch');
    await this.client.controlChild(childId, 'set_device_info', smartLightParams(params));
  }

  reset(): void {
    this.client.reset();
  }
}

/** Kasa plugs, power strips, dimmers, bulbs and light strips (IOT protocol). */
export class KasaDriver implements DeviceDriver {
  private sysinfo: TapoParams = {};

  constructor(readonly client: KasaClient) {}

  get protocol(): string {
    return `Kasa ${this.client.protocol ?? ''}`.trim();
  }

  async read(): Promise<{ info: TapoParams; children: TapoParams[] }> {
    const sysinfo = await this.client.getSysinfo();
    this.sysinfo = sysinfo;
    return kasaInfo(sysinfo);
  }

  async set(childId: string | undefined, params: LightParams): Promise<void> {
    if (isKasaBulb(this.sysinfo)) {
      // Light strips (KL4xx) use their own service with the same commands
      const service = 'length' in this.sysinfo ? 'smartlife.iot.lightStrip' : 'smartlife.iot.smartbulb.lightingservice';
      const state: TapoParams = { ignore_default: 1, transition_period: 0 };
      if (params.device_on !== undefined) state.on_off = params.device_on ? 1 : 0;
      if (params.brightness !== undefined) state.brightness = params.brightness;
      if (params.hue !== undefined || params.saturation !== undefined) {
        Object.assign(state, { hue: params.hue, saturation: params.saturation, color_temp: 0 });
      } else if (params.color_temp !== undefined) {
        state.color_temp = params.color_temp;
      }
      await this.client.call(service, 'transition_light_state', state);
      return;
    }
    if (params.brightness !== undefined) await this.client.call('smartlife.iot.dimmer', 'set_brightness', { brightness: params.brightness });
    if (params.device_on !== undefined) {
      await this.client.call('system', 'set_relay_state', { state: params.device_on ? 1 : 0 }, childId ? [childId] : undefined);
    }
  }

  reset(): void {
    this.client.reset();
  }
}

function named(info: TapoParams, name: string): TapoParams {
  return { ...info, _name: name };
}

/** SMART set_device_info parameters; a colour needs color_temp 0, which would otherwise win. */
function smartLightParams(params: LightParams): TapoParams {
  const request: TapoParams = { ...params };
  for (const key of Object.keys(request)) if (request[key] === undefined) delete request[key];
  if (params.hue !== undefined || params.saturation !== undefined) request.color_temp = 0;
  return request;
}

function isKasaBulb(sysinfo: TapoParams): boolean {
  return String(sysinfo.mic_type ?? sysinfo.type ?? '').includes('SMARTBULB') || typeof sysinfo.light_state === 'object';
}

/** Map Kasa get_sysinfo to the SMART shape. */
export function kasaInfo(sysinfo: TapoParams): { info: TapoParams; children: TapoParams[] } {
  const deviceId = String(sysinfo.deviceId ?? sysinfo.mac ?? '');
  const base: TapoParams = {
    device_id: deviceId,
    model: sysinfo.model,
    fw_ver: sysinfo.sw_ver,
    mac: sysinfo.mac,
    _name: String(sysinfo.alias ?? ''),
    _kasa: true,
  };

  if (isKasaBulb(sysinfo)) {
    const light = (sysinfo.light_state ?? {}) as TapoParams;
    const on = Number(light.on_off) === 1;
    // While off, the last colour is kept in dft_on_state
    const state = (on ? light : (light.dft_on_state as TapoParams | undefined) ?? light) as TapoParams;
    const info: TapoParams = { ...base, type: 'SMART.TAPOBULB', device_on: on };
    if (Number(sysinfo.is_dimmable) === 1 && typeof state.brightness === 'number') info.brightness = state.brightness;
    if (Number(sysinfo.is_color) === 1) {
      info.hue = Number(state.hue ?? 0);
      info.saturation = Number(state.saturation ?? 0);
    }
    if (Number(sysinfo.is_variable_color_temp) === 1) {
      info.color_temp = Number(state.color_temp ?? 0);
      info.color_temp_range = Number(sysinfo.is_color) === 1 ? [2500, 9000] : [2700, 6500];
    }
    return { info, children: [] };
  }

  const info: TapoParams = { ...base, type: 'SMART.TAPOPLUG' };
  const sockets = Array.isArray(sysinfo.children) ? (sysinfo.children as TapoParams[]) : [];
  if (sockets.length === 0) {
    info.device_on = Number(sysinfo.relay_state) === 1;
    if (typeof sysinfo.brightness === 'number') info.brightness = sysinfo.brightness;
    return { info, children: [] };
  }
  const children = sockets.map((socket, index) => {
    // Some firmware lists short socket ids ("00", "01") that are relative to the strip's id
    const id = String(socket.id ?? index);
    return {
      device_id: id.length <= 2 ? `${deviceId}${id.padStart(2, '0')}` : id,
      model: sysinfo.model,
      type: 'SMART.TAPOPLUG',
      device_on: Number(socket.state) === 1,
      position: index + 1,
      _name: String(socket.alias ?? ''),
      _kasa: true,
    };
  });
  return { info, children };
}
