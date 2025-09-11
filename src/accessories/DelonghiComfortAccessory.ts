import { PlatformAccessory, Service } from 'homebridge';
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
      .setCharacteristic(Characteristic.Model, 'Comfort V2')
      .setCharacteristic(Characteristic.SerialNumber, device.id);

    this.service = accessory.getService(Service.HeaterCooler) || accessory.addService(Service.HeaterCooler);
    this.service.setCharacteristic(Characteristic.Name, device.name);
    // Seed last remembered cool target
    try {
      const seed = Math.max(18, Math.min(32, Math.round(Number(device.targetTemperature ?? 24))));
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
        const prevCool = Math.max(18, Math.min(32, Math.round(Number(this.current?.targetTemperature ?? this.lastCoolTargetC ?? 24))));
        try {
          if (value === Characteristic.TargetHeaterCoolerState.COOL) {
            // Immediately make thresholds editable and show latest cool setpoint
            try {
              this.optimisticMode = { value: 'cool', until: Date.now() + 5000 };
              this.thresholdWriteLockUntil = Date.now() + 1500;
              this.thresholdLockMode = 'cool';
              const RW = [this.platform.Characteristic.Perms.READ, this.platform.Characteristic.Perms.WRITE, this.platform.Characteristic.Perms.NOTIFY] as any;
              this.service.getCharacteristic(Characteristic.CoolingThresholdTemperature)
                .setProps({ minValue: 18, maxValue: 32, minStep: 1, perms: RW });
              this.service.getCharacteristic(Characteristic.HeatingThresholdTemperature)
                .setProps({ minValue: 18, maxValue: 32, minStep: 1, perms: RW });
              const cool = Math.max(18, Math.min(32, Math.round(Number(this.lastCoolTargetC ?? this.current?.targetTemperature ?? prevCool))));
              const heat = Math.min(Math.max(18, Math.round(this.heatThresholdC)), cool - 1);
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
              const currentCool = Math.max(18, Math.min(32, Math.round(Number(this.current?.targetTemperature ?? this.lastCoolTargetC ?? 24))));
              this.lastCoolTargetC = currentCool;
              // First set values to the eco window
              this.service.updateCharacteristic(Characteristic.CoolingThresholdTemperature, 24);
              this.service.updateCharacteristic(Characteristic.HeatingThresholdTemperature, 20);
              // Then tighten props to strict RO 20–24
              const RO = [this.platform.Characteristic.Perms.READ, this.platform.Characteristic.Perms.NOTIFY] as any;
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
            const RO = [this.platform.Characteristic.Perms.READ, this.platform.Characteristic.Perms.NOTIFY] as any;
            const RW = [this.platform.Characteristic.Perms.READ, this.platform.Characteristic.Perms.WRITE, this.platform.Characteristic.Perms.NOTIFY] as any;
            if (wasEco) {
              // Revert to AUTO window 20–24
              this.service.getCharacteristic(Characteristic.CoolingThresholdTemperature).setProps({ minValue: 20, maxValue: 24, minStep: 1, perms: RO });
              this.service.getCharacteristic(Characteristic.HeatingThresholdTemperature).setProps({ minValue: 20, maxValue: 24, minStep: 1, perms: RO });
              this.service.updateCharacteristic(Characteristic.CoolingThresholdTemperature, 24);
              this.service.updateCharacteristic(Characteristic.HeatingThresholdTemperature, 20);
              this.service.updateCharacteristic(Characteristic.TargetHeaterCoolerState, Characteristic.TargetHeaterCoolerState.AUTO);
            } else {
              // Revert to COOL window 18–32 and previous cool target
              this.service.getCharacteristic(Characteristic.CoolingThresholdTemperature).setProps({ minValue: 18, maxValue: 32, minStep: 1, perms: RW });
              this.service.getCharacteristic(Characteristic.HeatingThresholdTemperature).setProps({ minValue: 18, maxValue: 32, minStep: 1, perms: RW });
              this.service.updateCharacteristic(Characteristic.CoolingThresholdTemperature, prevCool);
              const prevHeat = Math.max(18, Math.min(32, prevCool - 1));
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
          return Math.max(18, Math.min(32, Math.round(t)));
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
              const prev = Math.max(18, Math.min(32, Math.round(Number(this.current?.targetTemperature ?? this.lastCoolTargetC ?? 24))));
              try { this.service.updateCharacteristic(Characteristic.CoolingThresholdTemperature, prev); } catch {}
              return;
            }
          }
          const t = Number(value);
          const clamped = Math.max(18, Math.min(32, Math.round(t)));
          const prev = Math.max(18, Math.min(32, Math.round(Number(this.current?.targetTemperature ?? this.lastCoolTargetC ?? 24))));
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
      const init = Math.max(18, Math.min(32, Math.round(this.current.targetTemperature ?? 21)));
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
          const cool = Math.max(18, Math.min(32, Math.round(Number(this.current?.targetTemperature ?? 24))));
          const hStored = Math.max(18, Math.min(32, Math.round(this.heatThresholdC)));
          // Derive a safe heating value not exceeding cool and not below 18
          const derived = Math.max(18, Math.min(32, cool - 1));
          return Math.max(18, Math.min(32, Math.min(hStored, derived)));
        } catch { return 18; }
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
              const cool = Math.max(18, Math.min(32, Math.round(Number(this.current?.targetTemperature ?? 24))));
              const prevHeat = Math.max(18, Math.min(32, cool - 1));
              this.service.updateCharacteristic(Characteristic.HeatingThresholdTemperature, prevHeat);
              return;
            }
          }
          const cool = Math.max(18, Math.min(32, Math.round(Number(this.current?.targetTemperature ?? 24))));
          const derived = Math.max(18, Math.min(32, cool - 1));
          const safe = Math.max(18, derived);
          this.heatThresholdC = safe;
          this.service.updateCharacteristic(Characteristic.HeatingThresholdTemperature, safe);
        } catch {}
      });
    try {
      const coolInit = Math.max(18, Math.min(32, Math.round(Number(this.current?.targetTemperature ?? 24))));
      const initHeat = Math.max(18, Math.min(32, coolInit - 1));
      heating.updateValue(initHeat);
    } catch {}

    // Tighten props after initial values are seeded
    try {
      const inEco = this.current?.mode === 'eco';
      if (inEco) {
        const RO = [this.platform.Characteristic.Perms.READ, this.platform.Characteristic.Perms.NOTIFY] as any;
        this.service.getCharacteristic(Characteristic.CoolingThresholdTemperature)
          .setProps({ minValue: 20, maxValue: 24, minStep: 1, perms: RO });
        this.service.getCharacteristic(Characteristic.HeatingThresholdTemperature)
          .setProps({ minValue: 20, maxValue: 24, minStep: 1, perms: RO });
      } else {
        const RW = [this.platform.Characteristic.Perms.READ, this.platform.Characteristic.Perms.WRITE, this.platform.Characteristic.Perms.NOTIFY] as any;
        this.service.getCharacteristic(Characteristic.CoolingThresholdTemperature)
          .setProps({ minValue: 18, maxValue: 32, minStep: 1, perms: RW });
        this.service.getCharacteristic(Characteristic.HeatingThresholdTemperature)
          .setProps({ minValue: 18, maxValue: 32, minStep: 1, perms: RW });
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
    // Compute desired thresholds for this tick
    let desiredCool = 24;
    let desiredHeat = 20;
    try {
      const raw = Number(device.targetTemperature);
      const clamped = Number.isFinite(raw) ? Math.max(18, Math.min(32, Math.round(raw))) : 24;
      if (effectiveMode !== 'eco') {
        desiredCool = clamped;
        desiredHeat = Math.max(18, Math.min(32, desiredCool - 1));
      }
    } catch {}

    // Order matters: when entering eco, write values first then tighten props; when in cool, relax props first then write values
    try {
      if (effectiveMode === 'eco') {
        // Update values first to 24/20
        try { this.service.updateCharacteristic(Characteristic.CoolingThresholdTemperature, 24); } catch {}
        try { this.service.updateCharacteristic(Characteristic.HeatingThresholdTemperature, 20); } catch {}
        // Then set props strict 20–24
        const RO = [this.platform.Characteristic.Perms.READ, this.platform.Characteristic.Perms.NOTIFY] as any;
        this.service.getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature)
          .setProps({ minValue: 20, maxValue: 24, minStep: 1, perms: RO });
        this.service.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
          .setProps({ minValue: 20, maxValue: 24, minStep: 1, perms: RO });
      } else {
        // First relax props to 18–32
        const RW = [this.platform.Characteristic.Perms.READ, this.platform.Characteristic.Perms.WRITE, this.platform.Characteristic.Perms.NOTIFY] as any;
        this.service.getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature)
          .setProps({ minValue: 18, maxValue: 32, minStep: 1, perms: RW });
        this.service.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
          .setProps({ minValue: 18, maxValue: 32, minStep: 1, perms: RW });
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
