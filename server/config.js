'use strict';
const os = require('os');
const path = require('path');
const { DEFAULT_PORT, DEFAULT_LOG_LEVEL, DEFAULT_CODE_LIFE_SECONDS, DEFAULT_WRONG_CODES_PER_MINUTE } = require('./constants');

// Reads the .env file at the project root, if there is one. Values already set in the
// environment win over the file.
function readEnvFile(file) {
  try {
    process.loadEnvFile(file || path.join(__dirname, '..', '.env'));
    return true;
  } catch (e) {
    return false;
  }
}

function wholeNumber(text, fallback, lowest, highest) {
  const value = Number(text);
  return Number.isInteger(value) && value >= lowest && value <= highest ? value : fallback;
}

// Settings a person may change, from the environment (.env) and the command line.
function loadConfig(env, args) {
  env = env || process.env;
  args = args || process.argv.slice(2);
  return {
    port: wholeNumber(env.VCAST_PORT, DEFAULT_PORT, 1, 65535),
    logLevel: args.includes('--debug') ? 'debug' : env.VCAST_LOG_LEVEL || DEFAULT_LOG_LEVEL,
    logFile: env.VCAST_LOG_FILE || path.join(os.homedir(), '.vcast', 'vcast.log'),
    savedTvsFile: env.VCAST_SAVED_TVS_FILE || path.join(os.homedir(), '.vcast', 'tvs.json'),
    codeLifeSeconds: wholeNumber(env.VCAST_CODE_LIFE_SECONDS, DEFAULT_CODE_LIFE_SECONDS, 30, 3600),
    wrongCodesPerMinute: wholeNumber(env.VCAST_WRONG_CODES_PER_MINUTE, DEFAULT_WRONG_CODES_PER_MINUTE, 1, 100)
  };
}

module.exports = { loadConfig, readEnvFile };
