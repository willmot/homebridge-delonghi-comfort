'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AxiosError } = require('axios');

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

test('EL110 target temperature is clamped to its effective 19 degree minimum', async () => {
  const client = new DelonghiClient({
    username: 'user@example.com',
    password: 'secret',
    language: 'en-GB',
  });
  const writes = [];
  client.devicesCache = [{ id: 'device-1', name: 'Air Con', minimumTargetTemperature: 19 }];
  client.postProperty = async (deviceId, propertyName, value) => {
    writes.push({ deviceId, propertyName, value });
  };

  await client.setTargetTemperature('device-1', 18);

  assert.deepEqual(writes, [{
    deviceId: 'device-1',
    propertyName: 'set_temp_setpoint',
    value: 19,
  }]);
});

test('read-only cloud requests retry once after a timeout', async () => {
  const client = clientWithExpiredSession();
  let attempts = 0;
  client.http.get = async () => {
    attempts++;
    if (attempts === 1) throw new AxiosError('timeout', 'ECONNABORTED');
    return { data: [] };
  };
  client.delay = async () => {};

  assert.deepEqual(await client.listDevices(), []);
  assert.equal(attempts, 2);
});

function httpError(status) {
  return new AxiosError('HTTP ' + status, undefined, undefined, undefined, { status });
}

function clientWithExpiredSession() {
  const client = new DelonghiClient({
    username: 'user@example.com', password: 'secret', language: 'en-GB',
  });
  client.authToken = 'expired-token';
  client.refreshToken = 'refresh-token';
  return client;
}

test('concurrent device and property reads share one Ayla refresh and retry with the new token', async () => {
  const client = clientWithExpiredSession();
  const reads = [];
  const refreshes = [];
  client.http.get = async (url, { headers }) => {
    reads.push([url, headers.Authorization]);
    if (headers.Authorization === 'auth_token expired-token') throw httpError(401);
    return { data: [] };
  };
  client.http.post = async (url, body) => {
    refreshes.push({ url, body });
    return { data: { access_token: 'renewed-token', refresh_token: 'rotated-refresh-token' } };
  };
  client.performAuthFlow = async () => assert.fail('Unexpected full sign-in');

  await Promise.all([client.listDevices(), client.getSilentModeState('device-1')]);

  assert.deepEqual(refreshes, [{
    url: 'https://user-field-eu.aylanetworks.com/users/refresh_token.json',
    body: { user: { refresh_token: 'refresh-token' } },
  }]);
  assert.equal(client.refreshToken, 'rotated-refresh-token');
  assert.deepEqual(reads, [
    ['apiv1/devices.json', 'auth_token expired-token'],
    ['apiv1/dsns/device-1/properties.json', 'auth_token expired-token'],
    ['apiv1/devices.json', 'auth_token renewed-token'],
    ['apiv1/dsns/device-1/properties.json', 'auth_token renewed-token'],
  ]);
});

test('a rejected refresh token falls back to a single sign-in and read retry', async () => {
  const client = clientWithExpiredSession();
  const authorizationHeaders = [];
  client.http.get = async (_url, { headers }) => {
    authorizationHeaders.push(headers.Authorization);
    throw httpError(401);
  };
  let refreshes = 0;
  client.http.post = async () => {
    refreshes++;
    throw httpError(401);
  };
  let logins = 0;
  client.performAuthFlow = async () => {
    logins++;
    return 'signed-in-token';
  };

  await assert.rejects(client.listDevices(), /HTTP 401/);

  assert.equal(refreshes, 1);
  assert.equal(logins, 1);
  assert.deepEqual(authorizationHeaders, [
    'auth_token expired-token',
    'auth_token signed-in-token',
  ]);
});

test('a transient refresh failure leaves the refresh token usable for the next poll', async () => {
  const client = clientWithExpiredSession();
  client.http.get = async (_url, { headers }) => {
    if (headers.Authorization === 'auth_token expired-token') throw httpError(401);
    return { data: [] };
  };
  client.http.post = async () => { throw httpError(503); };
  client.performAuthFlow = async () => assert.fail('Unexpected full sign-in');

  await assert.rejects(client.listDevices(), /HTTP 503/);
  assert.equal(client.refreshToken, 'refresh-token');

  client.http.post = async () => ({ data: { access_token: 'renewed-token' } });
  assert.deepEqual(await client.listDevices(), []);
  assert.equal(client.refreshToken, 'refresh-token');
});

test('control writes reject offline devices instead of queueing commands', async () => {
  const client = new DelonghiClient({
    username: 'user@example.com',
    password: 'secret',
    language: 'en-GB',
  });
  let posts = 0;

  client.authToken = 'token';
  client.http.get = async () => ({
    data: [{ device: { dsn: 'device-1', connection_status: 'Offline' } }],
  });
  client.http.post = async () => {
    posts++;
  };

  await assert.rejects(
    client.setPower('device-1', false),
    /device-1 is Offline; refusing to queue a cloud command/,
  );
  assert.equal(posts, 0);
});

test('a rejected appliance command is never replayed', async () => {
  const client = clientWithExpiredSession();
  client.http.get = async () => ({
    data: [{ device: { dsn: 'device-1', connection_status: 'Online' } }],
  });
  const requestedUrls = [];
  client.http.post = async (url) => {
    requestedUrls.push(url);
    throw httpError(401);
  };

  await assert.rejects(client.setPower('device-1', false), /HTTP 401/);
  assert.deepEqual(requestedUrls, ['apiv1/dsns/device-1/properties/set_device_status/datapoints.json']);
});

function mockAuthResponses(t, consentPage) {
  const axios = require('axios').default;
  const continuedSignatures = [];
  t.mock.method(axios, 'get', async (url, config) => {
    if (url.endsWith('/authorize')) {
      return { headers: { location: 'https://example.com/?context=test-context' } };
    }
    if (url.endsWith('/socialize.getIDs')) {
      return { data: { ucid: 'test-ucid', gmid: 'test-gmid', gmidTicket: 'test-ticket' } };
    }
    if (url.endsWith('/OIDCConsentPage.php')) {
      return { data: consentPage };
    }
    assert.ok(url.endsWith('/authorize/continue'), `Unexpected auth GET: ${url}`);
    continuedSignatures.push(config.params.sig);
    return { headers: { location: 'https://example.com/?code=test-code' } };
  });
  t.mock.method(axios, 'post', async (url) => {
    if (url.endsWith('/accounts.login')) {
      return { data: { statusCode: 200, sessionInfo: { login_token: 'test-login-token' } } };
    }
    if (url.endsWith('/socialize.getUserInfo')) {
      return { data: { UID: 'test-user', UIDSignature: 'test-signature', signatureTimestamp: '1' } };
    }
    assert.ok(url.endsWith('/token') || url.endsWith('/token_sign_in'), `Unexpected auth POST: ${url}`);
    return { data: { access_token: 'test-access-token', refresh_token: 'test-refresh-token' } };
  });
  return continuedSignatures;
}

for (const quote of ["'", '"']) {
  test(`cloud login accepts a consent signature wrapped in ${quote}`, async (t) => {
    const signatures = mockAuthResponses(t, `const consentObj2Sig = ${quote}test-consent-signature${quote};`);
    const client = new DelonghiClient({ username: 'user@example.com', password: 'secret', language: 'en-GB' });

    await client.login();

    assert.deepEqual(signatures, ['test-consent-signature']);
    assert.equal(client.authToken, 'test-access-token');
  });
}

test('cloud login stops before authorization if the consent signature is missing', async (t) => {
  const signatures = mockAuthResponses(t, '<html>Service unavailable</html>');
  const client = new DelonghiClient({ username: 'user@example.com', password: 'secret', language: 'en-GB' });

  await assert.rejects(client.login(), /Consent page did not include a signature/);

  assert.deepEqual(signatures, []);
});
