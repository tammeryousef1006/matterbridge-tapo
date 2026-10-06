import { TapoParams } from './tapoClient.js';

/**
 * What one Tapo device (or hub/strip child) offers to Matter. Each function becomes its own bridged
 * Matter device, because SmartThings does not show functions nested inside one composed device.
 */
export type FunctionKind = 'onOff' | 'temperature' | 'humidity' | 'contact' | 'motion' | 'waterLeak';

export interface DeviceFunction {
  kind: FunctionKind;
  /** Stable suffix of the Matter endpoint id; empty for the device's main function. */
  id: string;
  /** Added to the device name for secondary functions, e.g. "Humidity". */
  label?: string;
  /** For onOff: the device reports a brightness and can be dimmed. */
  dimmable?: boolean;
}

export interface DeviceState {
  online: boolean;
  on?: boolean;
  /** 1-100 as reported by Tapo. */
  brightness?: number;
  /** Degrees Celsius. */
  temperature?: number;
  /** Percent. */
  humidity?: number;
  /** true when the door/window is open. */
  open?: boolean;
  motion?: boolean;
  leak?: boolean;
  /** Percent, for battery powered hub sensors. */
  battery?: number;
}

/** Hub sensor categories (the `category` of a child). */
const CATEGORY_TEMP_HUMIDITY = 'subg.trigger.temp-hmdt-sensor';
const CATEGORY_MOTION = 'subg.trigger.motion-sensor';
const CATEGORY_CONTACT = 'subg.trigger.contact-sensor';
const CATEGORY_WATER_LEAK = 'subg.trigger.water-leak-sensor';

/** Device types that are a hub: their children are what gets exposed. */
const HUB_TYPES = new Set(['SMART.TAPOHUB', 'SMART.KASAHUB']);
/** Battery level reported for sensors that only say "low" or "ok". */
const LOW_BATTERY_PERCENT = 10;
const OK_BATTERY_PERCENT = 100;

/** Decode the base64 nickname Tapo devices report; falls back to the raw value. */
export function decodeNickname(value: unknown): string {
  if (typeof value !== 'string' || value === '') return '';
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    // Not base64 after all if re-encoding does not give the input back
    if (Buffer.from(decoded, 'utf8').toString('base64').replace(/=+$/, '') === value.replace(/=+$/, '')) return decoded.trim();
  } catch {
    // fall through
  }
  return value;
}

/** Model without the region, e.g. "P110" from "P110(EU)". */
export function baseModel(model: unknown): string {
  return String(model ?? '').replace(/\(.*$/, '').trim();
}

export function isHub(info: TapoParams): boolean {
  return HUB_TYPES.has(String(info.type ?? ''));
}

/** A device has children worth listing: hubs, and strips/multi-switches whose parent has no on/off of its own. */
export function hasChildren(info: TapoParams): boolean {
  return isHub(info) || typeof info.device_on !== 'boolean';
}

/** Work out what a device or child can do. Returns an empty list for unsupported ones. */
export function deviceFunctions(info: TapoParams): DeviceFunction[] {
  const category = String(info.category ?? '');
  switch (category) {
    case CATEGORY_TEMP_HUMIDITY: {
      const functions: DeviceFunction[] = [{ kind: 'temperature', id: '' }];
      if (info.current_humidity !== undefined) functions.push({ kind: 'humidity', id: 'humidity', label: 'Humidity' });
      return functions;
    }
    case CATEGORY_MOTION:
      return [{ kind: 'motion', id: '' }];
    case CATEGORY_CONTACT:
      return [{ kind: 'contact', id: '' }];
    case CATEGORY_WATER_LEAK:
      return [{ kind: 'waterLeak', id: '' }];
  }
  if (isHub(info)) return [];
  if (typeof info.device_on === 'boolean') return [{ kind: 'onOff', id: '', dimmable: typeof info.brightness === 'number' }];
  return [];
}

/** Whether a device is a light (bulb or light strip) rather than an outlet. */
export function isBulb(info: TapoParams): boolean {
  return String(info.type ?? '') === 'SMART.TAPOBULB';
}

/** Whether a child is battery powered (hub sensors). */
export function hasBattery(info: TapoParams): boolean {
  return typeof info.at_low_battery === 'boolean' || typeof info.battery_percentage === 'number';
}

function number(value: unknown): number | undefined {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** Extract the current state from a device's or child's info. */
export function deviceState(info: TapoParams): DeviceState {
  // Hub children report their own status; top level devices are online when they answer
  const state: DeviceState = { online: info.status === undefined || info.status === 'online' };
  if (typeof info.device_on === 'boolean') state.on = info.device_on;
  const brightness = number(info.brightness);
  if (brightness !== undefined) state.brightness = Math.max(1, Math.min(100, Math.round(brightness)));

  const temperature = number(info.current_temp);
  // current_temp_exception only flags readings outside the comfort range; the value is still real
  if (temperature !== undefined) state.temperature = info.temp_unit === 'fahrenheit' ? ((temperature - 32) * 5) / 9 : temperature;
  const humidity = number(info.current_humidity);
  if (humidity !== undefined) state.humidity = Math.max(0, Math.min(100, humidity));

  if (typeof info.open === 'boolean') state.open = info.open;
  if (typeof info.detected === 'boolean') state.motion = info.detected;
  if (typeof info.water_leak_status === 'string') state.leak = info.water_leak_status !== 'water_dry' || info.in_alarm === true;

  const battery = number(info.battery_percentage);
  if (battery !== undefined) state.battery = Math.max(0, Math.min(100, Math.round(battery)));
  else if (typeof info.at_low_battery === 'boolean') state.battery = info.at_low_battery ? LOW_BATTERY_PERCENT : OK_BATTERY_PERCENT;
  return state;
}

/** Tapo brightness (1-100) to a Matter level (1-254). */
export function brightnessToLevel(brightness: number): number {
  return Math.max(1, Math.min(254, Math.round((brightness * 254) / 100)));
}

/** Matter level (0-254) to Tapo brightness (1-100). */
export function levelToBrightness(level: number): number {
  return Math.max(1, Math.min(100, Math.round((level * 100) / 254)));
}
