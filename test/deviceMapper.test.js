import { test } from 'node:test';
import assert from 'node:assert/strict';

import { brightnessToLevel, decodeNickname, deviceFunctions, deviceState, hasBattery, hasChildren, levelToBrightness } from '../dist/deviceMapper.js';

// Shapes taken from python-kasa's device fixtures
const p110 = { model: 'P110', type: 'SMART.TAPOPLUG', device_on: true, nickname: Buffer.from('Kettle').toString('base64') };
const l530 = { model: 'L530', type: 'SMART.TAPOBULB', device_on: true, brightness: 50 };
const p300 = { model: 'P300', type: 'SMART.TAPOPLUG' };
const strip = { category: 'plug.powerstrip.sub-plug', device_on: false, position: 2, type: 'SMART.TAPOPLUG' };
const h100 = { model: 'H100', type: 'SMART.TAPOHUB', in_alarm: false };
const t315 = { category: 'subg.trigger.temp-hmdt-sensor', current_temp: 24.0, current_humidity: 62, temp_unit: 'celsius', at_low_battery: false, battery_percentage: 100, status: 'online' };
const t310f = { category: 'subg.trigger.temp-hmdt-sensor', current_temp: 68, current_humidity: 40, temp_unit: 'fahrenheit', at_low_battery: true, status: 'offline' };
const t100 = { category: 'subg.trigger.motion-sensor', detected: true, at_low_battery: false, status: 'online' };
const t110 = { category: 'subg.trigger.contact-sensor', open: true, at_low_battery: false, status: 'online' };
const t300 = { category: 'subg.trigger.water-leak-sensor', water_leak_status: 'water_leak', in_alarm: true, battery_percentage: 80, status: 'online' };
const s200 = { category: 'subg.trigger.button', at_low_battery: false, status: 'online' };
const ke100 = { category: 'subg.trv', current_temp: 22.9, target_temp: 23, status: 'online' };

test('plugs, bulbs and strip outlets', () => {
  assert.deepEqual(deviceFunctions(p110), [{ kind: 'onOff', id: '', dimmable: false }]);
  assert.deepEqual(deviceFunctions(l530), [{ kind: 'onOff', id: '', dimmable: true }]);
  assert.deepEqual(deviceFunctions(strip), [{ kind: 'onOff', id: '', dimmable: false }]);
  assert.deepEqual(deviceFunctions(p300), []);
  assert.equal(hasChildren(p300), true);
  assert.equal(hasChildren(p110), false);
  assert.deepEqual(deviceState(l530), { online: true, on: true, brightness: 50 });
});

test('hub and its sensors, each function separate', () => {
  assert.deepEqual(deviceFunctions(h100), []);
  assert.equal(hasChildren(h100), true);
  assert.deepEqual(deviceFunctions(t315), [
    { kind: 'temperature', id: '' },
    { kind: 'humidity', id: 'humidity', label: 'Humidity' },
  ]);
  assert.deepEqual(deviceFunctions(t100), [{ kind: 'motion', id: '' }]);
  assert.deepEqual(deviceFunctions(t110), [{ kind: 'contact', id: '' }]);
  assert.deepEqual(deviceFunctions(t300), [{ kind: 'waterLeak', id: '' }]);
  // Not supported yet
  assert.deepEqual(deviceFunctions(s200), []);
  assert.deepEqual(deviceFunctions(ke100), []);
});

test('sensor states', () => {
  assert.deepEqual(deviceState(t315), { online: true, temperature: 24, humidity: 62, battery: 100 });
  assert.deepEqual(deviceState(t310f), { online: false, temperature: 20, humidity: 40, battery: 10 });
  assert.equal(deviceState(t100).motion, true);
  assert.equal(deviceState(t110).open, true);
  assert.equal(deviceState(t300).leak, true);
  assert.equal(deviceState({ ...t300, water_leak_status: 'water_dry', in_alarm: false }).leak, false);
  assert.equal(hasBattery(t100), true);
  assert.equal(hasBattery(p110), false);
});

test('nicknames are base64', () => {
  assert.equal(decodeNickname(p110.nickname), 'Kettle');
  assert.equal(decodeNickname(Buffer.from('Salon – Prise').toString('base64')), 'Salon – Prise');
  assert.equal(decodeNickname(''), '');
});

test('brightness conversion', () => {
  assert.equal(brightnessToLevel(100), 254);
  assert.equal(brightnessToLevel(1), 3);
  assert.equal(levelToBrightness(254), 100);
  assert.equal(levelToBrightness(1), 1);
  assert.equal(levelToBrightness(127), 50);
});
