import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { TapoAuthError, TapoClient, TapoDeviceError } from '../dist/tapoClient.js';
import { HandshakeKeyPair, KlapSession } from '../dist/tapoCrypto.js';
import { createFakeDevice } from './fakeDevice.js';

const EMAIL = 'owner@example.com';
const PASSWORD = 'Secret-Pass';

const plug = { device_on: false };
const children = Array.from({ length: 12 }, (_, index) => ({ device_id: `child${index}`, status: 'online', device_on: false }));

function handle(request) {
  switch (request.method) {
    case 'get_device_info':
      return { error_code: 0, result: { device_id: 'dev1', model: 'P110', type: 'SMART.TAPOPLUG', device_on: plug.device_on } };
    case 'set_device_info':
      if (typeof request.params.device_on !== 'boolean') return { error_code: -1008 };
      plug.device_on = request.params.device_on;
      return { error_code: 0 };
    case 'get_child_device_list': {
      // Pages of 10, like real hubs
      const start = request.params.start_index;
      return { error_code: 0, result: { child_device_list: children.slice(start, start + 10), start_index: start, sum: children.length } };
    }
    case 'control_child': {
      const child = children.find((c) => c.device_id === request.params.device_id);
      const inner = request.params.requestData;
      if (inner.method === 'set_device_info') child.device_on = inner.params.device_on;
      return { error_code: 0, result: { responseData: { error_code: 0, result: inner.method === 'get_device_info' ? child : {} } } };
    }
    default:
      return { error_code: -1002 };
  }
}

async function withDevice(protocol, run, credentials = { username: EMAIL, password: PASSWORD }, options = {}) {
  const device = createFakeDevice({ protocol, username: EMAIL, password: PASSWORD, handle });
  const port = await device.start();
  const client = new TapoClient({ host: '127.0.0.1', port, credentials, timeoutMs: 3000, ...options });
  try {
    await run(client, device);
  } finally {
    await device.stop();
  }
}

test('RSA handshake key decryption without the platform PKCS#1 decrypt', () => {
  const keyPair = new HandshakeKeyPair();
  const secret = crypto.randomBytes(32);
  const encrypted = crypto.publicEncrypt({ key: keyPair.publicKeyPem, padding: crypto.constants.RSA_PKCS1_PADDING }, secret);
  assert.deepEqual(keyPair.decrypt(encrypted), secret);
});

test('KLAP session sequence numbers wrap like a signed 32 bit integer', () => {
  const session = new KlapSession(Buffer.alloc(16, 1), Buffer.alloc(16, 2), Buffer.alloc(32, 3));
  session.seq = 0x7fffffff;
  const { payload, seq } = session.encrypt('{}');
  assert.equal(seq, -0x80000000);
  assert.ok(payload.length > 32);
});

for (const protocol of ['klap', 'aes']) {
  test(`${protocol}: reads and changes device state`, async () => {
    await withDevice(protocol, async (client, device) => {
      plug.device_on = false;
      const info = await client.getDeviceInfo();
      assert.equal(info.model, 'P110');
      assert.equal(client.protocol, protocol);
      await client.setDeviceInfo({ device_on: true });
      assert.equal(plug.device_on, true);
      assert.equal((await client.getDeviceInfo()).device_on, true);
      // One handshake for all requests
      assert.equal(device.state.handshakes, protocol === 'klap' ? 1 : 2);
    });
  });

  test(`${protocol}: device errors are reported`, async () => {
    await withDevice(protocol, async (client) => {
      await assert.rejects(client.setDeviceInfo({ device_on: 'yes' }), (error) => error instanceof TapoDeviceError && error.code === -1008);
    });
  });

  test(`${protocol}: wrong password is an auth error`, async () => {
    await withDevice(protocol, async (client) => {
      await assert.rejects(client.getDeviceInfo(), TapoAuthError);
    }, { username: EMAIL, password: 'wrong' });
  });

  test(`${protocol}: an expired session is renewed transparently`, async () => {
    await withDevice(protocol, async (client, device) => {
      await client.getDeviceInfo();
      const handshakes = device.state.handshakes;
      device.state.expireNext = true;
      assert.equal((await client.getDeviceInfo()).model, 'P110');
      assert.ok(device.state.handshakes > handshakes);
    });
  });

  test(`${protocol}: child list paging and control_child`, async () => {
    await withDevice(protocol, async (client) => {
      const list = await client.getChildDeviceList();
      assert.equal(list.length, 12);
      await client.controlChild('child11', 'set_device_info', { device_on: true });
      assert.equal(children[11].device_on, true);
      assert.equal((await client.controlChild('child11', 'get_device_info')).device_on, true);
    });
  });

  test(`${protocol}: concurrent requests are serialised`, async () => {
    await withDevice(protocol, async (client) => {
      const results = await Promise.all(Array.from({ length: 5 }, () => client.getDeviceInfo()));
      assert.ok(results.every((info) => info.model === 'P110'));
    });
  });
}

test('without a protocol hint, an AES-only device is found after KLAP fails', async () => {
  await withDevice('aes', async (client) => {
    assert.equal((await client.getDeviceInfo()).model, 'P110');
    assert.equal(client.protocol, 'aes');
  });
});

test('with an AES hint, the login version is tried in the right order', async () => {
  await withDevice('aes', async (client, device) => {
    await client.getDeviceInfo();
    assert.ok('password2' in device.state.logins[0]);
  }, undefined, { protocol: 'aes', loginVersion: 2 });
});

test('an unreachable device reports a timeout or connection error, not an auth error', async () => {
  const client = new TapoClient({ host: '127.0.0.1', port: 1, credentials: { username: EMAIL, password: PASSWORD }, timeoutMs: 1000 });
  await assert.rejects(client.getDeviceInfo(), (error) => !(error instanceof TapoAuthError));
});
