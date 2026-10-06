import * as crypto from 'crypto';

/**
 * Cryptography of the two local protocols Tapo devices speak (ported from python-kasa):
 * - KLAP: newer firmware; a seed handshake proves both sides know the TP-Link account, then AES-128-CBC with a sequence number.
 * - AES "securePassthrough": older firmware and the H100 hub; an RSA handshake hands out an AES-128-CBC key, then a login.
 */

export const sha1 = (data: Buffer | string): Buffer => crypto.createHash('sha1').update(data).digest();
export const sha256 = (data: Buffer | string): Buffer => crypto.createHash('sha256').update(data).digest();
export const md5 = (data: Buffer | string): Buffer => crypto.createHash('md5').update(data).digest();

/** KLAP auth hashes for an account, in the order they are tried. */
export type KlapVersion = 1 | 2;

export function klapAuthHash(version: KlapVersion, username: string, password: string): Buffer {
  return version === 2 ? sha256(Buffer.concat([sha1(username), sha1(password)])) : md5(Buffer.concat([md5(username), md5(password)]));
}

export function klapHandshake1Hash(version: KlapVersion, localSeed: Buffer, remoteSeed: Buffer, authHash: Buffer): Buffer {
  return version === 2 ? sha256(Buffer.concat([localSeed, remoteSeed, authHash])) : sha256(Buffer.concat([localSeed, authHash]));
}

export function klapHandshake2Hash(version: KlapVersion, localSeed: Buffer, remoteSeed: Buffer, authHash: Buffer): Buffer {
  return version === 2 ? sha256(Buffer.concat([remoteSeed, localSeed, authHash])) : sha256(Buffer.concat([remoteSeed, authHash]));
}

/** Encryption state of one KLAP session; the sequence number goes up with every request. */
export class KlapSession {
  private readonly key: Buffer;
  private readonly iv: Buffer;
  private readonly sig: Buffer;
  seq: number;

  constructor(localSeed: Buffer, remoteSeed: Buffer, authHash: Buffer) {
    const seeds = Buffer.concat([localSeed, remoteSeed, authHash]);
    this.key = sha256(Buffer.concat([Buffer.from('lsk'), seeds])).subarray(0, 16);
    const fullIv = sha256(Buffer.concat([Buffer.from('iv'), seeds]));
    this.iv = fullIv.subarray(0, 12);
    this.seq = fullIv.readInt32BE(28);
    this.sig = sha256(Buffer.concat([Buffer.from('ldk'), seeds])).subarray(0, 28);
  }

  private ivFor(seq: number): Buffer {
    const iv = Buffer.alloc(16);
    this.iv.copy(iv);
    iv.writeInt32BE(seq, 12);
    return iv;
  }

  /** Encrypt a request: returns the signed payload and the sequence number to send with it. */
  encrypt(message: string): { payload: Buffer; seq: number } {
    // The sequence is a signed 32 bit number on the device
    this.seq = this.seq === 0x7fffffff ? -0x80000000 : this.seq + 1;
    const cipher = crypto.createCipheriv('aes-128-cbc', this.key, this.ivFor(this.seq));
    const ciphertext = Buffer.concat([cipher.update(message, 'utf8'), cipher.final()]);
    const seqBytes = Buffer.alloc(4);
    seqBytes.writeInt32BE(this.seq);
    const signature = sha256(Buffer.concat([this.sig, seqBytes, ciphertext]));
    return { payload: Buffer.concat([signature, ciphertext]), seq: this.seq };
  }

  /** Decrypt the response to the request sent with `seq`. */
  decrypt(data: Buffer, seq: number): string {
    const decipher = crypto.createDecipheriv('aes-128-cbc', this.key, this.ivFor(seq));
    return Buffer.concat([decipher.update(data.subarray(32)), decipher.final()]).toString('utf8');
  }
}

/** AES-128-CBC session of the securePassthrough protocol; payloads are base64. */
export class AesSession {
  constructor(
    private readonly key: Buffer,
    private readonly iv: Buffer,
  ) {}

  encrypt(message: string): string {
    const cipher = crypto.createCipheriv('aes-128-cbc', this.key, this.iv);
    return Buffer.concat([cipher.update(message, 'utf8'), cipher.final()]).toString('base64');
  }

  decrypt(data: string): string {
    const decipher = crypto.createDecipheriv('aes-128-cbc', this.key, this.iv);
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  }
}

/** RSA key pair for the securePassthrough handshake. */
export class HandshakeKeyPair {
  readonly publicKeyPem: string;
  private readonly n: bigint;
  private readonly d: bigint;
  private readonly size: number;

  constructor() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024, publicExponent: 65537 });
    this.publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const jwk = privateKey.export({ format: 'jwk' });
    this.n = base64UrlToBigInt(jwk.n!);
    this.d = base64UrlToBigInt(jwk.d!);
    this.size = Buffer.from(jwk.n!, 'base64url').length;
  }

  /**
   * Decrypt the device's RSA PKCS#1 v1.5 encrypted session key. Done by hand because Bun and recent
   * Node releases refuse PKCS#1 v1.5 private decryption (an old timing attack does not apply here:
   * the key pair lives for one handshake).
   */
  decrypt(encrypted: Buffer): Buffer {
    const message = modPow(BigInt('0x' + encrypted.toString('hex')), this.d, this.n);
    const block = Buffer.from(message.toString(16).padStart(this.size * 2, '0'), 'hex');
    // 0x00 0x02 <non-zero padding> 0x00 <message>
    const separator = block.indexOf(0, 2);
    if (block[0] !== 0 || block[1] !== 2 || separator < 10) throw new Error('could not decrypt the handshake key');
    return block.subarray(separator + 1);
  }
}

function base64UrlToBigInt(value: string): bigint {
  return BigInt('0x' + Buffer.from(value, 'base64url').toString('hex'));
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  base %= modulus;
  while (exponent > 0n) {
    if (exponent & 1n) result = (result * base) % modulus;
    exponent >>= 1n;
    base = (base * base) % modulus;
  }
  return result;
}

/** Login parameters of the securePassthrough `login_device` call; version 2 hashes the password too. */
export function aesLoginParams(loginVersion: 1 | 2, username: string, password: string): Record<string, string> {
  const hex = (value: string): string => sha1(value).toString('hex');
  const b64 = (value: string): string => Buffer.from(value).toString('base64');
  return loginVersion === 2 ? { username: b64(hex(username)), password2: b64(hex(password)) } : { username: b64(hex(username)), password: b64(password) };
}

/** Credentials Tapo devices accept before (or besides) the owner's account. From python-kasa. */
export const DEFAULT_TAPO_CREDENTIALS = { username: 'test@tp-link.net', password: 'test' };
export const DEFAULT_KASA_CREDENTIALS = { username: 'kasa@tp-link.net', password: 'kasaSetup' };
