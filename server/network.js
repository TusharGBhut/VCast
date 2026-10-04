'use strict';
const os = require('os');

function plainAddress(address) {
  address = String(address || '');
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

function isThisComputer(address) {
  const a = plainAddress(address);
  return a === '::1' || /^127\./.test(a);
}

// True for this computer and for home-network address ranges. Anything else is the internet.
function isHomeNetwork(address) {
  const a = plainAddress(address);
  return (
    isThisComputer(a) ||
    /^10\./.test(a) ||
    /^192\.168\./.test(a) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(a) ||
    /^169\.254\./.test(a) ||
    /^f[cd][0-9a-f]{2}:/i.test(a) ||
    /^fe80:/i.test(a)
  );
}

function homeNetworkAddresses(interfaces) {
  const found = [];
  for (const list of Object.values(interfaces || os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal && isHomeNetwork(item.address)) found.push(item.address);
    }
  }
  return found;
}

module.exports = { isThisComputer, isHomeNetwork, homeNetworkAddresses };
