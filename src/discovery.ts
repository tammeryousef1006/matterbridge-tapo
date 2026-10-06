import * as crypto from 'crypto';
import * as dgram from 'dgram';

import { xorDecrypt, xorEncrypt } from './kasaClient.js';
import { TapoProtocol } from './tapoClient.js';

/**
 * How the plugin talks to a discovered device:
 * - smart: Tapo plugs, bulbs, strips, H100 hub (KLAP or AES on port 80)
 * - smartcam: H200/H500 hubs (HTTPS)
 * - kasa: Kasa devices (XOR on port 9999, or KLAP)
 * - camera: Tapo cameras and doorbells (not supported yet)
 * - other: anything else (robot vacuums...)
 */
export type DeviceFamily = 'smart' | 'smartcam' | 'kasa' | 'camera' | 'other';

/** A device that answered the TP-Link discovery broadcast (UDP port 20002). */
export interface DiscoveredDevice {
  ip: string;
  /** e.g. "SMART.TAPOPLUG", "SMART.TAPOHUB". */
  deviceType: string;
  /** e.g. "P110(EU)". */
  model: string;
  deviceId: string;
  mac: string;
  family: DeviceFamily;
  /** For the smart family. */
  protocol?: TapoProtocol;
  /** For the kasa family. */
  kasaTransport?: 'xor' | 'klap';
  /** Which way the device was found to speak, for the log. */
  encryptType?: string;
  https: boolean;
  httpPort?: number;
  loginVersion?: number;
}

export const DISCOVERY_PORT = 20002;
export const KASA_DISCOVERY_PORT = 9999;

let discoveryKey: string | undefined;

/**
 * The discovery probe (TDP v2 header + the RSA key devices encrypt their reply's extra data with).
 * Layout from python-kasa: version, type, op code, payload size, flags, padding, serial, CRC32.
 */
export function discoveryQuery(): Buffer {
  discoveryKey ??= crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const payload = Buffer.from(JSON.stringify({ params: { rsa_key: discoveryKey } }));
  const header = Buffer.alloc(16);
  header.writeUInt8(2, 0);
  header.writeUInt8(0, 1);
  header.writeUInt16BE(1, 2);
  header.writeUInt16BE(payload.length, 4);
  header.writeUInt8(17, 6);
  header.writeUInt8(0, 7);
  header.writeUInt32BE(crypto.randomBytes(4).readUInt32BE(0), 8);
  header.writeUInt32BE(0x5a6b7c8d, 12);
  const query = Buffer.concat([header, payload]);
  query.writeUInt32BE(crc32(query), 12);
  return query;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Parse a discovery reply: a 16 byte header followed by JSON. Returns undefined for anything else. */
export function parseDiscoveryResponse(data: Buffer, fromIp: string): DiscoveredDevice | undefined {
  let info: { result?: Record<string, unknown> };
  try {
    info = JSON.parse(data.subarray(16).toString('utf8'));
  } catch {
    return undefined;
  }
  const result = info.result;
  if (!result || typeof result.device_type !== 'string') return undefined;
  const scheme = (result.mgt_encrypt_schm ?? {}) as { encrypt_type?: string; is_support_https?: boolean; http_port?: number; lv?: number };
  const encryptInfo = result.encrypt_info as { sym_schm?: string } | undefined;
  const encryptType = scheme.encrypt_type ?? encryptInfo?.sym_schm;
  const https = scheme.is_support_https === true;
  const deviceType = result.device_type;
  let family: DeviceFamily = 'other';
  let protocol: TapoProtocol | undefined;
  let kasaTransport: 'xor' | 'klap' | undefined;
  if (/IPCAMERA|DOORBELL|CHIME/.test(deviceType)) family = 'camera';
  else if (deviceType.startsWith('IOT.')) {
    family = 'kasa';
    kasaTransport = encryptType === 'KLAP' ? 'klap' : 'xor';
  } else if (https && deviceType.endsWith('HUB')) family = 'smartcam';
  else if (!https && (encryptType === 'KLAP' || encryptType === 'AES') && !deviceType.includes('ROBOVAC')) {
    family = 'smart';
    protocol = encryptType === 'KLAP' ? 'klap' : 'aes';
  }
  return {
    ip: typeof result.ip === 'string' && result.ip ? result.ip : fromIp,
    deviceType,
    model: String(result.device_model ?? ''),
    deviceId: String(result.device_id ?? ''),
    mac: String(result.mac ?? ''),
    family,
    protocol,
    kasaTransport,
    encryptType,
    https,
    httpPort: typeof scheme.http_port === 'number' ? scheme.http_port : undefined,
    loginVersion: typeof scheme.lv === 'number' ? scheme.lv : undefined,
  };
}

/** Parse a reply to the Kasa discovery (UDP 9999): XOR obfuscated get_sysinfo, without length header. */
export function parseKasaDiscoveryResponse(data: Buffer, fromIp: string): DiscoveredDevice | undefined {
  let sysinfo: Record<string, unknown> | undefined;
  try {
    sysinfo = JSON.parse(xorDecrypt(data))?.system?.get_sysinfo;
  } catch {
    return undefined;
  }
  if (!sysinfo || typeof sysinfo !== 'object') return undefined;
  return {
    ip: fromIp,
    deviceType: String(sysinfo.mic_type ?? sysinfo.type ?? 'IOT'),
    model: String(sysinfo.model ?? ''),
    deviceId: String(sysinfo.deviceId ?? ''),
    mac: String(sysinfo.mac ?? sysinfo.mic_mac ?? ''),
    family: 'kasa',
    kasaTransport: 'xor',
    encryptType: 'XOR',
    https: false,
  };
}

export const KASA_DISCOVERY_QUERY = (): Buffer => xorEncrypt(JSON.stringify({ system: { get_sysinfo: {} } }), false);

export interface DiscoverOptions {
  /** How long to listen for replies. */
  timeoutMs?: number;
  /** Broadcast address(es); 255.255.255.255 by default. */
  targets?: string[];
  port?: number;
  /** Port of the Kasa discovery (9999). */
  kasaPort?: number;
}

/** Broadcast the discovery probe a few times and collect the replies, one per IP. */
export function discover(options: DiscoverOptions = {}): Promise<DiscoveredDevice[]> {
  const { timeoutMs = 5000, targets = ['255.255.255.255'], port = DISCOVERY_PORT, kasaPort = KASA_DISCOVERY_PORT } = options;
  return new Promise((resolve, reject) => {
    const found = new Map<string, DiscoveredDevice>();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const timers: NodeJS.Timeout[] = [];
    const finish = (): void => {
      timers.forEach(clearTimeout);
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve([...found.values()]);
    };
    socket.on('error', (error) => {
      timers.forEach(clearTimeout);
      try {
        socket.close();
      } catch {
        // already closed
      }
      reject(error);
    });
    socket.on('message', (message, remote) => {
      const device = remote.port === kasaPort ? parseKasaDiscoveryResponse(message, remote.address) : parseDiscoveryResponse(message, remote.address);
      // A Kasa device answering both probes is kept with its newer (port 20002) description
      if (device && !(device.encryptType === 'XOR' && found.has(device.ip))) found.set(device.ip, device);
    });
    socket.bind(0, () => {
      socket.setBroadcast(true);
      const query = discoveryQuery();
      const kasaQuery = KASA_DISCOVERY_QUERY();
      const send = (): void => {
        for (const target of targets) {
          socket.send(query, port, target, () => undefined);
          socket.send(kasaQuery, kasaPort, target, () => undefined);
        }
      };
      // UDP gets lost; three probes spread over the first part of the window
      for (const delay of [0, Math.round(timeoutMs / 5), Math.round((2 * timeoutMs) / 5)]) timers.push(setTimeout(send, delay));
      timers.push(setTimeout(finish, timeoutMs));
    });
  });
}
