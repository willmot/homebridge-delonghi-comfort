import { Perms, PlatformAccessory, Service } from 'homebridge';
import { DelonghiComfortPlatform } from '../platform/platform';
import { DelonghiClient, DelonghiDeviceSummary } from '../api/client';

export class DelonghiComfortAccessory {
  private service: Service;
  private current: DelonghiDeviceSummary;
  private readonly client: DelonghiClient;
  // simplified: no fan speed controls here
  private heatThresholdC: number = 18;
  private optimisticCoolTarget?: { value: number; until: number };
  private lastCoolTargetC?: number;
  private optimisticMode?: { value: 'cool' | 'eco'; until: number };
  private thresholdWriteLockUntil?: number;
  private thresholdLockMode?: 'cool' | 'eco';
  private humidityService?: Service;
  private silentModeService?: Service;
  private swingModeService?: Service;

  private get minimumTargetTemperature(): number {
    return this.current.minimumTargetTemperature ?? 18;
  }

  private clampTargetTemperature(value: unknown): number {
    return Math.max(this.minimumTargetTemperature, Math.min(32, Math.round(Number(value))));
  }

  constructor(
    private readonly platform: DelonghiComfortPlatform,
    private readonly accessory: PlatformAccessory,
    device: DelonghiDeviceSummary,
    client: DelonghiClient,
  ) {
    this.current = device;
    this.client = client;
    const { Service, Characteristic } = platform;

    accessory.getService(platform.Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'DeLonghi')
      .setCharacteristic(Characteristic.Model, device.model || 'Comfort V2')
      .setCharacteristic(Characteristic.FirmwareRevision, device.firmwareVersion || 'unknown')
      .setCharacteristic(Characteristic.SerialNumber, device.id);

    this.service = accessory.getService(Service.HeaterCooler) || accessory.addService(Service.HeaterCooler);
    this.service.setCharacteristic(Characteristic.Name, device.name);
    // Seed last remembered cool target
    try {
      const seed = this.clampTargetTemperature(device.targetTemperature ?? 24);
      this.lastCoolTargetC = seed;
    } catch {}

    // Active (power)
    this.service.getCharacteristic(Characteristic.Active)
      .onGet(() => {
        try { return this.current?.power ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE; } catch { return Characteristic.Active.INACTIVE; }
      })
      .onSet(async (value) => {
        const on = value === Characteristic.Active.ACTIVE || value === 1 || value === true;
        const prev = !!this.current?.power;
        // Optimistic UI update
        try { this.service.updateCharacteristic(Characteristic.Active, on ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE); } catch {}
        try {
          await this.client.setPower(device.id, on);
          this.current.power = on;
        } catch (e) {
          // Roll back UI and state on failure
          try { this.service.updateCharacteristic(Characteristic.Active, prev ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE); } catch {}
          this.current.power = prev;
          try { this.platform.log.warn('Failed to set power:', (e as any)?.message || String(e)); } catch {}
        }
      });

    // Current state (heating unsupported, map dry/fan to idle)
    this.service.getCharacteristic(Characteristic.CurrentHeaterCoolerState)
      .onGet(() => {
        if (!this.current.power) return Characteristic.CurrentHeaterCoolerState.INACTIVE;
        switch (this.current.mode) {
          case 'cool': return Characteristic.CurrentHeaterCoolerState.COOLING;
          case 'eco': return Characteristic.CurrentHeaterCoolerState.COOLING;
          case 'dry': return Characteristic.CurrentHeaterCoolerState.IDLE;
          case 'fan': return Characteristic.CurrentHeaterCoolerState.IDLE;
          default: return Characteristic.CurrentHeaterCoolerState.INACTIVE;
        }
      });

    // Target state: expose COOL and AUTO (AUTO maps to Eco Real Feel)
    this.service.getCharacteristic(Characteristic.TargetHeaterCoolerState)
      .setProps({ validValues: [
        Characteristic.TargetHeaterCoolerState.COOL,
        Characteristic.TargetHeaterCoolerState.AUTO,
      ] })
      .onGet(() => {
        try { return this.current?.mode === 'eco' ? Characteristic.TargetHeaterCoolerState.AUTO : Characteristic.TargetHeaterCoolerState.COOL; } catch { return Characteristic.TargetHeaterCoolerState.COOL; }
      })
      .onSet(async (value) => {
        const prevMode = (this.current?.mode || 'cool') as 'cool' | 'eco' | 'dry' | 'fan';
        const prevCool = this.clampTargetTemperature(this.current?.targetTemperature ?? this.lastCoolTargetC ?? 24);
        try {
          if (value === Characteristic.TargetHeaterCoolerState.COOL) {
            // Immediately make thresholds editable and show latest cool setpoint
            try {
              this.optimisticMode = { value: 'cool', until: Date.now() + 5000 };
              this.thresholdWriteLockUntil = Date.now() + 1500;
              this.thresholdLockMode = 'cool';
              const RW = [Perms.PAIRED_READ, Perms.PAIRED_WRITE, Perms.EVENTS] as any;
              this.service.getCharacteristic(Characteristic.CoolingThresholdTemperature)
                .setProps({ minValue: this.minimumTargetTemperature, maxValue: 32, minStep: 1, perms: RW });
              this.service.getCharacteristic(Characteristic.HeatingThresholdTemperature)
                .setProps({ minValue: this.minimumTargetTemperature, maxValue: 32, minStep: 1, perms: RW });
              const cool = this.clampTargetTemperature(this.lastCoolTargetC ?? this.current?.targetTemperature ?? prevCool);
              const heat = Math.min(Math.max(this.minimumTargetTemperature, Math.round(this.heatThresholdC)), cool - 1);
              this.service.updateCharacteristic(Characteristic.CoolingThresholdTemperature, cool);
              this.service.updateCharacteristic(Characteristic.HeatingThresholdTemperature, heat);
              // Remember and optimistically cache
              this.current.targetTemperature = cool;
              this.lastCoolTargetC = cool;
              this.optimisticCoolTarget = { value: cool, until: Date.now() + 5000 };
            } catch {}
            await this.client.setMode(device.id, 'cool');
            try { await this.client.setTargetTemperature(device.id, this.lastCoolTargetC ?? prevCool); } catch (e) {
              // If temperature set fails after mode switched, still treat as failure for UI consistency
              throw e;
            }
            return;
          }
          if (value === Characteristic.TargetHeaterCoolerState.AUTO) {
            // Immediately make thresholds read-only and present final 20–24 band
            try {
              this.optimisticMode = { value: 'eco', until: Date.now() + 5000 };
              this.thresholdWriteLockUntil = Date.now() + 1500;
              this.thresholdLockMode = 'eco';
              // Remember current cool target before switching
              const currentCool = this.clampTargetTemperature(this.current?.targetTemperature ?? this.lastCoolTargetC ?? 24);
              this.lastCoolTargetC = currentCool;
              // First set values to the eco window
              this.service.updateCharacteristic(Characteristic.CoolingThresholdTemperature, 24);
              this.service.updateCharacteristic(Characteristic.HeatingThresholdTemperature, 20);
              // Then tighten props to strict RO 20–24
              const RO = [Perms.PAIRED_READ, Perms.EVENTS] as any;
              this.service.getCharacteristic(Characteristic.CoolingThresholdTemperature)
                .setProps({ minValue: 20, maxValue: 24, minStep: 1, perms: RO });
              this.service.getCharacteristic(Characteristic.HeatingThresholdTemperature)
                .setProps({ minValue: 20, maxValue: 24, minStep: 1, perms: RO });
            } catch {}
            await this.client.setMode(device.id, 'eco');
            return;
          }
        } catch (e) {
          // Roll back UI/state to previous mode presentation
          try {
            const wasEco = prevMode === 'eco';
            const RO = [Perms.PAIRED_READ, Perms.EVENTS] as any;
            const RW = [Perms.PAIRED_READ, Perms.PAIRED_WRITE, Perms.EVENTS] as any;
            if (wasEco) {
              // Revert to AUTO window 20–24
              this.service.getCharacteristic(Characteristic.CoolingThresholdTemperature).setProps({ minValue: 20, maxValue: 24, minStep: 1, perms: RO });
              this.service.getCharacteristic(Characteristic.HeatingThresholdTemperature).setProps({ minValue: 20, maxValue: 24, minStep: 1, perms: RO });
              this.service.updateCharacteristic(Characteristic.CoolingThresholdTemperature, 24);
              this.service.updateCharacteristic(Characteristic.HeatingThresholdTemperature, 20);
              this.service.updateCharacteristic(Characteristic.TargetHeaterCoolerState, Characteristic.TargetHeaterCoolerState.AUTO);
            } else {
              // Revert to COOL window 18–32 and previous cool target
              this.service.getCharacteristic(Characteristic.CoolingThresholdTemperature).setProps({ minValue: this.minimumTargetTemperature, maxValue: 32, minStep: 1, perms: RW });
              this.service.getCharacteristic(Characteristic.HeatingThresholdTemperature).setProps({ minValue: this.minimumTargetTemperature, maxValue: 32, minStep: 1, perms: RW });
              this.service.updateCharacteristic(Characteristic.CoolingThresholdTemperature, prevCool);
              const prevHeat = Math.max(this.minimumTargetTemperature, Math.min(32, prevCool - 1));
              this.service.updateCharacteristic(Characteristic.HeatingThresholdTemperature, prevHeat);
              this.service.updateCharacteristic(Characteristic.TargetHeaterCoolerState, Characteristic.TargetHeaterCoolerState.COOL);
            }
            // Reset optimistic state
            this.optimisticMode = undefined;
            this.optimisticCoolTarget = undefined;
          } catch {}
          try { this.platform.log.warn('Failed to set TargetHeaterCoolerState:', (e as any)?.message || String(e)); } catch {}
        }
      });

    // Room temperature
    this.service.getCharacteristic(Characteristic.CurrentTemperature)
      .onGet(() => {
        try {
          const t = Number(this.current?.roomTemperature);
          return Number.isFinite(t) ? t : 20;
        } catch { return 20; }
      });

    if (typeof device.humidity === 'number') {
      this.humidityService = accessory.getService(Service.HumiditySensor) ||
        accessory.addService(Service.HumiditySensor, `${device.name} Humidity`, 'humidity');
      this.humidityService.setCharacteristic(Characteristic.Name, `${device.name} Humidity`);
      this.humidityService.getCharacteristic(Characteristic.CurrentRelativeHumidity)
        .onGet(() => Math.max(0, Math.min(100, Number(this.current.humidity ?? 0))));
    }

    if (device.silentMode !== undefined) {
      this.silentModeService = accessory.getServiceById(Service.Switch, 'silent-mode') ||
        accessory.addService(Service.Switch, 'Silent Mode', 'silent-mode');
      this.silentModeService.setCharacteristic(Characteristic.Name, 'Silent Mode');
      this.silentModeService.getCharacteristic(Characteristic.On)
        .onGet(() => !!this.current.silentMode)
        .onSet(async value => {
          const previous = !!this.current.silentMode;
          const enabled = !!value;
          this.current.silentMode = enabled;
          try {
            await this.client.setSilentMode(device.id, enabled);
          } catch (error) {
            this.current.silentMode = previous;
            this.silentModeService?.updateCharacteristic(Characteristic.On, previous);
            this.platform.log.warn('Failed to set silent mode:', (error as any)?.message || String(error));
          }
        });
    }

    if (device.swingMode !== undefined) {
      this.swingModeService = accessory.getServiceById(Service.Switch, 'swing-mode') ||
        accessory.addService(Service.Switch, 'Swing', 'swing-mode');
      this.swingModeService.setCharacteristic(Characteristic.Name, 'Swing');
      this.swingModeService.getCharacteristic(Characteristic.On)
        .onGet(() => !!this.current.swingMode)
        .onSet(async value => {
          const previous = !!this.current.swingMode;
          const enabled = !!value;
          this.current.swingMode = enabled;
          try {
            await this.client.setSwingMode(device.id, enabled);
          } catch (error) {
            this.current.swingMode = previous;
            this.swingModeService?.updateCharacteristic(Characteristic.On, previous);
            this.platform.log.warn('Failed to set swing mode:', (error as any)?.message || String(error));
          }
        });
    }

    // Cooling threshold (Cool: editable 18–32; Auto: read-only 24)
    const cooling = this.service.getCharacteristic(Characteristic.CoolingThresholdTemperature)
      // Start permissive to swallow any cached HomeKit values, then tighten later
      .setProps({ minValue: 0, maxValue: 50, minStep: 1 })
      .onGet(() => {
        try {
          // In AUTO (eco), present a fixed upper bound for the Keep Between control
          const isEco = (this.current?.mode === 'eco') || (!!this.optimisticMode && Date.now() < this.optimisticMode.until && this.optimisticMode.value === 'eco');
          if (isEco) {
            return 24;
          }
          const v = Number(this.current?.targetTemperature);
          const t = Number.isFinite(v) ? v : 24;
          return this.clampTargetTemperature(t);
        } catch { return 24; }
      })
      .onSet(async (value) => {
        try {
          const isEco = (this.current?.mode === 'eco') || (!!this.optimisticMode && Date.now() < this.optimisticMode.until && this.optimisticMode.value === 'eco');
          const inLock = !!this.thresholdWriteLockUntil && Date.now() < this.thresholdWriteLockUntil;
          if (isEco) {
            // Read-only in AUTO; reset to fixed value
            try { this.service.updateCharacteristic(Characteristic.CoolingThresholdTemperature, 24); } catch {}
            return;
          }
          if (inLock) {
            // During transition, avoid pushing out-of-sync values
            if (this.thresholdLockMode === 'eco') {
              try { this.service.updateCharacteristic(Characteristic.CoolingThresholdTemperature, 24); } catch {}
              return;
            } else {
              const prev = this.clampTargetTemperature(this.current?.targetTemperature ?? this.lastCoolTargetC ?? 24);
              try { this.service.updateCharacteristic(Characteristic.CoolingThresholdTemperature, prev); } catch {}
              return;
            }
          }
          const t = Number(value);
          const clamped = this.clampTargetTemperature(t);
          const prev = this.clampTargetTemperature(this.current?.targetTemperature ?? this.lastCoolTargetC ?? 24);
          // Optimistically reflect the clamped value before sending
          try { this.service.updateCharacteristic(Characteristic.CoolingThresholdTemperature, clamped); } catch {}
          // Update local cache and hold optimistic value to avoid flicker until poll reflects it
          this.current.targetTemperature = clamped;
          this.optimisticCoolTarget = { value: clamped, until: Date.now() + 5000 };
          try {
            await this.client.setTargetTemperature(device.id, clamped);
          } catch (e) {
            // Roll back to previous value
            try { this.service.updateCharacteristic(Characteristic.CoolingThresholdTemperature, prev); } catch {}
            this.current.targetTemperature = prev;
            this.optimisticCoolTarget = undefined;
            try { this.platform.log.warn('Failed to set target temperature:', (e as any)?.message || String(e)); } catch {}
          }
        } catch {}
      });
    // Initialize with a safe value to avoid Home using an out-of-range cache
    try {
      const init = this.clampTargetTemperature(this.current.targetTemperature ?? 21);
      cooling.updateValue(init);
    } catch {}

    // RotationSpeed on HeaterCooler: expose low/medium/high where high => max
    const attachMainSpeedHandlers = () => {
      const ch = this.service.testCharacteristic(Characteristic.RotationSpeed)
        ? this.service.getCharacteristic(Characteristic.RotationSpeed)
        : this.service.addCharacteristic(Characteristic.RotationSpeed);
      ch.setProps({ minValue: 0, maxValue: 100, minStep: 1 })
        .onGet(() => {
          const s = (this.current.fanSpeed || '').toLowerCase();
          if (s === 'low') return 33;
          if (s === 'medium' || s === 'mid') return 66;
          if (s === 'high' || s === 'max' || s === 'turbo' || s === 'auto') return 100;
          return 0;
        })
        .onSet(async (value) => {
          const pct = Number(value);
          let s = 'low';
          if (pct >= 67) s = 'max';
          else if (pct >= 34) s = 'medium';
          else if (pct > 0) s = 'low';
          const prevS = (this.current.fanSpeed || '').toLowerCase();
          const prevPct = prevS === 'low' ? 33 : (prevS === 'medium' || prevS === 'mid') ? 66 : (prevS ? 100 : 0);
          try {
            await this.client.setFanSpeed(device.id, s);
            this.current.fanSpeed = s as any;
          } catch (e) {
            // Roll back
            try { this.service.updateCharacteristic(Characteristic.RotationSpeed, prevPct); } catch {}
            try { this.platform.log.warn('Failed to set fan speed:', (e as any)?.message || String(e)); } catch {}
          }
        });
    };

    // Attach once; avoid dynamic add/remove to keep Home UI stable
    attachMainSpeedHandlers();

    // Heating threshold: Auto UI only (read-only 20–24); in Cool, derive a safe value and keep read-only
    const heating = this.service.getCharacteristic(Characteristic.HeatingThresholdTemperature)
      // Start permissive to swallow any cached HomeKit values, then tighten later
      .setProps({ minValue: 0, maxValue: 50, minStep: 1 })
      .onGet(() => {
        try {
          const isEco = (this.current?.mode === 'eco') || (!!this.optimisticMode && Date.now() < this.optimisticMode.until && this.optimisticMode.value === 'eco');
          if (isEco) {
            // Fixed lower bound for Keep Between control in AUTO
            return 20;
          }
          const cool = this.clampTargetTemperature(this.current?.targetTemperature ?? 24);
          const hStored = Math.max(this.minimumTargetTemperature, Math.min(32, Math.round(this.heatThresholdC)));
          // Derive a safe heating value not exceeding cool and not below 18
          const derived = Math.max(this.minimumTargetTemperature, Math.min(32, cool - 1));
          return Math.max(this.minimumTargetTemperature, Math.min(32, Math.min(hStored, derived)));
        } catch { return this.minimumTargetTemperature; }
      })
      .onSet(async (_value) => {
        // Read-only semantics; reset to computed value
        try {
          const isEco = (this.current?.mode === 'eco') || (!!this.optimisticMode && Date.now() < this.optimisticMode.until && this.optimisticMode.value === 'eco');
          const inLock = !!this.thresholdWriteLockUntil && Date.now() < this.thresholdWriteLockUntil;
          if (isEco) {
            this.service.updateCharacteristic(Characteristic.HeatingThresholdTemperature, 20);
            return;
          }
          if (inLock) {
            if (this.thresholdLockMode === 'eco') {
              this.service.updateCharacteristic(Characteristic.HeatingThresholdTemperature, 20);
              return;
            } else {
              const cool = this.clampTargetTemperature(this.current?.targetTemperature ?? 24);
              const prevHeat = Math.max(this.minimumTargetTemperature, Math.min(32, cool - 1));
              this.service.updateCharacteristic(Characteristic.HeatingThresholdTemperature, prevHeat);
              return;
            }
          }
          const cool = this.clampTargetTemperature(this.current?.targetTemperature ?? 24);
          const derived = Math.max(this.minimumTargetTemperature, Math.min(32, cool - 1));
          const safe = Math.max(this.minimumTargetTemperature, derived);
          this.heatThresholdC = safe;
          this.service.updateCharacteristic(Characteristic.HeatingThresholdTemperature, safe);
        } catch {}
      });
    try {
      const coolInit = this.clampTargetTemperature(this.current?.targetTemperature ?? 24);
      const initHeat = Math.max(this.minimumTargetTemperature, Math.min(32, coolInit - 1));
      heating.updateValue(initHeat);
    } catch {}

    // Tighten props after initial values are seeded
    try {
      const inEco = this.current?.mode === 'eco';
      if (inEco) {
        const RO = [Perms.PAIRED_READ, Perms.EVENTS] as any;
        this.service.getCharacteristic(Characteristic.CoolingThresholdTemperature)
          .setProps({ minValue: 20, maxValue: 24, minStep: 1, perms: RO });
        this.service.getCharacteristic(Characteristic.HeatingThresholdTemperature)
          .setProps({ minValue: 20, maxValue: 24, minStep: 1, perms: RO });
      } else {
        const RW = [Perms.PAIRED_READ, Perms.PAIRED_WRITE, Perms.EVENTS] as any;
        this.service.getCharacteristic(Characteristic.CoolingThresholdTemperature)
          .setProps({ minValue: this.minimumTargetTemperature, maxValue: 32, minStep: 1, perms: RW });
        this.service.getCharacteristic(Characteristic.HeatingThresholdTemperature)
          .setProps({ minValue: this.minimumTargetTemperature, maxValue: 32, minStep: 1, perms: RW });
      }
    } catch {}

    this.service.updateCharacteristic(Characteristic.TemperatureDisplayUnits, Characteristic.TemperatureDisplayUnits.CELSIUS);

  }

  update(device: DelonghiDeviceSummary) {
    this.current = device;
    const { Characteristic } = this.platform;
    const now = Date.now();
    // Resolve an effective mode using optimistic local intent while cloud state catches up
    let effectiveMode: 'cool' | 'eco' | 'dry' | 'fan' | undefined = device.mode as any;
    if (this.optimisticMode && now < this.optimisticMode.until) {
      effectiveMode = this.optimisticMode.value as any;
    } else {
      this.optimisticMode = undefined;
    }
    this.service.updateCharacteristic(Characteristic.Active,
      device.power ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE);

    const currentState = !device.power ? Characteristic.CurrentHeaterCoolerState.INACTIVE
      : (effectiveMode === 'cool' || effectiveMode === 'eco') ? Characteristic.CurrentHeaterCoolerState.COOLING
      : Characteristic.CurrentHeaterCoolerState.IDLE;
    this.service.updateCharacteristic(Characteristic.CurrentHeaterCoolerState, currentState);

    const targetState = effectiveMode === 'eco'
      ? Characteristic.TargetHeaterCoolerState.AUTO
      : Characteristic.TargetHeaterCoolerState.COOL;
    this.service.updateCharacteristic(Characteristic.TargetHeaterCoolerState, targetState);

    if (typeof device.roomTemperature === 'number') {
      this.service.updateCharacteristic(Characteristic.CurrentTemperature, device.roomTemperature);
    }
    if (typeof device.humidity === 'number') {
      this.humidityService?.updateCharacteristic(Characteristic.CurrentRelativeHumidity,
        Math.max(0, Math.min(100, device.humidity)));
    }
    if (device.silentMode !== undefined) {
      this.silentModeService?.updateCharacteristic(Characteristic.On, device.silentMode);
    }
    if (device.swingMode !== undefined) {
      this.swingModeService?.updateCharacteristic(Characteristic.On, device.swingMode);
    }
    // Compute desired thresholds for this tick
    let desiredCool = 24;
    let desiredHeat = 20;
    try {
      const raw = Number(device.targetTemperature);
      const clamped = Number.isFinite(raw) ? this.clampTargetTemperature(raw) : 24;
      if (effectiveMode !== 'eco') {
        desiredCool = clamped;
        desiredHeat = Math.max(this.minimumTargetTemperature, Math.min(32, desiredCool - 1));
      }
    } catch {}

    // Order matters: when entering eco, write values first then tighten props; when in cool, relax props first then write values
    try {
      if (effectiveMode === 'eco') {
        // Update values first to 24/20
        try { this.service.updateCharacteristic(Characteristic.CoolingThresholdTemperature, 24); } catch {}
        try { this.service.updateCharacteristic(Characteristic.HeatingThresholdTemperature, 20); } catch {}
        // Then set props strict 20–24
        const RO = [Perms.PAIRED_READ, Perms.EVENTS] as any;
        this.service.getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature)
          .setProps({ minValue: 20, maxValue: 24, minStep: 1, perms: RO });
        this.service.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
          .setProps({ minValue: 20, maxValue: 24, minStep: 1, perms: RO });
      } else {
        // First relax props to 18–32
        const RW = [Perms.PAIRED_READ, Perms.PAIRED_WRITE, Perms.EVENTS] as any;
        this.service.getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature)
          .setProps({ minValue: this.minimumTargetTemperature, maxValue: 32, minStep: 1, perms: RW });
        this.service.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
          .setProps({ minValue: this.minimumTargetTemperature, maxValue: 32, minStep: 1, perms: RW });
        // Then update values within this window
        const ok = !(this.optimisticCoolTarget && now < this.optimisticCoolTarget.until && this.optimisticCoolTarget.value !== desiredCool);
        if (ok) {
          try { this.service.updateCharacteristic(Characteristic.CoolingThresholdTemperature, desiredCool); } catch {}
        }
        try { this.service.updateCharacteristic(Characteristic.HeatingThresholdTemperature, desiredHeat); } catch {}
      }
    } catch {}

    // Clear lock if elapsed
    if (this.thresholdWriteLockUntil && Date.now() >= this.thresholdWriteLockUntil) {
      this.thresholdWriteLockUntil = undefined;
      this.thresholdLockMode = undefined;
    }
    // Update fan speed when visible and keep characteristic visibility in COOL/DRY
    if (this.service.testCharacteristic(this.platform.Characteristic.RotationSpeed)) {
      const s = (device.fanSpeed || '').toLowerCase();
      const pct = s === 'low' ? 33 : (s === 'medium' || s === 'mid') ? 66 : 100;
      this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, pct);
    }
  
  }
}
