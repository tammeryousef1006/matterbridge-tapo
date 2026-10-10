import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';
import * as https from 'https';

import { AesSession, md5, sha256 } from './tapoCrypto.js';
import { DEFAULT_TIMEOUT_MS, TapoAuthError, TapoCredentials, TapoDeviceError, TapoLogger, TapoParams } from './tapoClient.js';

/**
 * Client for TP-Link's HTTPS "smartcam" protocol, used by the H200/H500 hubs and Tapo cameras
 * (ported from python-kasa's SslAesTransport and SmartCamProtocol):
 * - handshake1: `login` with a client nonce; the device answers with its nonce and a proof that it knows the password
 * - handshake2: `login` with a digest of the password; the device answers with a session token (`stok`) and a sequence number
 * - requests: AES-128-CBC "securePassthrough" to https://<ip>/stok=<stok>/ds, signed in a `Tapo_tag` header
 * Requests are always sent as `multipleRequest`, like the Tapo app does.
 */

const sha256Upper = (data: string): string => sha256(data).toString('hex').toUpperCase();
const md5Upper = (data: string): string => md5(data).toString('hex').toUpperCase();

/** Device answers that drive the login. */
const INVALID_NONCE = -40413;
const SESSION_EXPIRED = -40401;
const DEVICE_BLOCKED = -40404;
/** Errors that mean the session token is no longer valid. */
const SESSION_ERRORS = new Set([SESSION_EXPIRED, 9999, -40210]);
/** Username Tapo hubs and cameras use for local logins with the account password. */
const ADMIN_USERNAME = 'admin';

const CIPHERS = [
  'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-RSA-AES256-GCM-SHA384',
  'AES256-GCM-SHA384',
  'AES256-SHA256',
  'AES128-GCM-SHA256',
  'AES128-SHA256',
  'AES256-SHA',
].join(':');

interface Envelope {
  error_code?: number;
  result?: Record<string, unknown> & { data?: Record<string, unknown> };
  data?: Record<string, unknown>;
}

class SessionExpired extends Error {}

export interface SmartCamClientOptions {
  host: string;
  port?: number;
  credentials: TapoCredentials;
  timeoutMs?: number;
  log?: TapoLogger;
}

interface Session {
  /** Path of the token URL, "/stok=.../ds". */
  path: string;
  /** undefined for the "less secure" login some older firmware uses: requests then go unencrypted. */
  aes?: AesSession;
  seq: number;
  /** sha256/md5 of the password, signs every request. */
  pwdHash: string;
  localNonce: string;
}

export class SmartCamClient {
  readonly host: string;
  readonly protocol = 'https';
  private readonly http: AxiosInstance;
  private session: Session | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: SmartCamClientOptions) {
    this.host = options.host;
    const port = options.port ?? 443;
    this.http = axios.create({
      baseURL: `https://${options.host}${port === 443 ? '' : `:${port}`}`,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      validateStatus: () => true,
      // The devices use self-signed certificates; the login itself proves the device knows the password
      httpsAgent: new https.Agent({ rejectUnauthorized: false, keepAlive: false, ciphers: CIPHERS }),
      proxy: false,
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        requestByApp: 'true',
        Accept: 'application/json',
        'User-Agent': 'Tapo CameraClient Android',
        Referer: `https://${options.host}:${port}`,
      },
      // Keep the body exactly as signed in the Tapo_tag header
      transformRequest: [(data) => data],
    });
  }

  reset(): void {
    this.session = undefined;
  }

  private async post(path: string, body: string, headers: Record<string, string> = {}): Promise<{ status: number; data: Envelope }> {
    const response = await this.http.post(path, body, { headers });
    let data = response.data as Envelope | string;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data) as Envelope;
      } catch {
        data = {};
      }
    }
    return { status: response.status, data: data ?? {} };
  }

  private async login(): Promise<Session> {
    const { username, password } = this.options.credentials;
    let lastResponse: Envelope | undefined;
    // Hubs and cameras accept the account email or "admin", both with the account password
    for (const user of [...new Set([username, ADMIN_USERNAME])]) {
      const localNonce = crypto.randomBytes(8).toString('hex').toUpperCase();
      const { status, data } = await this.post('/', JSON.stringify({ method: 'login', params: { cnonce: localNonce, encrypt_type: '3', username: user } }));
      if (status !== 200) throw new Error(`login answered HTTP ${status}`);
      lastResponse = data;
      const inner = data.result?.data ?? {};
      if (data.error_code === INVALID_NONCE && typeof inner.nonce === 'string' && typeof inner.device_confirm === 'string') {
        return this.secureLogin(user, localNonce, inner.nonce, inner.device_confirm);
      }
      // Older firmware: a plain login with the md5 of the password, then unencrypted requests
      const encryptTypes = inner.encrypt_type;
      if (data.error_code === SESSION_EXPIRED && Array.isArray(encryptTypes) && !(encryptTypes.length === 1 && encryptTypes[0] === '3')) {
        const session = await this.lessSecureLogin(user);
        if (session) return session;
      }
      if (data.error_code === DEVICE_BLOCKED || data.data?.code === DEVICE_BLOCKED) {
        throw new TapoDeviceError(`the device blocked logins for ${data.data?.sec_left ?? 'a few'} seconds after failed attempts`, DEVICE_BLOCKED);
      }
    }
    this.options.log?.debug(`${this.host}: login refused: ${JSON.stringify(lastResponse)}`);
    throw new TapoAuthError('the device did not accept the TP-Link email/password (both are case-sensitive)');
  }

  private async secureLogin(user: string, localNonce: string, serverNonce: string, deviceConfirm: string): Promise<Session> {
    const { password } = this.options.credentials;
    // The device stores either the sha256 or the md5 of the password; its confirmation says which
    const pwdHash = [sha256Upper(password), md5Upper(password)].find(
      (hash) => sha256Upper(localNonce + hash + serverNonce) + serverNonce + localNonce === deviceConfirm,
    );
    if (!pwdHash) throw new TapoAuthError('the device did not accept the TP-Link password (it is case-sensitive)');

    const digest = sha256Upper(pwdHash + localNonce + serverNonce) + localNonce + serverNonce;
    const { status, data } = await this.post(
      '/',
      JSON.stringify({ method: 'login', params: { cnonce: localNonce, encrypt_type: '3', digest_passwd: digest, username: user } }),
    );
    if (status !== 200) throw new Error(`login answered HTTP ${status}`);
    if (data.error_code === INVALID_NONCE) throw new TapoAuthError('the device rejected the password digest');
    if (data.error_code) throw new TapoDeviceError(`login failed with device error ${data.error_code}`, data.error_code);
    const stok = data.result?.stok;
    const seq = Number(data.result?.start_seq);
    if (typeof stok !== 'string' || !Number.isFinite(seq)) throw new Error('login response has no session token');

    const hashedKey = sha256Upper(localNonce + pwdHash + serverNonce);
    const token = (type: string): Buffer => sha256(type + localNonce + serverNonce + hashedKey).subarray(0, 16);
    return { path: `/stok=${stok}/ds`, aes: new AesSession(token('lsk'), token('ivb')), seq, pwdHash, localNonce };
  }

  private async lessSecureLogin(user: string): Promise<Session | undefined> {
    const pwdHash = md5Upper(this.options.credentials.password);
    const { status, data } = await this.post('/', JSON.stringify({ method: 'login', params: { hashed: true, password: pwdHash, username: user } }));
    const stok = data.result?.stok;
    if (status !== 200 || data.error_code !== 0 || typeof stok !== 'string') return undefined;
    this.options.log?.debug(`${this.host}: logged in with the unencrypted (older firmware) login`);
    return { path: `/stok=${stok}/ds`, seq: 0, pwdHash, localNonce: '' };
  }

  private async sendOnce(session: Session, request: string): Promise<Envelope> {
    if (!session.aes) {
      const { status, data } = await this.post(session.path, request);
      if (status === 401) throw new SessionExpired();
      if (status !== 200) throw new Error(`request answered HTTP ${status}`);
      return data;
    }
    const body = JSON.stringify({ method: 'securePassthrough', params: { request: session.aes.encrypt(request) } });
    const tag = sha256Upper(sha256Upper(session.pwdHash + session.localNonce) + body + String(session.seq));
    const { status, data } = await this.post(session.path, body, { Seq: String(session.seq), Tapo_tag: tag });
    session.seq++;
    // 401: the session expired; 500: another client logged in from this host
    if (status === 401 || status === 500) throw new SessionExpired();
    if (status !== 200) throw new Error(`request answered HTTP ${status}`);
    if (data.error_code && SESSION_ERRORS.has(data.error_code)) throw new SessionExpired();
    if (data.error_code) throw new TapoDeviceError(`device error ${data.error_code}`, data.error_code);
    const encrypted = data.result?.response;
    if (typeof encrypted !== 'string') return data;
    try {
      return JSON.parse(session.aes.decrypt(encrypted)) as Envelope;
    } catch {
      return JSON.parse(encrypted) as Envelope;
    }
  }

  /** Send a request, logging in first and once more when the session has expired. */
  private async send(request: TapoParams): Promise<Envelope> {
    const json = JSON.stringify(request);
    const run = async (): Promise<Envelope> => {
      for (let attempt = 0; ; attempt++) {
        this.session ??= await this.login();
        try {
          const response = await this.sendOnce(this.session, json);
          if (response.error_code && SESSION_ERRORS.has(response.error_code)) throw new SessionExpired();
          return response;
        } catch (error) {
          this.session = undefined;
          if (!(error instanceof SessionExpired) || attempt > 0) throw error instanceof SessionExpired ? new Error('the device keeps ending the session') : error;
        }
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** Run several smartcam methods in one round trip; each entry gets its result or its error. */
  async requestMany(requests: { method: string; params: TapoParams }[]): Promise<{ method: string; result?: unknown; error_code?: number }[]> {
    const response = await this.send({ method: 'multipleRequest', params: { requests } });
    if (response.error_code) throw new TapoDeviceError(`multipleRequest: device error ${response.error_code}`, response.error_code);
    return (response.result?.responses as { method: string; result?: unknown; error_code?: number }[] | undefined) ?? [];
  }

  /** Run one smartcam method (as a single-entry multipleRequest) and return its result. */
  async request<T = TapoParams>(method: string, params: TapoParams): Promise<T> {
    const entry = (await this.requestMany([{ method, params }]))[0];
    if (!entry) throw new Error(`${method}: empty response`);
    if (entry.error_code) throw new TapoDeviceError(`${method}: device error ${entry.error_code}`, entry.error_code);
    return entry.result as T;
  }

  /**
   * The hub's child list plus the trigger logs (latest events) of some children, in one round trip.
   * A child whose logs could not be read is left out of the map.
   */
  async getChildrenAndLogs(
    logChildIds: string[],
    includeSiren = false,
  ): Promise<{ children: TapoParams[]; logs: Map<string, TapoParams[]>; siren?: boolean }> {
    const responses = await this.requestMany([
      { method: 'getChildDeviceList', params: { childControl: { start_index: 0 } } },
      ...logChildIds.map((id) => ({ method: 'controlChild', params: { childControl: { device_id: id, request_data: { method: 'get_trigger_logs', params: { start_id: 0 } } } } })),
      ...(includeSiren ? [{ method: 'getSirenStatus', params: { siren: {} } }] : []),
    ]);
    const sirenResponse = includeSiren ? responses.pop() : undefined;
    const [list, ...logResponses] = responses;
    if (!list || list.error_code) throw new TapoDeviceError(`getChildDeviceList: device error ${list?.error_code}`, list?.error_code ?? -1);
    const page = list.result as { child_device_list?: TapoParams[]; sum?: number } | undefined;
    let children = page?.child_device_list ?? [];
    // More children than one page: read the full list the normal way
    if (children.length < (page?.sum ?? 0)) children = await this.getChildDeviceList();
    const logs = new Map<string, TapoParams[]>();
    logResponses.forEach((entry, index) => {
      const data = (entry?.result as { response_data?: { error_code?: number; result?: { logs?: TapoParams[] } } } | undefined)?.response_data;
      if (!entry?.error_code && !data?.error_code && Array.isArray(data?.result?.logs)) logs.set(logChildIds[index], data.result.logs);
    });
    return { children, logs, siren: sirenResponse && !sirenResponse.error_code ? sirenActive(sirenResponse.result) : undefined };
  }

  /** Whether the hub's siren is sounding. Throws when the hub has no siren. */
  async getSirenStatus(): Promise<boolean> {
    return sirenActive(await this.request('getSirenStatus', { siren: {} }));
  }

  /** Start or stop the siren; sound, volume (1-10) and duration (seconds) change the hub's siren settings first. */
  async setSiren(on: boolean, config: { sound?: string; volume?: number; duration?: number } = {}): Promise<void> {
    if (on) {
      const settings: TapoParams = {};
      if (config.sound) settings.siren_type = config.sound;
      if (config.volume !== undefined) settings.volume = String(config.volume);
      if (config.duration !== undefined) settings.duration = config.duration;
      if (Object.keys(settings).length > 0) await this.request('setSirenConfig', { siren: settings });
    }
    await this.request('setSirenStatus', { siren: { status: on ? 'on' : 'off' } });
  }

  /** basic_info of the hub or camera: device_alias, device_model, dev_id, sw_version, device_type... */
  async getDeviceInfo(): Promise<TapoParams> {
    const result = await this.request<{ device_info?: { basic_info?: TapoParams } }>('getDeviceInfo', { device_info: { name: ['basic_info'] } });
    return result.device_info?.basic_info ?? {};
  }

  /** All devices paired to the hub, following the paging. */
  async getChildDeviceList(): Promise<TapoParams[]> {
    const children: TapoParams[] = [];
    for (;;) {
      const page = await this.request<{ child_device_list?: TapoParams[]; sum?: number }>('getChildDeviceList', { childControl: { start_index: children.length } });
      const list = page?.child_device_list ?? [];
      children.push(...list);
      if (list.length === 0 || children.length >= (page?.sum ?? 0)) return children;
    }
  }

  /** Send a SMART request (e.g. set_device_info) to a hub child. */
  async controlChild<T = TapoParams>(deviceId: string, method: string, params?: TapoParams): Promise<T> {
    const result = await this.request<{ response_data?: { error_code?: number; result?: unknown } }>('controlChild', {
      childControl: { device_id: deviceId, request_data: { method, ...(params ? { params } : {}) } },
    });
    const response = result?.response_data;
    if (response?.error_code) throw new TapoDeviceError(`${method} on child: device error ${response.error_code}`, response.error_code);
    return response?.result as T;
  }
}

/** getSirenStatus answers {status: "on"|"off", time_left}, possibly inside a "siren" section. */
function sirenActive(result: unknown): boolean {
  const data = (result ?? {}) as { status?: unknown; siren?: { status?: unknown } };
  const status = data.status ?? data.siren?.status;
  if (typeof status !== 'string') throw new Error('no siren status');
  return status !== 'off';
}
