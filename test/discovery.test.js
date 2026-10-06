import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';

import { KASA_DISCOVERY_QUERY, crc32, discover, discoveryQuery, parseDiscoveryResponse, parseKasaDiscoveryResponse } from '../dist/discovery.js';
import { xorDecrypt, xorEncrypt } from '../dist/kasaClient.js';

const reply = (result) => Buffer.concat([Buffer.alloc(16), Buffer.from(JSON.stringify({ error_code: 0, result }))]);

const p110 = {
  device_id: 'abc',
  device_model: 'P110(EU)',
  device_type: 'SMART.TAPOPLUG',
  ip: '192.168.68.50',
  mac: '3C-52-A1-00-00-00',
  mgt_encrypt_schm: { encrypt_type: 'AES', http_port: 80, is_support_https: false, lv: 2 },
};
const h200 = {
  device_id: 'def',
  device_model: 'H200(EU)',
  device_type: 'SMART.TAPOHUB',
  ip: '192.168.68.51',
  mac: '00',
  mgt_encrypt_schm: { encrypt_type: 'AES', http_port: 443, is_support_https: true },
};

test('crc32 matches the standard checksum', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('discovery query has a valid header and checksum', () => {
  const query = discoveryQuery();
  assert.equal(query[0], 2);
  assert.equal(query.readUInt16BE(2), 1);
  assert.equal(query.readUInt16BE(4), query.length - 16);
  assert.ok(JSON.parse(query.subarray(16).toString()).params.rsa_key.includes('BEGIN PUBLIC KEY'));
  const copy = Buffer.from(query);
  copy.writeUInt32BE(0x5a6b7c8d, 12);
  assert.equal(crc32(copy), query.readUInt32BE(12));
});

test('discovery replies are parsed', () => {
  assert.deepEqual(parseDiscoveryResponse(reply(p110), '10.0.0.1'), {
    ip: '192.168.68.50',
    deviceType: 'SMART.TAPOPLUG',
    model: 'P110(EU)',
    deviceId: 'abc',
    mac: '3C-52-A1-00-00-00',
    family: 'smart',
    protocol: 'aes',
    kasaTransport: undefined,
    encryptType: 'AES',
    https: false,
    httpPort: 80,
    loginVersion: 2,
  });
  // The H200/H500 hubs speak HTTPS
  assert.equal(parseDiscoveryResponse(reply(h200), '10.0.0.2').family, 'smartcam');
  assert.equal(parseDiscoveryResponse(reply({ ...h200, device_type: 'SMART.IPCAMERA', device_model: 'C210' }), '10.0.0.2').family, 'camera');
  const kasaKlap = parseDiscoveryResponse(reply({ ...p110, device_type: 'IOT.SMARTPLUGSWITCH', device_model: 'HS300(US)', mgt_encrypt_schm: { encrypt_type: 'KLAP', http_port: 80, is_support_https: false } }), '10.0.0.4');
  assert.deepEqual([kasaKlap.family, kasaKlap.kasaTransport], ['kasa', 'klap']);
  assert.equal(parseDiscoveryResponse(Buffer.from('garbage'), '10.0.0.3'), undefined);
});

test('discover collects replies from the network', async () => {
  const device = dgram.createSocket('udp4');
  device.on('message', (message, remote) => {
    if (message[0] === 2) device.send(reply({ ...p110, ip: '' }), remote.port, remote.address);
  });
  await new Promise((resolve) => device.bind(0, '127.0.0.1', resolve));
  try {
    const found = await discover({ timeoutMs: 500, targets: ['127.0.0.1'], port: device.address().port, kasaPort: 1 });
    assert.equal(found.length, 1);
    assert.equal(found[0].ip, '127.0.0.1');
    assert.equal(found[0].protocol, 'aes');
  } finally {
    device.close();
  }
});

test('Kasa discovery replies (UDP 9999) are parsed', () => {
  assert.equal(xorDecrypt(KASA_DISCOVERY_QUERY()), '{"system":{"get_sysinfo":{}}}');
  const answer = xorEncrypt(JSON.stringify({ system: { get_sysinfo: { alias: 'Strip', model: 'KP303(UK)', deviceId: 'ID1', mac: 'AA', mic_type: 'IOT.SMARTPLUGSWITCH' } } }), false);
  const device = parseKasaDiscoveryResponse(answer, '10.0.0.9');
  assert.deepEqual([device.ip, device.model, device.family, device.kasaTransport], ['10.0.0.9', 'KP303(UK)', 'kasa', 'xor']);
  assert.equal(parseKasaDiscoveryResponse(Buffer.from('nope'), '10.0.0.9'), undefined);
});
