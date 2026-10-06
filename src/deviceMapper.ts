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
  /** For onOff: the light takes a colour (hue/saturation). */
  color?: boolean;
  /** For onOff: the light's white range in Kelvin, when it can change its white temperature. */
  colorTempRange?: [number, number];
}

export interface DeviceState {
  online: boolean;
  on?: boolean;
  /** 1-100 as reported by Tapo. */
  brightness?: number;
  /** Degrees 0-360. */
  hue?: number;
  /** 0-100. */
  saturation?: number;
  /** Kelvin; 0 while the light shows a colour. */
  colorTemp?: number;
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
  if (typeof info.device_on === 'boolean') {
    const fn: DeviceFunction = { kind: 'onOff', id: '', dimmable: typeof info.brightness === 'number' };
    if (fn.dimmable && typeof info.hue === 'number' && typeof info.saturation === 'number') fn.color = true;
    const range = info.color_temp_range;
    if (fn.dimmable && Array.isArray(range) && range.length === 2 && Number(range[0]) < Number(range[1])) fn.colorTempRange = [Number(range[0]), Number(range[1])];
    return [fn];
  }
  return [];
}

/** The display name a driver decoded, else the base64 nickname. */
export function unitName(info: TapoParams): string {
  return typeof info._name === 'string' ? info._name.trim() : decodeNickname(info.nickname);
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
  const hue = number(info.hue);
  if (hue !== undefined) state.hue = ((Math.round(hue) % 360) + 360) % 360;
  const saturation = number(info.saturation);
  if (saturation !== undefined) state.saturation = Math.max(0, Math.min(100, Math.round(saturation)));
  const colorTemp = number(info.color_temp);
  if (colorTemp !== undefined) state.colorTemp = Math.max(0, Math.round(colorTemp));

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

/** Tapo hue (0-360°) to Matter hue (0-254). */
export function hueToMatter(hue: number): number {
  return Math.max(0, Math.min(254, Math.round((hue * 254) / 360)));
}

export function matterToHue(hue: number): number {
  return Math.max(0, Math.min(360, Math.round((hue * 360) / 254)));
}

/** Tapo saturation (0-100) to Matter saturation (0-254). */
export function saturationToMatter(saturation: number): number {
  return Math.max(0, Math.min(254, Math.round((saturation * 254) / 100)));
}

export function matterToSaturation(saturation: number): number {
  return Math.max(0, Math.min(100, Math.round((saturation * 100) / 254)));
}

/** Kelvin to mireds and back (Matter colour temperatures are in mireds). */
export function kelvinToMireds(kelvin: number): number {
  return Math.round(1000000 / Math.max(1, kelvin));
}

export function miredsToKelvin(mireds: number): number {
  return Math.round(1000000 / Math.max(1, mireds));
}

/** CIE xy (Matter 0-65535 scale) to hue (0-360°) and saturation (0-100), for controllers that send xy. */
export function xyToHueSaturation(x: number, y: number): { hue: number; saturation: number } {
  const cx = x / 65535;
  const cy = Math.max(y / 65535, 0.0001);
  const Y = 1;
  const X = (Y / cy) * cx;
  const Z = (Y / cy) * (1 - cx - cy);
  // XYZ to linear sRGB, then gamma
  let r = X * 3.2406 - Y * 1.5372 - Z * 0.4986;
  let g = -X * 0.9689 + Y * 1.8758 + Z * 0.0415;
  let b = X * 0.0557 - Y * 0.204 + Z * 1.057;
  const max = Math.max(r, g, b, 1e-6);
  [r, g, b] = [r, g, b].map((c) => Math.max(0, c / max)).map((c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
  const hi = Math.max(r, g, b);
  const lo = Math.min(r, g, b);
  const delta = hi - lo;
  let hue = 0;
  if (delta > 0) {
    if (hi === r) hue = 60 * (((g - b) / delta) % 6);
    else if (hi === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
  }
  return { hue: Math.round((hue + 360) % 360), saturation: Math.round(hi === 0 ? 0 : (delta / hi) * 100) };
}
