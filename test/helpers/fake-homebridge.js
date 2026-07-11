'use strict';

class FakeCharacteristicInstance {
  constructor(definition) {
    this.definition = definition;
    this.props = {};
    this.value = undefined;
    this.getHandler = undefined;
    this.setHandler = undefined;
  }

  setProps(props) {
    this.props = { ...this.props, ...props };
    return this;
  }

  onGet(handler) {
    this.getHandler = handler;
    return this;
  }

  onSet(handler) {
    this.setHandler = handler;
    return this;
  }

  updateValue(value) {
    this.value = value;
    return this;
  }

  async invokeGet() {
    if (this.getHandler) {
      return this.getHandler();
    }
    return this.value;
  }

  async invokeSet(value) {
    if (this.setHandler) {
      await this.setHandler(value);
      return;
    }
    this.value = value;
  }
}

class FakeServiceInstance {
  constructor(serviceType, label) {
    this.serviceType = serviceType;
    this.label = label;
    this.characteristics = new Map();
  }

  setCharacteristic(definition, value) {
    this.getCharacteristic(definition).value = value;
    return this;
  }

  getCharacteristic(definition) {
    if (!this.characteristics.has(definition)) {
      this.characteristics.set(definition, new FakeCharacteristicInstance(definition));
    }
    return this.characteristics.get(definition);
  }

  addCharacteristic(definition) {
    return this.getCharacteristic(definition);
  }

  testCharacteristic(definition) {
    return this.characteristics.has(definition);
  }

  updateCharacteristic(definition, value) {
    this.getCharacteristic(definition).value = value;
    return this;
  }
}

class FakePlatformAccessory {
  constructor(displayName, uuid, hap) {
    this.displayName = displayName;
    this.UUID = uuid;
    this.context = {};
    this.services = new Map();
    this.services.set(
      hap.Service.AccessoryInformation,
      new FakeServiceInstance(hap.Service.AccessoryInformation, 'AccessoryInformation'),
    );
  }

  getService(definition) {
    return this.services.get(definition);
  }

  addService(definition) {
    const service = new FakeServiceInstance(definition, definition.name || 'Service');
    this.services.set(definition, service);
    return service;
  }
}

function createCharacteristic(name, extras = {}) {
  return { name, ...extras };
}

function createFakeHAP() {
  const Characteristic = {
    Perms: {
      READ: 'pr',
      WRITE: 'pw',
      NOTIFY: 'ev',
    },
    Manufacturer: createCharacteristic('Manufacturer'),
    Model: createCharacteristic('Model'),
    SerialNumber: createCharacteristic('SerialNumber'),
    Name: createCharacteristic('Name'),
    Active: createCharacteristic('Active', {
      ACTIVE: 1,
      INACTIVE: 0,
    }),
    CurrentHeaterCoolerState: createCharacteristic('CurrentHeaterCoolerState', {
      INACTIVE: 0,
      IDLE: 1,
      HEATING: 2,
      COOLING: 3,
    }),
    TargetHeaterCoolerState: createCharacteristic('TargetHeaterCoolerState', {
      AUTO: 0,
      HEAT: 1,
      COOL: 2,
    }),
    CurrentTemperature: createCharacteristic('CurrentTemperature'),
    CoolingThresholdTemperature: createCharacteristic('CoolingThresholdTemperature'),
    HeatingThresholdTemperature: createCharacteristic('HeatingThresholdTemperature'),
    RotationSpeed: createCharacteristic('RotationSpeed'),
    TemperatureDisplayUnits: createCharacteristic('TemperatureDisplayUnits', {
      CELSIUS: 0,
      FAHRENHEIT: 1,
    }),
  };

  const Service = {
    AccessoryInformation: { name: 'AccessoryInformation' },
    HeaterCooler: { name: 'HeaterCooler' },
  };

  return { Characteristic, Service };
}

function createFakeAPI() {
  const hap = createFakeHAP();
  const listeners = new Map();
  const registered = [];
  const updated = [];
  const unregistered = [];

  class PlatformAccessory extends FakePlatformAccessory {
    constructor(displayName, uuid) {
      super(displayName, uuid, hap);
    }
  }

  return {
    hap: {
      ...hap,
      uuid: {
        generate(value) {
          return `uuid:${value}`;
        },
      },
    },
    platformAccessory: PlatformAccessory,
    on(event, handler) {
      listeners.set(event, handler);
    },
    async emit(event) {
      const handler = listeners.get(event);
      if (handler) {
        await handler();
      }
    },
    registerPlatformAccessories(_pluginName, _platformName, accessories) {
      registered.push(...accessories);
    },
    updatePlatformAccessories(accessories) {
      updated.push(...accessories);
    },
    unregisterPlatformAccessories(_pluginName, _platformName, accessories) {
      unregistered.push(...accessories);
    },
    snapshots: {
      registered,
      updated,
      unregistered,
    },
  };
}

function createFakeLogger() {
  const entries = {
    info: [],
    warn: [],
    error: [],
    debug: [],
  };

  return {
    entries,
    info(...args) {
      entries.info.push(args.join(' '));
    },
    warn(...args) {
      entries.warn.push(args.join(' '));
    },
    error(...args) {
      entries.error.push(args.join(' '));
    },
    debug(...args) {
      entries.debug.push(args.join(' '));
    },
  };
}

module.exports = {
  createFakeAPI,
  createFakeLogger,
};
