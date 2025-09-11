// Ported constants from the Home Assistant integration (Apache-2.0)
// Source: philm5/delonghi-comfort-integration custom_components/delonghi_comfort/const.py

export const SDK_BUILD = 16650;

export const API_KEY = "3_e5qn7USZK-QtsIso1wCelqUKAK_IVEsYshRIssQ-X-k55haiZXmKWDHDRul2e5Y2";
export const CLIENT_ID = "1S8q1WJEs-emOB43Z0-66WnL";
export const CLIENT_SECRET = "lmnceiD0B-4KPNN5ZS6WuWU70j9V5BCuSlz2OPsvHkyLryhMkJkPvKsivfTq3RfNYj8GpCELtOBvhaDIzKcBtg";
export const AUTHORIZATION_HEADER =
  "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
export const APP_ID = "DeLonghiComfort2-mw-id";
export const APP_SECRET = "DeLonghiComfort2-Yg4miiqiNcf0Or-EhJwRh7ACfBY";

export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 13_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/79.0.3945.73 Mobile/15E148 Safari/604.1";
export const TOKEN_USER_AGENT = "DeLonghiComfort/3 CFNetwork/1568.300.101 Darwin/24.2.0";
export const API_USER_AGENT = "DeLonghiComfort/5.1.1 (iPhone; iOS 18.2; Scale/3.00)";

export const DEVICE_MODE_TO_HVAC: Record<number, string> = {
  1: "cool",
  2: "dry",
  3: "fan",
};

export const FAN_SPEED_TO_NAME: Record<number, string> = {
  1: "low",
  2: "medium",
  3: "high",
  4: "auto",
};

export const NAME_TO_FAN_SPEED: Record<string, number> = {
  low: 1,
  mid: 2,
  medium: 2,
  high: 3,
  auto: 4,
  max: 3,
  turbo: 3,
};



