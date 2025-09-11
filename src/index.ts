import { API } from 'homebridge';
import { DelonghiComfortPlatform } from './platform/platform';

export = (api: API) => {
  api.registerPlatform('DelonghiComfortPlatform', DelonghiComfortPlatform);
};
