import axios, { AxiosInstance } from 'axios';
import type { Logger } from 'homebridge';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import {
  API_KEY,
  CLIENT_ID,
  AUTHORIZATION_HEADER,
  APP_ID,
  APP_SECRET,
  BROWSER_USER_AGENT,
  TOKEN_USER_AGENT,
  API_USER_AGENT,
  SDK_BUILD,
  NAME_TO_FAN_SPEED,
  FAN_SPEED_TO_NAME,
} from './constants';

export interface DelonghiClientOptions {
  username: string;
  password: string;
  language: string; // e.g., 'en-GB'
  logger?: Logger;
}

export interface DelonghiDeviceSummary {
  id: string;
  name: string;
  model?: string;
  firmwareVersion?: string;
  minimumTargetTemperature?: number;
  roomTemperature?: number;
  targetTemperature?: number;
  humidity?: number;
  power?: boolean;
  mode?: 'cool' | 'dry' | 'fan' | 'eco' | 'off';
  fanSpeed?: string;
  silentMode?: boolean;
  swingMode?: boolean;
}

export class DelonghiClient {
  private readonly http: AxiosInstance;
  private authToken?: string;
  private readonly log?: Logger;
  private useMock: boolean;
  private devicesCache: DelonghiDeviceSummary[] = [];
  private refreshToken?: string;
  private sessionRequest?: Promise<void>;

  constructor(private readonly options: DelonghiClientOptions) {
    this.log = options.logger;
    const jar = new CookieJar();
    this.http = wrapper(axios.create({
      baseURL: 'https://ads-eu.aylanetworks.com/',
      timeout: 20000,
      withCredentials: true,
      jar,
      headers: {
        'Accept': 'application/json',
      },
    } as any));
    this.useMock = process.env.DELONGHI_COMFORT_MOCK === '1';
    if (this.useMock) {
      this.devicesCache = [
        {
          id: 'mock-1',
          name: "De'Longhi PAC (Mock)",
          roomTemperature: 23,
          targetTemperature: 22,
          humidity: 48,
          power: true,
          mode: 'cool',
          fanSpeed: 'medium',
        },
      ];
      this.log?.warn('DelonghiClient running in MOCK mode. Set DELONGHI_COMFORT_MOCK=0 to disable.');
    }
  }

  async login(): Promise<void> {
    if (this.useMock) {
      this.authToken = 'mock-token';
      return;
    }
    if (!this.sessionRequest) {
      this.sessionRequest = this.renewAccessToken().then(token => {
        this.authToken = token;
      }).finally(() => {
        this.sessionRequest = undefined;
      });
    }
    await this.sessionRequest;
  }

  private async renewAccessToken(): Promise<string> {
    if (this.refreshToken) {
      try {
        const { data } = await this.http.post(
          'https://user-field-eu.aylanetworks.com/users/refresh_token.json',
          { user: { refresh_token: this.refreshToken } },
          { headers: { 'User-Agent': TOKEN_USER_AGENT }, maxRedirects: 0 },
        );
        const accessToken: unknown = data?.access_token;
        if (typeof accessToken !== 'string' || !accessToken) {
          throw new Error('Ayla refresh did not return an access token');
        }
        if (typeof data.refresh_token === 'string' && data.refresh_token) {
          this.refreshToken = data.refresh_token;
        }
        return accessToken;
      } catch (error) {
        const status = axios.isAxiosError(error) ? error.response?.status : undefined;
        if (status !== 400 && status !== 401 && status !== 403) {
          throw error;
        }
        this.refreshToken = undefined;
        this.log?.debug('Ayla rejected the refresh token. Signing in again.');
      }
    }
    return this.performAuthFlow();
  }

  async listDevices(): Promise<DelonghiDeviceSummary[]> {
    if (this.useMock) {
      // Simulate slight temp drift
      this.devicesCache = this.devicesCache.map(d => ({
        ...d,
        roomTemperature: Math.max(16, Math.min(35, (d.roomTemperature ?? 22) + (Math.random() * 0.4 - 0.2))),
      }));
      return this.devicesCache;
    }
    const data = await this.getDeviceData('apiv1/devices.json');
    const devices = Array.isArray(data) ? data : [];
    // Fetch key properties per device
    const summaries: DelonghiDeviceSummary[] = [];
    for (const item of devices) {
      const device = item?.device || {};
      const dsn: string = device.dsn;
      const name: string = device.product_name || device.product_class || 'De\'Longhi PAC';
      const props = await this.getDeviceProperties(dsn);
      // (debug removed)
      const getVal = (key: string) => {
        const p = props.find((x: any) => x?.property?.name === key);
        return p?.property?.value;
      };
      const status = getVal('get_device_status'); // 1 ON, 2 OFF
      const mode = getVal('get_device_mode'); // 1 cool, 2 dry, 3 fan, 5 eco
      const fan = getVal('get_int_fan_speed'); // 1..4
      const silent = this.detectSilent(props);
      const roomTemp = getVal('room_temp');
      const targetTemp = getVal('temp_setpoint');
      const model = getVal('appliance_model');
      summaries.push({
        id: dsn,
        name,
        model: typeof model === 'string' ? model : undefined,
        firmwareVersion: getVal('firmware_version')?.toString(),
        minimumTargetTemperature: model === 'EL110' ? 19 : 18,
        roomTemperature: typeof roomTemp === 'number' ? roomTemp : undefined,
        targetTemperature: typeof targetTemp === 'number' ? targetTemp : undefined,
        humidity: getVal('room_hum'),
        power: status === 1,
        mode: mode === 1 ? 'cool' : mode === 2 ? 'dry' : mode === 3 ? 'fan' : mode === 5 ? 'eco' : 'off',
        fanSpeed: FAN_SPEED_TO_NAME[fan || 4] || 'auto',
        silentMode: silent?.enabled,
        swingMode: this.toBoolean(getVal('get_swing_function')),
      });
    }
    this.devicesCache = summaries;
    return summaries;
  }

  async setPower(deviceId: string, on: boolean): Promise<void> {
    this.log?.debug(`setPower ${deviceId} => ${on}`);
    if (this.useMock) {
      this.updateCache(deviceId, { power: on, mode: on ? this.getDevice(deviceId)?.mode ?? 'cool' : 'off' });
      return;
    }
    const status = on ? 1 : 2;
    await this.postProperty(deviceId, 'set_device_status', String(status));
  }

  async setTargetTemperature(deviceId: string, temperatureC: number): Promise<void> {
    this.log?.debug(`setTargetTemperature ${deviceId} => ${temperatureC}`);
    const minimum = this.getDevice(deviceId)?.minimumTargetTemperature ?? 18;
    if (this.useMock) {
      const t = Math.round(Math.max(minimum, Math.min(32, temperatureC)));
      this.updateCache(deviceId, { targetTemperature: t });
      return;
    }
    const t = Math.max(minimum, Math.min(32, Number(temperatureC)));
    await this.postProperty(deviceId, 'set_temp_setpoint', t);
  }

  async setMode(deviceId: string, mode: DelonghiDeviceSummary['mode']): Promise<void> {
    this.log?.debug(`setMode ${deviceId} => ${mode}`);
    if (this.useMock) {
      const power = mode !== 'off';
      this.updateCache(deviceId, { mode, power });
      return;
    }
    if (mode === 'off') {
      await this.setPower(deviceId, false);
      return;
    }
    // Ensure device is on
    await this.setPower(deviceId, true);
    const map: Record<string, number> = { cool: 1, dry: 2, fan: 3, eco: 5 };
    const val = map[mode || 'cool'] || 1;
    await this.postProperty(deviceId, 'set_device_mode', val);
  }

  async setFanSpeed(deviceId: string, speed: string): Promise<void> {
    this.log?.debug(`setFanSpeed ${deviceId} => ${speed}`);
    if (this.useMock) {
      const allowed = ['low', 'medium', 'high', 'max', 'turbo', 'auto'];
      const v = allowed.includes(speed) ? speed : 'low';
      this.updateCache(deviceId, { fanSpeed: v });
      return;
    }
    const num = NAME_TO_FAN_SPEED[(speed || 'auto').toLowerCase()] || 4;
    await this.postProperty(deviceId, 'set_int_fan_speed', String(num));
  }

  private async getDeviceProperties(dsn: string): Promise<any[]> {
    const data = await this.getDeviceData(`apiv1/dsns/${dsn}/properties.json`);
    return Array.isArray(data) ? data : [];
  }

  private async getDeviceData(url: string): Promise<unknown> {
    if (!this.authToken || this.sessionRequest) {
      await this.login();
    }
    const attempts = 2;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const token = this.authToken;
      try {
        const { data } = await this.http.get<unknown>(url, {
          headers: { 'User-Agent': API_USER_AGENT, 'Authorization': `auth_token ${token}` },
        });
        return data;
      } catch (error) {
        if (attempt === attempts || !axios.isAxiosError(error)) {
          throw error;
        }
        const status = error.response?.status;
        if (status === 401) {
          // A concurrent request may already have renewed the rejected token.
          if (this.authToken === token || this.sessionRequest) {
            await this.login();
          }
          continue;
        }
        const retryable = error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' ||
          status === 408 || status === 429 || (status !== undefined && status >= 500);
        if (!retryable) {
          throw error;
        }
        const delayMs = status === 429 ? 5000 : 1500;
        this.log?.warn(`De'Longhi GET ${url} failed (${error.message}); retrying once in ${delayMs}ms`);
        await this.delay(delayMs);
      }
    }
    throw new Error(`De'Longhi GET ${url} failed`);
  }

  private async delay(milliseconds: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, milliseconds));
  }

  private async assertDeviceOnline(dsn: string): Promise<void> {
    const data = await this.getDeviceData('apiv1/devices.json');
    const item = Array.isArray(data)
      ? data.find(candidate => candidate?.device?.dsn === dsn)
      : undefined;
    if (!item?.device) {
      throw new Error(`De'Longhi device ${dsn} was not found`);
    }
    const status = String(item.device.connection_status || 'unknown');
    if (status.toLowerCase() !== 'online') {
      throw new Error(`De'Longhi device ${dsn} is ${status}; refusing to queue a cloud command`);
    }
  }

  private async postProperty(dsn: string, prop: string, value: any): Promise<void> {
    await this.assertDeviceOnline(dsn);
    const headers = {
      'User-Agent': API_USER_AGENT,
      'Authorization': `auth_token ${this.authToken}`,
      'Content-Type': 'application/json',
    };
    await this.http.post(`apiv1/dsns/${dsn}/properties/${prop}/datapoints.json`, { datapoint: { value } }, { headers });
  }

  // (eco toggle/offset helpers removed; eco is handled via device mode 5)

  private detectSilent(props: any[]): { enabled?: boolean, setName?: string } | undefined {
    try {
      const names = props.map(p => p?.property?.name as string).filter(Boolean);
      const findGet = names.find(n => /get_.*silent/i.test(n));
      const findSet = names.find(n => /set_.*silent/i.test(n));
      if (!findGet && !findSet) return undefined;
      const getVal = (key: string) => {
        const p = props.find((x: any) => x?.property?.name === key);
        return p?.property?.value;
      };
      const getName = findGet || (findSet ? findSet.replace(/^set_/, 'get_') : undefined);
      const raw = getName ? getVal(getName) : undefined;
      const enabled = raw === 1 || raw === '1' || raw === true;
      return { enabled, setName: findSet };
    } catch {
      return undefined;
    }
  }

  async getSilentModeState(deviceId: string): Promise<boolean | undefined> {
    if (this.useMock) {
      return this.getDevice(deviceId)?.silentMode ?? false;
    }
    const props = await this.getDeviceProperties(deviceId);
    const silent = this.detectSilent(props);
    return silent?.enabled;
  }

  async setSilentMode(deviceId: string, enabled: boolean, explicitPropertyName?: string): Promise<void> {
    this.log?.debug(`setSilentMode ${deviceId} => ${enabled}`);
    if (this.useMock) {
      this.updateCache(deviceId, { silentMode: enabled });
      return;
    }
    const props = await this.getDeviceProperties(deviceId);
    let setName = explicitPropertyName;
    if (!setName) {
      const detected = this.detectSilent(props);
      setName = detected?.setName;
    }
    if (!setName) {
      // fallback to known property name from HA integration
      setName = 'set_silent_function';
    }
    // Ayla boolean properties use 1=ON, 0=OFF.
    await this.postProperty(deviceId, setName, enabled ? 1 : 0);
  }

  async setSwingMode(deviceId: string, enabled: boolean): Promise<void> {
    this.log?.debug(`setSwingMode ${deviceId} => ${enabled}`);
    if (this.useMock) {
      this.updateCache(deviceId, { swingMode: enabled });
      return;
    }
    await this.postProperty(deviceId, 'set_swing_function', enabled ? 1 : 0);
  }

  private toBoolean(value: unknown): boolean | undefined {
    if (value === undefined || value === null) return undefined;
    return value === 1 || value === '1' || value === true;
  }

  private async performAuthFlow(): Promise<string> {
    let phase = 'start';
    try {
      const browserHeaders = { 'User-Agent': BROWSER_USER_AGENT } as Record<string, string>;
      const langRaw = (this.options.language || 'en').toString().trim().toLowerCase();
      const lang = langRaw === 'en-gb' ? 'en' : langRaw;
      // 1) authorize to get context
      phase = 'authorize';
      const authorize = await axios.get(`https://fidm.eu1.gigya.com/oidc/op/v1.0/${API_KEY}/authorize`, {
        headers: browserHeaders,
        maxRedirects: 0,
        validateStatus: s => s >= 200 && s < 400,
        params: {
          client_id: CLIENT_ID,
          response_type: 'code',
          redirect_uri: 'https://google.it',
          scope: 'openid email profile UID comfort en alexa',
          nonce: String(Math.floor(Date.now() / 1000)),
        },
      });
      const location = authorize.headers['location'] as string;
      const context = new URL(location).searchParams.get('context') as string;

      // 2) getIDs
      phase = 'getIDs';
      const idsResp = await axios.get('https://socialize.eu1.gigya.com/socialize.getIDs', {
        headers: browserHeaders,
        params: {
          APIKey: API_KEY,
          includeTicket: 'true',
          pageURL: 'https://aylaopenid.delonghigroup.com/',
          sdk: 'js_latest',
          sdkBuild: String(SDK_BUILD),
          format: 'json',
        },
      });
      const ids = idsResp.data;
      const ucid = ids['ucid'];
      const gmid = ids['gmid'];
      const gmidTicket = ids['gmidTicket'];

      // 3) login
      phase = 'login';
      const riskContext = encodeURIComponent(JSON.stringify({ b6: BROWSER_USER_AGENT }));
      const loginResp = await axios.post('https://accounts.eu1.gigya.com/accounts.login', new URLSearchParams({
        loginID: this.options.username,
        password: this.options.password,
        sessionExpiration: String(7884009),
        targetEnv: 'jssdk',
        include: 'profile,data,emails,subscriptions,preferences',
        includeUserInfo: 'true',
        loginMode: 'standard',
        lang: lang,
        riskContext: riskContext,
        APIKey: API_KEY,
        source: 'showScreenSet',
        sdk: 'js_latest',
        authMode: 'cookie',
        pageURL: 'https://aylaopenid.delonghigroup.com/',
        gmid,
        ucid,
        sdkBuild: String(SDK_BUILD),
        format: 'json',
      }), { headers: { ...browserHeaders, 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (loginResp.data?.statusCode !== 200) {
        throw new Error('Login failed: ' + (loginResp.data?.errorDetails || 'Unknown'));
      }
      const loginToken = loginResp.data?.sessionInfo?.login_token as string;

      // 4) user info
      phase = 'getUserInfo';
      const userInfo = await axios.post('https://socialize.eu1.gigya.com/socialize.getUserInfo', new URLSearchParams({
        enabledProviders: '*',
        APIKey: API_KEY,
        sdk: 'js_latest',
        login_token: loginToken,
        authMode: 'cookie',
        pageURL: 'https://aylaopenid.delonghigroup.com/',
        gmid,
        ucid,
        sdkBuild: String(SDK_BUILD),
        format: 'json',
      }), { headers: { ...browserHeaders, 'Content-Type': 'application/x-www-form-urlencoded' } });
      const UID = userInfo.data?.UID as string;
      const UIDSignature = userInfo.data?.UIDSignature as string;
      const signatureTimestamp = userInfo.data?.signatureTimestamp as string;

      // 5) consent page
      phase = 'consentPage';
      const consentPage = await axios.get('https://aylaopenid.delonghigroup.com/OIDCConsentPage.php', {
        headers: browserHeaders,
        params: {
          lang: lang,
          context,
          clientID: CLIENT_ID,
          scope: 'openid+email+profile+UID+comfort+en+alexa',
          UID,
          UIDSignature,
          signatureTimestamp,
        },
      });
      const consentText: string = String(consentPage.data);
      // The consent page uses either JavaScript quote style for this signature.
      const signatureMatch = consentText.match(/\bconst\s+consentObj2Sig\s*=\s*(['"])(.*?)\1/);
      if (!signatureMatch?.[2]) {
        throw new Error('Consent page did not include a signature');
      }
      const signature = signatureMatch[2];

      // 6) authorize continue to get code
      phase = 'authorizeContinue';
      const continueResp = await axios.get(`https://fidm.eu1.gigya.com/oidc/op/v1.0/${API_KEY}/authorize/continue`, {
        headers: browserHeaders,
        params: {
          context,
          login_token: loginToken,
          consent: JSON.stringify({
            scope: 'openid email profile UID comfort en alexa',
            clientID: CLIENT_ID,
            context,
            UID,
            consent: true,
          }),
          sig: signature,
          gmidTicket: gmidTicket,
        },
        maxRedirects: 0,
        validateStatus: s => s >= 200 && s < 400,
      });
      const loc2 = continueResp.headers['location'] as string;
      const code = new URL(loc2).searchParams.get('code') as string;

      // 7) token
      phase = 'token';
      const tokenResp = await axios.post(`https://fidm.eu1.gigya.com/oidc/op/v1.0/${API_KEY}/token`, new URLSearchParams({
        code,
        grant_type: 'authorization_code',
        redirect_uri: 'https://google.it',
      }), {
        headers: {
          'User-Agent': TOKEN_USER_AGENT,
          'Authorization': AUTHORIZATION_HEADER,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });
      const idpAccessToken = tokenResp.data?.access_token as string;

      // 8) token_sign_in
      phase = 'token_sign_in';
      const signInResp = await axios.post('https://user-field-eu.aylanetworks.com/api/v1/token_sign_in', new URLSearchParams({
        app_id: APP_ID,
        app_secret: APP_SECRET,
        token: idpAccessToken,
      }), { headers: { 'User-Agent': TOKEN_USER_AGENT, 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' } });
      const accessToken: unknown = signInResp.data?.access_token;
      if (typeof accessToken !== 'string' || !accessToken) {
        throw new Error('Ayla sign-in did not return an access token');
      }
      const refreshToken: unknown = signInResp.data.refresh_token;
      this.refreshToken = typeof refreshToken === 'string' && refreshToken ? refreshToken : undefined;
      return accessToken;
    } catch (err: any) {
      const msg = err?.response?.status ? `${err.response.status} ${err.response.statusText}` : (err?.message || String(err));
      this.log?.error(`Auth flow failed at phase: ${phase} -> ${msg}`);
      throw err;
    }
  }

  private getDevice(deviceId: string): DelonghiDeviceSummary | undefined {
    return this.devicesCache.find(d => d.id === deviceId);
  }

  private updateCache(deviceId: string, patch: Partial<DelonghiDeviceSummary>) {
    this.devicesCache = this.devicesCache.map(d => (d.id === deviceId ? { ...d, ...patch } : d));
  }
}
