'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { installHomebridgeModuleStub } = require('./helpers/mock-homebridge-module');
const { createFakeAPI, createFakeLogger } = require('./helpers/fake-homebridge');

installHomebridgeModuleStub();

const { DelonghiClient } = require('../dist/api/client');
const { DelonghiComfortPlatform } = require('../dist/platform/platform');

test('platform registers discovered devices on launch and polls for removals', async (t) => {
  const api = createFakeAPI();
  const log = createFakeLogger();

  const firstList = [
    { id: 'one', name: 'Lounge', power: true, mode: 'cool', targetTemperature: 22, roomTemperature: 25, fanSpeed: 'medium' },
    { id: 'two', name: 'Office', power: false, mode: 'off', targetTemperature: 24, roomTemperature: 23, fanSpeed: 'low' },
  ];
  const secondList = [
    { id: 'two', name: 'Office', power: true, mode: 'eco', targetTemperature: 24, roomTemperature: 24, fanSpeed: 'max' },
  ];

  let pollHandler;
  let listDevicesCall = 0;

  const originalLogin = DelonghiClient.prototype.login;
  const originalListDevices = DelonghiClient.prototype.listDevices;
  const originalSetInterval = global.setInterval;

  t.after(() => {
    DelonghiClient.prototype.login = originalLogin;
    DelonghiClient.prototype.listDevices = originalListDevices;
    global.setInterval = originalSetInterval;
  });

  DelonghiClient.prototype.login = async function login() {};
  DelonghiClient.prototype.listDevices = async function listDevices() {
    listDevicesCall += 1;
    return listDevicesCall === 1 ? firstList : secondList;
  };
  global.setInterval = (handler) => {
    pollHandler = handler;
    return 1;
  };

  new DelonghiComfortPlatform(log, {
    username: 'user@example.com',
    password: 'secret',
    scanInterval: 60,
  }, api);

  await api.emit('didFinishLaunching');

  assert.equal(api.snapshots.registered.length, 2);
  assert.equal(api.snapshots.registered[0].displayName, 'Lounge');
  assert.equal(api.snapshots.registered[1].displayName, 'Office');
  assert.equal(typeof pollHandler, 'function');

  await pollHandler();

  assert.equal(api.snapshots.unregistered.length, 1);
  assert.equal(api.snapshots.unregistered[0].displayName, 'Lounge');
  assert.ok(api.snapshots.updated.some(accessory => accessory.displayName === 'Office'));
});

test('platform reuses restored accessories instead of registering duplicates', async (t) => {
  const api = createFakeAPI();
  const log = createFakeLogger();

  const originalLogin = DelonghiClient.prototype.login;
  const originalListDevices = DelonghiClient.prototype.listDevices;
  const originalSetInterval = global.setInterval;

  t.after(() => {
    DelonghiClient.prototype.login = originalLogin;
    DelonghiClient.prototype.listDevices = originalListDevices;
    global.setInterval = originalSetInterval;
  });

  DelonghiClient.prototype.login = async function login() {};
  DelonghiClient.prototype.listDevices = async function listDevices() {
    return [
      { id: 'restored-device', name: 'Bedroom', power: true, mode: 'cool', targetTemperature: 21, roomTemperature: 24, fanSpeed: 'low' },
    ];
  };
  global.setInterval = () => 1;

  const restored = new api.platformAccessory('Bedroom', api.hap.uuid.generate('restored-device'));
  restored.context.device = { id: 'restored-device', name: 'Bedroom' };

  const platform = new DelonghiComfortPlatform(log, {
    username: 'user@example.com',
    password: 'secret',
    scanInterval: 60,
  }, api);
  platform.configureAccessory(restored);

  await api.emit('didFinishLaunching');

  assert.equal(api.snapshots.registered.length, 0);
  assert.equal(api.snapshots.updated.length, 1);
  assert.equal(restored.context.device.mode, 'cool');
});
