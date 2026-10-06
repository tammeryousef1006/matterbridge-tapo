import axios, { AxiosInstance, AxiosResponse } from 'axios';
import * as crypto from 'crypto';
import * as http from 'http';

import {
  AesSession,
  DEFAULT_KASA_CREDENTIALS,
  DEFAULT_TAPO_CREDENTIALS,
  HandshakeKeyPair,
  KlapSession,
  KlapVersion,
  aesLoginParams,
  klapAuthHash,
  klapHandshake1Hash,
  klapHandshake2Hash,
} from './tapoCrypto.js';

export interface TapoLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

export interface TapoCredentials {
  /** TP-Link (Tapo app) account email. */
  username: string;
  password: string;
}

export type TapoProtocol = 'klap' | 'aes';

export interface TapoClientOptions {
  host: string;
  /** HTTP port, 80 unless discovery says otherwise. */
  port?: number;
  credentials: TapoCredentials;
  /** Protocol from discovery; without it KLAP is tried first, then AES. */
  protocol?: TapoProtocol;
  /** AES login version from discovery (`lv`). */
  loginVersion?: number;
  timeoutMs?: number;
  log?: TapoLogger;
}

export type TapoParams = Record<string, unknown>;

/** An error reported by the device itself (non-zero `error_code`). */
export class TapoDeviceError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = 'TapoDeviceError';
  }
}

/** The device rejected the TP-Link account email/password. */
export class TapoAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TapoAuthError';
  }
}

/** A failure that a new handshake usually fixes (expired session, device restarted). */
class SessionError extends Error {}

const SESSION_TIMEOUT_ERROR = 9999;
/** Codes that mean the session or login is gone and a new handshake is needed. */
const SESSION_ERRORS = new Set([SESSION_TIMEOUT_ERROR, 1002, 1112, -1001, -40401]);
/** Codes returned for wrong credentials. */
const LOGIN_ERRORS = new Set([-1501, 1111, 1100, 1003, -1005]);
const ONE_DAY_S = 86400;
const SESSION_EXPIRE_BUFFER_S = 20 * 60;
const DEFAULT_TIMEOUT_MS = 10000;

interface TapoEnvelope {
  error_code?: number;
  result?: unknown;
  msg?: string;
}

export function errorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    if (error.response) return `HTTP ${error.response.status} from the device`;
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') return 'the device did not answer (timeout)';
    if (error.code === 'ECONNREFUSED') return 'connection refused by the device';
    if (error.code === 'EHOSTUNREACH' || error.code === 'ENETUNREACH') return 'the device is unreachable';
    return error.message || String(error.code);
  }
  return error instanceof Error ? error.message : String(error);
}

/** Throw the right error for a non-zero `error_code`. */
function checkErrorCode(envelope: TapoEnvelope, what: string): void {
  const code = envelope.error_code ?? 0;
  if (code === 0) return;
  if (SESSION_ERRORS.has(code)) throw new SessionError(`${what}: session error ${code}`);
  if (LOGIN_ERRORS.has(code)) throw new TapoAuthError(`${what}: the device rejected the login (error ${code})`);
  throw new TapoDeviceError(`${what}: device error ${code}${envelope.msg ? ` (${envelope.msg})` : ''}`, code);
}

/** Read one cookie value from Set-Cookie headers. */
function cookie(response: AxiosResponse, name: string): string | undefined {
  const headers = response.headers['set-cookie'];
  for (const header of Array.isArray(headers) ? headers : headers ? [headers] : []) {
    for (const part of String(header).split(';')) {
      const [key, ...value] = part.trim().split('=');
      if (key === name) return value.join('=');
    }
  }
  return undefined;
}

function sessionExpiry(response: AxiosResponse): number {
  const timeout = Number(cookie(response, 'TIMEOUT')) || ONE_DAY_S;
  return Date.now() + Math.max(60, timeout - SESSION_EXPIRE_BUFFER_S) * 1000;
}

interface Transport {
  readonly protocol: TapoProtocol;
  send(request: string): Promise<TapoEnvelope>;
  reset(): void;
}

/** Accounts tried during a handshake: the owner's first, then the defaults devices also accept. */
function candidateCredentials(credentials: TapoCredentials): TapoCredentials[] {
  return [credentials, DEFAULT_TAPO_CREDENTIALS, DEFAULT_KASA_CREDENTIALS, { username: '', password: '' }];
}

class KlapTransport implements Transport {
  readonly protocol = 'klap';
  private session: KlapSession | undefined;
  private sessionCookie: string | undefined;
  private expiresAt = 0;

  constructor(
    private readonly http: AxiosInstance,
    private readonly credentials: TapoCredentials,
    private readonly log?: TapoLogger,
  ) {}

  reset(): void {
    this.session = undefined;
  }

  private async handshake(): Promise<void> {
    this.session = undefined;
    const localSeed = crypto.randomBytes(16);
    const response1 = await this.http.post('/app/handshake1', localSeed, { responseType: 'arraybuffer' });
    // Devices without KLAP answer 404 (or another error) here
    if (response1.status !== 200) throw new ProtocolUnsupportedError(`KLAP handshake1 answered HTTP ${response1.status}`);
    const data = Buffer.from(response1.data as ArrayBuffer);
    if (data.length !== 48) throw new ProtocolUnsupportedError(`unexpected KLAP handshake1 response (${data.length} bytes)`);
    const remoteSeed = data.subarray(0, 16);
    const serverHash = data.subarray(16);
    const sessionId = cookie(response1, 'TP_SESSIONID');
    this.sessionCookie = sessionId ? `TP_SESSIONID=${sessionId}` : undefined;

    let match: { version: KlapVersion; authHash: Buffer; index: number } | undefined;
    candidateCredentials(this.credentials).some(({ username, password }, index) =>
      ([2, 1] as KlapVersion[]).some((version) => {
        const authHash = klapAuthHash(version, username, password);
        if (!klapHandshake1Hash(version, localSeed, remoteSeed, authHash).equals(serverHash)) return false;
        match = { version, authHash, index };
        return true;
      }),
    );
    if (!match) throw new TapoAuthError('the device did not accept the TP-Link email/password (both are case-sensitive)');
    if (match.index > 0) this.log?.debug(`KLAP handshake matched default credentials #${match.index}`);

    const response2 = await this.http.post('/app/handshake2', klapHandshake2Hash(match.version, localSeed, remoteSeed, match.authHash), {
      responseType: 'arraybuffer',
      headers: this.headers(),
    });
    if (response2.status !== 200) throw new Error(`handshake2 failed with HTTP ${response2.status}`);
    this.session = new KlapSession(localSeed, remoteSeed, match.authHash);
    this.expiresAt = sessionExpiry(response1);
  }

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/octet-stream', ...(this.sessionCookie ? { Cookie: this.sessionCookie } : {}) };
  }

  async send(request: string): Promise<TapoEnvelope> {
    if (!this.session || Date.now() >= this.expiresAt) await this.handshake();
    const session = this.session!;
    const { payload, seq } = session.encrypt(request);
    const response = await this.http.post('/app/request', payload, { params: { seq }, responseType: 'arraybuffer', headers: this.headers() });
    if (response.status === 403 || response.status === 401) {
      this.reset();
      throw new SessionError(`the device ended the session (HTTP ${response.status})`);
    }
    if (response.status !== 200) throw new Error(`request failed with HTTP ${response.status}`);
    return JSON.parse(session.decrypt(Buffer.from(response.data as ArrayBuffer), seq)) as TapoEnvelope;
  }
}

class AesTransport implements Transport {
  readonly protocol = 'aes';
  private session: AesSession | undefined;
  private sessionCookie: string | undefined;
  private token: string | undefined;
  private expiresAt = 0;

  constructor(
    private readonly http: AxiosInstance,
    private readonly credentials: TapoCredentials,
    private loginVersion: number | undefined,
    private readonly log?: TapoLogger,
  ) {}

  reset(): void {
    this.session = undefined;
    this.token = undefined;
  }

  private async handshake(): Promise<void> {
    this.reset();
    const keyPair = new HandshakeKeyPair();
    const response = await this.http.post('/app', { method: 'handshake', params: { key: keyPair.publicKeyPem } }, { headers: { 'Content-Type': 'application/json' } });
    if (response.status !== 200) throw new ProtocolUnsupportedError(`securePassthrough handshake answered HTTP ${response.status}`);
    const body = response.data as TapoEnvelope;
    if (typeof body !== 'object' || body === null) throw new ProtocolUnsupportedError('unexpected securePassthrough handshake response');
    checkErrorCode(body, 'handshake');
    const key = (body.result as { key?: string } | undefined)?.key;
    if (!key) throw new Error('handshake response has no key');
    const keyAndIv = keyPair.decrypt(Buffer.from(key, 'base64'));
    this.session = new AesSession(keyAndIv.subarray(0, 16), keyAndIv.subarray(16, 32));
    const sessionId = cookie(response, 'TP_SESSIONID') ?? cookie(response, 'SESSIONID');
    this.sessionCookie = sessionId ? `TP_SESSIONID=${sessionId}` : undefined;
    this.expiresAt = sessionExpiry(response);
  }

  private async passthrough(request: string): Promise<TapoEnvelope> {
    const session = this.session!;
    const response = await this.http.post(
      this.token ? `/app?token=${this.token}` : '/app',
      { method: 'securePassthrough', params: { request: session.encrypt(request) } },
      { headers: { 'Content-Type': 'application/json', ...(this.sessionCookie ? { Cookie: this.sessionCookie } : {}) } },
    );
    if (response.status !== 200) throw new Error(`securePassthrough failed with HTTP ${response.status}`);
    const body = response.data as TapoEnvelope;
    checkErrorCode(body, 'securePassthrough');
    const encrypted = (body.result as { response?: string } | undefined)?.response;
    if (typeof encrypted !== 'string') throw new Error('securePassthrough response is empty');
    return JSON.parse(session.decrypt(encrypted)) as TapoEnvelope;
  }

  /** Log in with the account, trying both login versions, then the default credentials. */
  private async login(): Promise<void> {
    const versions: (1 | 2)[] = this.loginVersion === 2 ? [2, 1] : [1, 2];
    const attempts = candidateCredentials(this.credentials)
      .slice(0, 2)
      .flatMap((credentials) => versions.map((version) => ({ credentials, version })));
    let lastError: unknown;
    for (const [index, { credentials, version }] of attempts.entries()) {
      // A failed login leaves the session unusable, so every retry starts with a new handshake
      if (index > 0 || !this.session) await this.handshake();
      try {
        const response = await this.passthrough(
          JSON.stringify({ method: 'login_device', params: aesLoginParams(version, credentials.username, credentials.password), request_time_milis: Date.now() }),
        );
        checkErrorCode(response, 'login');
        const token = (response.result as { token?: string } | undefined)?.token;
        if (!token) throw new Error('login response has no token');
        this.token = token;
        this.loginVersion = version;
        if (credentials !== this.credentials) this.log?.debug('AES login worked with the default Tapo credentials');
        return;
      } catch (error) {
        if (!(error instanceof TapoAuthError)) throw error;
        lastError = error;
      }
    }
    throw lastError instanceof TapoAuthError ? new TapoAuthError('the device did not accept the TP-Link email/password (both are case-sensitive)') : lastError;
  }

  async send(request: string): Promise<TapoEnvelope> {
    if (!this.session || Date.now() >= this.expiresAt) await this.handshake();
    if (!this.token) await this.login();
    return this.passthrough(request);
  }
}

class ProtocolUnsupportedError extends Error {}

export interface ChildRequestResult {
  method: string;
  result?: unknown;
  error_code?: number;
}

/**
 * Client for one Tapo device on the local network. Requests are serialised: Tapo devices handle one
 * session at a time and the KLAP sequence number must not race.
 */
export class TapoClient {
  readonly host: string;
  private readonly http: AxiosInstance;
  private readonly terminalUuid = crypto.randomBytes(16).toString('hex').toUpperCase();
  private transport: Transport | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: TapoClientOptions) {
    this.host = options.host;
    const port = options.port ?? 80;
    this.http = axios.create({
      baseURL: `http://${options.host}${port === 80 ? '' : `:${port}`}`,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      validateStatus: () => true,
      // Tapo devices close idle connections quickly; a kept-alive socket would fail the next request
      httpAgent: new http.Agent({ keepAlive: false }),
      proxy: false,
    });
  }

  /** The protocol in use once connected. */
  get protocol(): TapoProtocol | undefined {
    return this.transport?.protocol;
  }

  private createTransport(protocol: TapoProtocol): Transport {
    return protocol === 'klap'
      ? new KlapTransport(this.http, this.options.credentials, this.options.log)
      : new AesTransport(this.http, this.options.credentials, this.options.loginVersion, this.options.log);
  }

  private async sendWithTransport(request: string): Promise<TapoEnvelope> {
    if (this.transport) return this.transport.send(request);
    const order: TapoProtocol[] = this.options.protocol === 'aes' ? ['aes', 'klap'] : ['klap', 'aes'];
    const errors: unknown[] = [];
    for (const protocol of order) {
      const transport = this.createTransport(protocol);
      try {
        const response = await transport.send(request);
        this.transport = transport;
        this.options.log?.debug(`${this.host}: connected with ${protocol.toUpperCase()}`);
        return response;
      } catch (error) {
        // Wrong credentials won't get better with the other protocol
        if (error instanceof TapoAuthError) throw error;
        this.options.log?.debug(`${this.host}: ${protocol.toUpperCase()} failed: ${errorMessage(error)}`);
        errors.push(error);
      }
    }
    // Report the real problem (a timeout, say) rather than "protocol not supported"
    throw errors.find((error) => !(error instanceof ProtocolUnsupportedError)) ?? errors[0];
  }

  /** Send one request, with one new handshake when the session has expired. */
  private async send(method: string, params?: TapoParams): Promise<TapoEnvelope> {
    const request = JSON.stringify({ method, ...(params ? { params } : {}), request_time_milis: Date.now(), terminal_uuid: this.terminalUuid });
    const run = async (): Promise<TapoEnvelope> => {
      for (let attempt = 0; ; attempt++) {
        try {
          const response = await this.sendWithTransport(request);
          checkErrorCode(response, method);
          return response;
        } catch (error) {
          if (!(error instanceof SessionError) || attempt > 0) throw error;
          this.transport?.reset();
        }
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  async request<T = TapoParams>(method: string, params?: TapoParams): Promise<T> {
    return (await this.send(method, params)).result as T;
  }

  /** Drop the session so the next request starts with a new handshake. */
  reset(): void {
    this.transport?.reset();
  }

  getDeviceInfo(): Promise<TapoParams> {
    return this.request('get_device_info');
  }

  setDeviceInfo(params: TapoParams): Promise<unknown> {
    return this.request('set_device_info', params);
  }

  /** All children of a hub or power strip, following the device's paging. */
  async getChildDeviceList(): Promise<TapoParams[]> {
    const children: TapoParams[] = [];
    for (;;) {
      const page = await this.request<{ child_device_list?: TapoParams[]; sum?: number }>('get_child_device_list', { start_index: children.length });
      const list = page?.child_device_list ?? [];
      children.push(...list);
      if (list.length === 0 || children.length >= (page?.sum ?? 0)) return children;
    }
  }

  /** Send a request to a hub or strip child through its parent. */
  async controlChild<T = TapoParams>(deviceId: string, method: string, params?: TapoParams): Promise<T> {
    const result = await this.request<{ responseData?: TapoEnvelope }>('control_child', {
      device_id: deviceId,
      requestData: { method, ...(params ? { params } : {}) },
    });
    const response = result?.responseData;
    if (response) checkErrorCode(response, `${method} on child`);
    return response?.result as T;
  }
}
