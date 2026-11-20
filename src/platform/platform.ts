import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';
import { DelonghiComfortAccessory } from '../accessories/DelonghiComfortAccessory';
import { DelonghiClient, DelonghiDeviceSummary } from '../api/client';

export class DelonghiComfortPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;
  private readonly accessories: Map<string, PlatformAccessory> = new Map();
  private readonly handlers: Map<string, DelonghiComfortAccessory> = new Map();
  public client!: DelonghiClient;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    if (!config) {
      this.log.warn('No configuration found for DelonghiComfortPlatform');
      return;
    }

    this.api.on('didFinishLaunching', async () => {
      try {
        const username = String(config.username || '');
        const password = String(config.password || '');
        const language = String(config.language || 'en-GB');
        const requestedScanInterval = Number(config.scanInterval || 60);
        const scanInterval = Number.isFinite(requestedScanInterval)
          ? Math.max(30, requestedScanInterval)
          : 60;

        if (!username || !password) {
          this.log.error('Missing username/password in config');
          return;
        }

        this.client = new DelonghiClient({ username, password, language, logger: this.log });
        await this.client.login();

        const devices = await this.client.listDevices();
        this.log.info(`Found ${devices.length} De'Longhi devices`);

        for (const device of devices) {
          this.registerOrUpdateAccessory(device);
        }

        // Start polling
        let pollInProgress = false;
        setInterval(async () => {
          if (pollInProgress) {
            this.log.warn('Skipping poll because the previous De\'Longhi cloud request is still running');
            return;
          }
          pollInProgress = true;
          try {
            const latest = await this.client.listDevices();
            const seen = new Set<string>();
            for (const device of latest) {
              seen.add(device.id);
              this.updateAccessory(device);
            }
            // Unregister accessories no longer present
            for (const [uuid, accessory] of this.accessories.entries()) {
              const id = accessory.context?.device?.id as string | undefined;
              if (id && !seen.has(id)) {
                this.log.info('Removing accessory for missing device: ' + accessory.displayName);
                this.api.unregisterPlatformAccessories('homebridge-delonghi-comfort', 'DelonghiComfortPlatform', [accessory]);
                this.accessories.delete(uuid);
                this.handlers.delete(uuid);
              }
            }
          } catch (err: any) {
            this.log.error('Polling error: ' + (err?.message || String(err)));
          } finally {
            pollInProgress = false;
          }
        }, scanInterval * 1000);
      } catch (err: any) {
        this.log.error('Failed to initialize platform: ' + (err?.message || String(err)));
      }
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.accessories.set(accessory.UUID, accessory);
  }

  private registerOrUpdateAccessory(device: DelonghiDeviceSummary) {
    const uuid = this.api.hap.uuid.generate(device.id);
    let accessory = this.accessories.get(uuid);

    if (!accessory) {
      accessory = new this.api.platformAccessory(device.name, uuid);
      accessory.context.device = device;
      const handler = new DelonghiComfortAccessory(this, accessory, device, this.client);
      this.handlers.set(uuid, handler);
      this.api.registerPlatformAccessories('homebridge-delonghi-comfort', 'DelonghiComfortPlatform', [accessory]);
      this.accessories.set(uuid, accessory);
      this.log.info('Registered accessory: ' + device.name);
    } else {
      accessory.context.device = device;
      let handler = this.handlers.get(uuid);
      if (!handler) {
        handler = new DelonghiComfortAccessory(this, accessory, device, this.client);
        this.handlers.set(uuid, handler);
      } else {
        handler.update(device);
      }
      this.api.updatePlatformAccessories([accessory]);
      this.log.info('Updated accessory: ' + device.name);
    }
  }

  private updateAccessory(device: DelonghiDeviceSummary) {
    const uuid = this.api.hap.uuid.generate(device.id);
    const accessory = this.accessories.get(uuid);
    if (accessory) {
      accessory.context.device = device;
      const handler = this.handlers.get(uuid);
      if (handler) {
        handler.update(device);
        this.api.updatePlatformAccessories([accessory]);
      } else {
        // First-time after restore
        const h = new DelonghiComfortAccessory(this, accessory, device, this.client);
        this.handlers.set(uuid, h);
        this.api.updatePlatformAccessories([accessory]);
      }
    } else {
      this.registerOrUpdateAccessory(device);
    }
  }
}
