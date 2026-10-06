import axios, { AxiosInstance } from 'axios';
import * as http from 'http';
import * as net from 'net';

import { DEFAULT_TIMEOUT_MS, KlapTransport, TapoCredentials, TapoDeviceError, TapoLogger, TapoParams } from './tapoClient.js';

/**
 * Client for Kasa devices (HS/KP/KL/EP models), which speak the older "IOT" JSON protocol:
 * - older firmware: TCP port 9999, "XOR autokey" obfuscation, no login
 * - newer firmware: the same JSON over KLAP on port 80, with the TP-Link account
 * Ported from python-kasa's XorTransport and IotProtocol.
 */

const XOR_KEY = 171;
const XOR_PORT = 9999;

/** Obfuscate a request: 4 byte length followed by the autokey XOR of the bytes. */
export function xorEncrypt(message: string, withLength = true): Buffer {
  const plain = Buffer.from(message, 'utf8');
  const out = Buffer.alloc(plain.length);
  let key = XOR_KEY;
  for (let i = 0; i < plain.length; i++) {
    key ^= plain[i];
    out[i] = key;
  }
  if (!withLength) return out;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(plain.length);
  return Buffer.concat([length, out]);
}

export function xorDecrypt(data: Buffer): string {
  const out = Buffer.alloc(data.length);
  let key = XOR_KEY;
  for (let i = 0; i < data.length; i++) {
    out[i] = key ^ data[i];
    key = data[i];
  }
  return out.toString('utf8');
}

/** One request over TCP 9999; the device closes idle connections, so each request uses its own socket. */
function xorRequest(host: string, port: number, request: string, timeoutMs: number): Promise<TapoParams> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const chunks: Buffer[] = [];
    let expected: number | undefined;
    const fail = (error: Error): void => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(timeoutMs, () => fail(new Error('the device did not answer (timeout)')));
    socket.on('connect', () => socket.write(xorEncrypt(request)));
    socket.on('error', (error) => fail(error));
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      const data = Buffer.concat(chunks);
      if (expected === undefined && data.length >= 4) expected = data.readUInt32BE(0);
      if (expected !== undefined && data.length >= expected + 4) {
        socket.end();
        try {
          resolve(JSON.parse(xorDecrypt(data.subarray(4, expected + 4))) as TapoParams);
        } catch (error) {
          reject(error);
        }
      }
    });
    socket.on('close', () => {
      if (expected === undefined || Buffer.concat(chunks).length < expected + 4) reject(new Error('the device closed the connection'));
    });
  });
}

export type KasaTransportKind = 'xor' | 'klap';

export interface KasaClientOptions {
  host: string;
  /** From discovery: KLAP devices answer on port 20002, XOR ones on 9999. Without it XOR is tried first, then KLAP. */
  transport?: KasaTransportKind;
  port?: number;
  credentials: TapoCredentials;
  timeoutMs?: number;
  log?: TapoLogger;
}

export class KasaClient {
  readonly host: string;
  private klap: KlapTransport | undefined;
  private kind: KasaTransportKind | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly http: AxiosInstance;

  constructor(private readonly options: KasaClientOptions) {
    this.host = options.host;
    this.kind = options.transport;
    // A configured port is used for whichever transport is in play (users normally leave it out)
    const port = options.transport === 'xor' ? 80 : options.port ?? 80;
    this.http = axios.create({
      baseURL: `http://${options.host}${port === 80 ? '' : `:${port}`}`,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      validateStatus: () => true,
      httpAgent: new http.Agent({ keepAlive: false }),
      proxy: false,
    });
  }

  get protocol(): string | undefined {
    return this.kind === 'xor' ? 'XOR' : this.kind === 'klap' ? 'KLAP' : undefined;
  }

  reset(): void {
    this.klap?.reset();
  }

  private async sendKlap(request: string): Promise<TapoParams> {
    this.klap ??= new KlapTransport(this.http, this.options.credentials, this.options.log);
    return (await this.klap.send(request)) as TapoParams;
  }

  private async sendRaw(request: string): Promise<TapoParams> {
    const timeout = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // A configured port is the XOR port unless discovery said the device speaks KLAP (then it is the HTTP port)
    const xorPort = this.options.transport === 'klap' ? XOR_PORT : this.options.port ?? XOR_PORT;
    if (this.kind === 'xor') return xorRequest(this.host, xorPort, request, timeout);
    if (this.kind === 'klap') return this.sendKlap(request);
    try {
      const response = await xorRequest(this.host, xorPort, request, timeout);
      this.kind = 'xor';
      return response;
    } catch (error) {
      this.options.log?.debug(`${this.host}: Kasa port 9999 failed (${error instanceof Error ? error.message : error}), trying KLAP`);
      const response = await this.sendKlap(request);
      this.kind = 'klap';
      return response;
    }
  }

  /** Send one IOT request, e.g. {system: {get_sysinfo: {}}}, and return the whole response. */
  async query(request: TapoParams): Promise<TapoParams> {
    const json = JSON.stringify(request);
    const run = async (): Promise<TapoParams> => {
      try {
        return await this.sendRaw(json);
      } catch (error) {
        // One retry with a new session (KLAP sessions expire)
        this.reset();
        if (this.kind !== 'klap') throw error;
        return this.sendRaw(json);
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** Call `module.method`, optionally on strip sockets, and return its result (checking err_code). */
  async call(module: string, method: string, params: TapoParams = {}, childIds?: string[]): Promise<TapoParams> {
    const response = await this.query({ ...(childIds ? { context: { child_ids: childIds } } : {}), [module]: { [method]: params } });
    const result = (response[module] as TapoParams | undefined)?.[method] as TapoParams | undefined;
    if (!result) throw new Error(`${module}.${method}: empty response`);
    const code = Number(result.err_code ?? 0);
    if (code !== 0) throw new TapoDeviceError(`${module}.${method}: device error ${code}${result.err_msg ? ` (${result.err_msg})` : ''}`, code);
    return result;
  }

  getSysinfo(): Promise<TapoParams> {
    return this.call('system', 'get_sysinfo');
  }
}
