'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { installHomebridgeModuleStub } = require('./helpers/mock-homebridge-module');
const { createFakeAPI, createFakeLogger } = require('./helpers/fake-homebridge');

installHomebridgeModuleStub();

const { DelonghiComfortAccessory } = require('../dist/accessories/DelonghiComfortAccessory');

function createClientSpy() {
  const calls = {
    setPower: [],
    setMode: [],
    setTargetTemperature: [],
    setFanSpeed: [],
    setSilentMode: [],
    setSwingMode: [],
  };

  return {
    calls,
    async setPower(deviceId, value) {
      calls.setPower.push([deviceId, value]);
    },
    async setMode(deviceId, value) {
      calls.setMode.push([deviceId, value]);
    },
    async setTargetTemperature(deviceId, value) {
      calls.setTargetTemperature.push([deviceId, value]);
    },
    async setFanSpeed(deviceId, value) {
      calls.setFanSpeed.push([deviceId, value]);
    },
    async setSilentMode(deviceId, value) {
      calls.setSilentMode.push([deviceId, value]);
    },
    async setSwingMode(deviceId, value) {
      calls.setSwingMode.push([deviceId, value]);
    },
  };
}

function createPlatformFixture(device) {
  const api = createFakeAPI();
  const log = createFakeLogger();
  const platform = {
    api,
    log,
    Service: api.hap.Service,
    Characteristic: api.hap.Characteristic,
  };
  const accessory = new api.platformAccessory(device.name, api.hap.uuid.generate(device.id));
  const client = createClientSpy();

  const handler = new DelonghiComfortAccessory(platform, accessory, device, client);
  const service = accessory.getService(api.hap.Service.HeaterCooler);

  return { api, log, platform, accessory, client, handler, service };
}

test('accessory exposes cool-mode heater/cooler state and fan speed mappings', async () => {
  const device = {
    id: 'device-1',
    name: 'Bedroom',
    power: true,
    mode: 'cool',
    roomTemperature: 26,
    targetTemperature: 23,
    fanSpeed: 'medium',
  };

  const { api, service } = createPlatformFixture(device);
  const { Characteristic } = api.hap;

  assert.equal(
    await service.getCharacteristic(Characteristic.Active).invokeGet(),
    Characteristic.Active.ACTIVE,
  );
  assert.equal(
    await service.getCharacteristic(Characteristic.CurrentHeaterCoolerState).invokeGet(),
    Characteristic.CurrentHeaterCoolerState.COOLING,
  );
  assert.equal(
    await service.getCharacteristic(Characteristic.TargetHeaterCoolerState).invokeGet(),
    Characteristic.TargetHeaterCoolerState.COOL,
  );
  assert.equal(
    await service.getCharacteristic(Characteristic.CoolingThresholdTemperature).invokeGet(),
    23,
  );
  assert.equal(
    await service.getCharacteristic(Characteristic.HeatingThresholdTemperature).invokeGet(),
    18,
  );
  assert.equal(
    await service.getCharacteristic(Characteristic.RotationSpeed).invokeGet(),
    66,
  );
  assert.equal(service.getCharacteristic(Characteristic.CoolingThresholdTemperature).props.minValue, 18);
  assert.equal(service.getCharacteristic(Characteristic.CoolingThresholdTemperature).props.maxValue, 32);
});

test('accessory rolls back Active when the cloud rejects a power command', async () => {
  const device = {
    id: 'device-1',
    name: 'Bedroom',
    power: true,
    mode: 'cool',
    roomTemperature: 26,
    targetTemperature: 23,
    fanSpeed: 'medium',
  };
  const { api, log, client, service } = createPlatformFixture(device);
  const { Characteristic } = api.hap;
  client.setPower = async () => {
    throw new Error('device is Offline');
  };

  await service.getCharacteristic(Characteristic.Active)
    .invokeSet(Characteristic.Active.INACTIVE);

  assert.equal(
    await service.getCharacteristic(Characteristic.Active).invokeGet(),
    Characteristic.Active.ACTIVE,
  );
  assert.equal(service.getCharacteristic(Characteristic.Active).value, Characteristic.Active.ACTIVE);
  assert.match(log.entries.warn[0], /device is Offline/);
});

test('accessory switches into eco presentation and locks thresholds when AUTO is selected', async () => {
  const device = {
    id: 'device-1',
    name: 'Bedroom',
    power: true,
    mode: 'cool',
    roomTemperature: 25,
    targetTemperature: 22,
    fanSpeed: 'low',
  };

  const { api, client, service } = createPlatformFixture(device);
  const { Characteristic } = api.hap;

  await service.getCharacteristic(Characteristic.TargetHeaterCoolerState)
    .invokeSet(Characteristic.TargetHeaterCoolerState.AUTO);

  assert.deepEqual(client.calls.setMode, [['device-1', 'eco']]);
  assert.equal(
    await service.getCharacteristic(Characteristic.CoolingThresholdTemperature).invokeGet(),
    24,
  );
  assert.equal(
    await service.getCharacteristic(Characteristic.HeatingThresholdTemperature).invokeGet(),
    20,
  );
  assert.deepEqual(
    service.getCharacteristic(Characteristic.CoolingThresholdTemperature).props.perms,
    [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY],
  );
});

test('accessory clamps cooling threshold writes and forwards them to the client', async () => {
  const device = {
    id: 'device-1',
    name: 'Bedroom',
    power: true,
    mode: 'cool',
    roomTemperature: 24,
    targetTemperature: 21,
    fanSpeed: 'high',
  };

  const { api, client, service } = createPlatformFixture(device);
  const { Characteristic } = api.hap;

  await service.getCharacteristic(Characteristic.CoolingThresholdTemperature).invokeSet(17.2);

  assert.deepEqual(client.calls.setTargetTemperature, [['device-1', 18]]);
  assert.equal(
    await service.getCharacteristic(Characteristic.CoolingThresholdTemperature).invokeGet(),
    18,
  );
});

test('accessory update refreshes eco-mode values and rotation speed from cloud state', () => {
  const device = {
    id: 'device-1',
    name: 'Bedroom',
    power: true,
    mode: 'cool',
    roomTemperature: 24,
    targetTemperature: 21,
    fanSpeed: 'low',
  };

  const { api, handler, service } = createPlatformFixture(device);
  const { Characteristic } = api.hap;

  handler.update({
    ...device,
    mode: 'eco',
    roomTemperature: 27,
    targetTemperature: 28,
    fanSpeed: 'max',
  });

  assert.equal(service.getCharacteristic(Characteristic.TargetHeaterCoolerState).value, Characteristic.TargetHeaterCoolerState.AUTO);
  assert.equal(service.getCharacteristic(Characteristic.CurrentTemperature).value, 27);
  assert.equal(service.getCharacteristic(Characteristic.CoolingThresholdTemperature).value, 24);
  assert.equal(service.getCharacteristic(Characteristic.HeatingThresholdTemperature).value, 20);
  assert.equal(service.getCharacteristic(Characteristic.RotationSpeed).value, 100);
});

test('EL110 exposes its truthful range, humidity, silent mode, and swing controls', async () => {
  const device = {
    id: 'device-1',
    name: 'Air Con',
    model: 'EL110',
    firmwareVersion: '2.0',
    minimumTargetTemperature: 19,
    power: true,
    mode: 'cool',
    roomTemperature: 31,
    targetTemperature: 19,
    humidity: 43,
    fanSpeed: 'high',
    silentMode: false,
    swingMode: true,
  };

  const { api, accessory, client, service } = createPlatformFixture(device);
  const { Characteristic, Service } = api.hap;

  assert.equal(service.getCharacteristic(Characteristic.CoolingThresholdTemperature).props.minValue, 19);
  assert.equal(
    accessory.getService(Service.AccessoryInformation).getCharacteristic(Characteristic.Model).value,
    'EL110',
  );
  assert.equal(
    await accessory.getService(Service.HumiditySensor)
      .getCharacteristic(Characteristic.CurrentRelativeHumidity).invokeGet(),
    43,
  );

  const silent = accessory.getServiceById(Service.Switch, 'silent-mode');
  const swing = accessory.getServiceById(Service.Switch, 'swing-mode');
  await silent.getCharacteristic(Characteristic.On).invokeSet(true);
  await swing.getCharacteristic(Characteristic.On).invokeSet(false);

  assert.deepEqual(client.calls.setSilentMode, [['device-1', true]]);
  assert.deepEqual(client.calls.setSwingMode, [['device-1', false]]);
});
