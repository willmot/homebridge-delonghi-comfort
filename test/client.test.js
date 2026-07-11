'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { DelonghiClient } = require('../dist/api/client');

test('mock client updates cached device state for common control operations', async () => {
  const previous = process.env.DELONGHI_COMFORT_MOCK;
  process.env.DELONGHI_COMFORT_MOCK = '1';

  try {
    const client = new DelonghiClient({
      username: 'user@example.com',
      password: 'secret',
      language: 'en-GB',
    });

    await client.login();
    const [device] = await client.listDevices();

    assert.equal(device.mode, 'cool');
    assert.equal(device.power, true);

    await client.setTargetTemperature(device.id, 40);
    await client.setFanSpeed(device.id, 'turbo');
    await client.setMode(device.id, 'eco');

    const [updated] = await client.listDevices();

    assert.equal(updated.targetTemperature, 32);
    assert.equal(updated.fanSpeed, 'turbo');
    assert.equal(updated.mode, 'eco');
    assert.equal(updated.power, true);
  } finally {
    if (previous === undefined) {
      delete process.env.DELONGHI_COMFORT_MOCK;
    } else {
      process.env.DELONGHI_COMFORT_MOCK = previous;
    }
  }
});

test('silent mode writes Ayla boolean values as 1 and 0', async () => {
  const client = new DelonghiClient({
    username: 'user@example.com',
    password: 'secret',
    language: 'en-GB',
  });
  const writes = [];

  client.getDeviceProperties = async () => [
    {
      property: {
        name: 'get_silent_function',
        value: 1,
      },
    },
    {
      property: {
        name: 'set_silent_function',
      },
    },
  ];
  client.postProperty = async (deviceId, propertyName, value) => {
    writes.push({ deviceId, propertyName, value });
  };

  await client.setSilentMode('device-1', true);
  await client.setSilentMode('device-1', false);

  assert.deepEqual(writes, [
    {
      deviceId: 'device-1',
      propertyName: 'set_silent_function',
      value: 1,
    },
    {
      deviceId: 'device-1',
      propertyName: 'set_silent_function',
      value: 0,
    },
  ]);
});
