'use strict';

const Module = require('module');

let installed = false;

function installHomebridgeModuleStub() {
  if (installed) {
    return;
  }

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'homebridge') {
      return {};
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  installed = true;
}

module.exports = {
  installHomebridgeModuleStub,
};
