import { test } from 'node:test';
import assert from 'node:assert/strict';

import { KasaDriver, SmartCamHubDriver, SmartDriver, kasaInfo } from '../dist/drivers.js';
import { KasaClient, xorDecrypt, xorEncrypt } from '../dist/kasaClient.js';
import { SmartCamClient } from '../dist/smartCamClient.js';
import { TapoAuthError, TapoClient } from '../dist/tapoClient.js';
import { createFakeDevice } from './fakeDevice.js';
import { createFakeKasaDevice } from './fakeKasaDevice.js';
import { createFakeSmartCamHub } from './fakeSmartCamHub.js';

const EMAIL = 'owner@example.com';
const PASSWORD = 'Secret-Pass';
const b64 = (s) => Buffer.from(s).toString('base64');

// Shapes from python-kasa's fixtures
const hs300 = {
  alias: 'Desk Strip',
  child_num: 3,
  deviceId: '8006ABCDEF',
  mic_type: 'IOT.SMARTPLUGSWITCH',
  model: 'HS300(US)',
  sw_ver: '1.0.12 Build 220121 Rel.175814',
  children: [
    { alias: 'Monitor', id: '8006ABCDEF00', state: 1 },
    { alias: '', id: '01', state: 0 },
    { alias: 'Lamp', id: '8006ABCDEF02', state: 0 },
  ],
};
const kl430 = {
  alias: 'TV Strip',
  deviceId: 'KL430ID',
  mic_type: 'IOT.SMARTBULB',
  model: 'KL430(US)',
  is_color: 1,
  is_dimmable: 1,
  is_variable_color_temp: 1,
  length: 16,
  light_state: { on_off: 0, dft_on_state: { brightness: 40, color_temp: 0, hue: 120, saturation: 80, mode: 'normal' } },
};
const hs220 = { alias: 'Dimmer', deviceId: 'HS220ID', mic_type: 'IOT.SMARTPLUGSWITCH', model: 'HS220(US)', relay_state: 1, brightness: 25 };

test('XOR obfuscation round trip', () => {
  const message = '{"system":{"get_sysinfo":{}}}';
  const encrypted = xorEncrypt(message);
  assert.equal(encrypted.readUInt32BE(0), message.length);
  assert.equal(xorDecrypt(encrypted.subarray(4)), message);
  // Known first bytes of the classic Kasa query
  assert.deepEqual([...encrypted.subarray(4, 8)], [0xd0, 0xf2, 0x81, 0xf8]);
});

test('Kasa power strip sockets become children', () => {
  const { info, children } = kasaInfo(hs300);
  assert.equal(info._name, 'Desk Strip');
  assert.equal(info.device_on, undefined);
  assert.deepEqual(
    children.map((c) => [c.device_id, c._name, c.device_on, c.position]),
    [
      ['8006ABCDEF00', 'Monitor', true, 1],
      ['8006ABCDEF01', '', false, 2],
      ['8006ABCDEF02', 'Lamp', false, 3],
    ],
  );
});

test('Kasa light strip and dimmer', () => {
  const strip = kasaInfo(kl430).info;
  assert.equal(strip.type, 'SMART.TAPOBULB');
  assert.equal(strip.device_on, false);
  // While off, the colour comes from dft_on_state
  assert.equal(strip.hue, 120);
  assert.equal(strip.brightness, 40);
  assert.deepEqual(strip.color_temp_range, [2500, 9000]);
  const dimmer = kasaInfo(hs220).info;
  assert.equal(dimmer.device_on, true);
  assert.equal(dimmer.brightness, 25);
});

test('Kasa XOR: reads a strip and switches one socket', async () => {
  const strip = structuredClone(hs300);
  const device = createFakeKasaDevice((request) => {
    if (request.system?.get_sysinfo) return { system: { get_sysinfo: { ...strip, err_code: 0 } } };
    if (request.system?.set_relay_state) {
      for (const id of request.context.child_ids) strip.children.find((c) => id.endsWith(c.id) || c.id === id).state = request.system.set_relay_state.state;
      return { system: { set_relay_state: { err_code: 0 } } };
    }
    return { system: { [Object.keys(request.system ?? {})[0]]: { err_code: -1, err_msg: 'module not support' } } };
  });
  const port = await device.start();
  try {
    const driver = new KasaDriver(new KasaClient({ host: '127.0.0.1', transport: 'xor', port, credentials: { username: EMAIL, password: PASSWORD } }));
    const { children } = await driver.read();
    assert.equal(children.length, 3);
    assert.equal(driver.protocol, 'Kasa XOR');
    await driver.set('8006ABCDEF02', { device_on: true });
    assert.deepEqual(device.state.requests.at(-1), { context: { child_ids: ['8006ABCDEF02'] }, system: { set_relay_state: { state: 1 } } });
    assert.equal(strip.children[2].state, 1);
  } finally {
    await device.stop();
  }
});

test('Kasa over KLAP: newer firmware with the TP-Link account', async () => {
  const bulb = structuredClone(kl430);
  const device = createFakeDevice({
    protocol: 'klap',
    username: EMAIL,
    password: PASSWORD,
    handle: (request) => {
      if (request.system?.get_sysinfo) return { system: { get_sysinfo: { ...bulb, err_code: 0 } } };
      const service = request['smartlife.iot.lightStrip'];
      if (service) {
        Object.assign(bulb.light_state, service.transition_light_state);
        return { 'smartlife.iot.lightStrip': { transition_light_state: { err_code: 0 } } };
      }
      return {};
    },
  });
  const port = await device.start();
  try {
    const driver = new KasaDriver(new KasaClient({ host: '127.0.0.1', transport: 'klap', port, credentials: { username: EMAIL, password: PASSWORD } }));
    assert.equal((await driver.read()).info._name, 'TV Strip');
    await driver.set(undefined, { device_on: true, hue: 200, saturation: 50 });
    assert.equal(bulb.light_state.on_off, 1);
    assert.equal(bulb.light_state.hue, 200);
    assert.equal(bulb.light_state.color_temp, 0);
  } finally {
    await device.stop();
  }
});

const hubChildren = () => [
  { device_id: 'T310A', category: 'subg.trigger.temp-hmdt-sensor', model: 'T310', nickname: b64('Kitchen'), current_temp: 21.7, current_humidity: 56, temp_unit: 'celsius', status: 'online' },
  { device_id: 'S220A', category: 'subg.plugswitch.switch', model: 'S220', nickname: b64('Hall Light'), device_on: false, status: 'online' },
  ...Array.from({ length: 10 }, (_, i) => ({ device_id: `T100-${i}`, category: 'subg.trigger.motion-sensor', model: 'T100', nickname: b64(`Motion ${i}`), detected: false })),
  { device_id: 'C425A', category: 'camera', alias: 'Garden Cam', device_model: 'C425', device_type: 'SMART.IPCAMERA', status: 'configured' },
];

test('H500/H200 hub: secure HTTPS login, child list paging and child control', async () => {
  const children = hubChildren();
  const hub = createFakeSmartCamHub({
    password: PASSWORD,
    children,
    basicInfo: { dev_id: 'HUBID', device_alias: 'HomeBase', device_model: 'H500', device_type: 'SMART.TAPOHUB', sw_version: '1.2.0 Build 1' },
  });
  const port = await hub.start();
  try {
    const driver = new SmartCamHubDriver(new SmartCamClient({ host: '127.0.0.1', port, credentials: { username: EMAIL, password: PASSWORD } }));
    const { info, children: list } = await driver.read();
    assert.deepEqual([info.device_id, info.model, info.type, info._name], ['HUBID', 'H500', 'SMART.TAPOHUB', 'HomeBase']);
    assert.equal(list.length, 13);
    assert.equal(list[0]._name, 'Kitchen');
    assert.equal(list[12]._name, 'Garden Cam');
    // The account email is refused, "admin" with the account password works
    assert.deepEqual(hub.state.logins.slice(0, 2), [EMAIL, 'admin']);

    await driver.set('S220A', { device_on: true });
    assert.equal(children[1].device_on, true);

    // An expired session is renewed transparently
    hub.state.expireNext = true;
    assert.equal((await driver.read()).info.model, 'H500');
  } finally {
    await hub.stop();
  }
});

test('H500/H200 hub: wrong password is an auth error', async () => {
  const hub = createFakeSmartCamHub({ password: PASSWORD, children: [], basicInfo: {} });
  const port = await hub.start();
  try {
    const client = new SmartCamClient({ host: '127.0.0.1', port, credentials: { username: EMAIL, password: 'wrong' } });
    await assert.rejects(client.getDeviceInfo(), TapoAuthError);
  } finally {
    await hub.stop();
  }
});

test('H500/H200 hub: quick read of children with motion sensor logs in one request', async () => {
  const children = hubChildren();
  children[2].logs = [
    { id: 41, event: 'motion', eventId: 'b', timestamp: 1700000041 },
    { id: 40, event: 'motion', eventId: 'a', timestamp: 1700000040 },
  ];
  const hub = createFakeSmartCamHub({ password: PASSWORD, children, basicInfo: { dev_id: 'HUBID', device_model: 'H500', device_type: 'SMART.TAPOHUB' } });
  const port = await hub.start();
  try {
    const driver = new SmartCamHubDriver(new SmartCamClient({ host: '127.0.0.1', port, credentials: { username: EMAIL, password: PASSWORD } }));
    const before = hub.state.requests.length;
    const { children: list, logs } = await driver.readHubChildren(['T100-0']);
    // 13 children need two pages: one batched request, then the paged list
    assert.equal(list.length, 13);
    assert.deepEqual(logs.get('T100-0').map((entry) => entry.id), [41, 40]);
    assert.equal(hub.state.requests[before].params.requests.length, 2);
  } finally {
    await hub.stop();
  }
});

test('H500/H200 hub siren: status, start with settings, stop, and in the quick read', async () => {
  const hub = createFakeSmartCamHub({ password: PASSWORD, children: hubChildren(), basicInfo: { dev_id: 'HUBID', device_model: 'H500', device_type: 'SMART.TAPOHUB' }, siren: true });
  const port = await hub.start();
  try {
    const driver = new SmartCamHubDriver(new SmartCamClient({ host: '127.0.0.1', port, credentials: { username: EMAIL, password: PASSWORD } }));
    assert.equal(await driver.readSiren(), false);
    await driver.setSiren(true, { sound: 'Alarm 1', volume: 7, duration: 20 });
    assert.deepEqual(hub.state.siren.config, { siren_type: 'Alarm 1', volume: '7', duration: 20 });
    assert.equal((await driver.readHubChildren([])).siren, true);
    assert.equal((await driver.read()).info._siren, true);
    await driver.setSiren(false, {});
    assert.deepEqual(hub.state.siren.commands, ['on', 'off']);
    assert.equal((await driver.readHubChildren([])).siren, false);
  } finally {
    await hub.stop();
  }
});

test('hub without a siren: the siren read fails and quick reads leave it out', async () => {
  const hub = createFakeSmartCamHub({ password: PASSWORD, children: hubChildren(), basicInfo: { dev_id: 'HUBID', device_model: 'H200', device_type: 'SMART.TAPOHUB' } });
  const port = await hub.start();
  try {
    const driver = new SmartCamHubDriver(new SmartCamClient({ host: '127.0.0.1', port, credentials: { username: EMAIL, password: PASSWORD } }));
    await assert.rejects(driver.readSiren());
    assert.equal((await driver.readHubChildren([])).siren, undefined);
  } finally {
    await hub.stop();
  }
});

test('H100 siren: in_alarm, play_alarm with named volume, stop_alarm', async () => {
  const hub = { in_alarm: false, calls: [] };
  const device = createFakeDevice({
    protocol: 'aes',
    username: EMAIL,
    password: PASSWORD,
    handle: (request) => {
      if (request.method === 'get_device_info') return { error_code: 0, result: { device_id: 'H100ID', model: 'H100', type: 'SMART.TAPOHUB', in_alarm: hub.in_alarm } };
      if (request.method === 'get_child_device_list') return { error_code: 0, result: { child_device_list: [], start_index: 0, sum: 0 } };
      if (request.method === 'play_alarm' || request.method === 'stop_alarm') {
        hub.in_alarm = request.method === 'play_alarm';
        hub.calls.push([request.method, request.params ?? null]);
        return { error_code: 0 };
      }
      return { error_code: -1002 };
    },
  });
  const port = await device.start();
  try {
    const driver = new SmartDriver(new TapoClient({ host: '127.0.0.1', port, credentials: { username: EMAIL, password: PASSWORD } }));
    assert.equal((await driver.read()).info._siren, false);
    await driver.setSiren(true, { volume: 9, duration: 15 });
    assert.equal(await driver.readSiren(), true);
    await driver.setSiren(false, {});
    assert.deepEqual(hub.calls, [
      ['play_alarm', { alarm_duration: 15, alarm_volume: 'high' }],
      ['stop_alarm', null],
    ]);
  } finally {
    await device.stop();
  }
});
