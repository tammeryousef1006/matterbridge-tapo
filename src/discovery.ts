import * as crypto from 'crypto';
import * as dgram from 'dgram';

import { TapoProtocol } from './tapoClient.js';

/** A device that answered the TP-Link discovery broadcast (UDP port 20002). */
export interface DiscoveredDevice {
  ip: string;
  /** e.g. "SMART.TAPOPLUG", "SMART.TAPOHUB". */
  deviceType: string;
  /** e.g. "P110(EU)". */
  model: string;
  deviceId: string;
  mac: string;
  /** undefined when the device uses a protocol this plugin does not speak (cameras, the H200 hub). */
  protocol?: TapoProtocol;
  /** Which way the device was found to speak, for the log. */
  encryptType?: string;
  https: boolean;
  httpPort?: number;
  loginVersion?: number;
}

export const DISCOVERY_PORT = 20002;

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
  // HTTPS devices (H200 hub, cameras) use a different login that this plugin does not speak yet
  let protocol: TapoProtocol | undefined;
  if (!https && encryptType === 'KLAP') protocol = 'klap';
  else if (!https && encryptType === 'AES') protocol = 'aes';
  return {
    ip: typeof result.ip === 'string' && result.ip ? result.ip : fromIp,
    deviceType: result.device_type,
    model: String(result.device_model ?? ''),
    deviceId: String(result.device_id ?? ''),
    mac: String(result.mac ?? ''),
    protocol,
    encryptType,
    https,
    httpPort: typeof scheme.http_port === 'number' ? scheme.http_port : undefined,
    loginVersion: typeof scheme.lv === 'number' ? scheme.lv : undefined,
  };
}

export interface DiscoverOptions {
  /** How long to listen for replies. */
  timeoutMs?: number;
  /** Broadcast address(es); 255.255.255.255 by default. */
  targets?: string[];
  port?: number;
}

/** Broadcast the discovery probe a few times and collect the replies, one per IP. */
export function discover(options: DiscoverOptions = {}): Promise<DiscoveredDevice[]> {
  const { timeoutMs = 5000, targets = ['255.255.255.255'], port = DISCOVERY_PORT } = options;
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
      const device = parseDiscoveryResponse(message, remote.address);
      if (device) found.set(device.ip, device);
    });
    socket.bind(0, () => {
      socket.setBroadcast(true);
      const query = discoveryQuery();
      const send = (): void => {
        for (const target of targets) socket.send(query, port, target, () => undefined);
      };
      // UDP gets lost; three probes spread over the first part of the window
      for (const delay of [0, Math.round(timeoutMs / 5), Math.round((2 * timeoutMs) / 5)]) timers.push(setTimeout(send, delay));
      timers.push(setTimeout(finish, timeoutMs));
    });
  });
}
