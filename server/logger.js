'use strict';
const fs = require('fs');
const path = require('path');

// Readable logs for the screen and a file:
//   18:22:01.123 INFO  pairing  TV paired  tv=ab12cd
// Use: const log = logger('pairing'); log.info('TV paired', { tv: id });

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, off: 99 };
const COLORS = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };
const { MAX_LOG_FILE_BYTES, MAX_LOG_VALUE_TEXT } = require('./constants');

const defaults = {
  level: 'info',
  file: null,
  color: false,
  print: (line) => process.stdout.write(line + '\n')
};
let settings = Object.assign({}, defaults);

function setupLogger(options) {
  settings = Object.assign({}, defaults, options);
  if (!(settings.level in LEVELS)) settings.level = 'info';
  if (settings.file) fs.mkdirSync(path.dirname(settings.file), { recursive: true });
}

function siteOf(link) {
  try {
    return new URL(link).host;
  } catch (e) {
    return 'unknown-site';
  }
}

// Links can carry tokens and say what someone is watching, so only the site name is written.
function safeValue(value) {
  if (value instanceof Error) value = value.message;
  if (typeof value === 'string' && /^[a-z]+:\/\//i.test(value)) return siteOf(value);
  const text = String(value);
  return text.length > MAX_LOG_VALUE_TEXT ? text.slice(0, MAX_LOG_VALUE_TEXT) + '...' : text;
}

function fieldsText(fields) {
  return Object.entries(fields || {})
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => {
      const text = safeValue(value);
      return '  ' + key + '=' + (/\s/.test(text) ? JSON.stringify(text) : text);
    })
    .join('');
}

function writeToFile(line) {
  try {
    if (fs.existsSync(settings.file) && fs.statSync(settings.file).size > MAX_LOG_FILE_BYTES) {
      fs.renameSync(settings.file, settings.file + '.old');
    }
    fs.appendFileSync(settings.file, line + '\n');
  } catch (e) {
    const file = settings.file;
    settings.file = null;
    settings.print('Logging to ' + file + ' stopped: ' + e.message);
  }
}

function write(level, area, message, fields) {
  if (LEVELS[level] < LEVELS[settings.level]) return;
  const now = new Date();
  const time = now.toTimeString().slice(0, 8) + '.' + String(now.getMilliseconds()).padStart(3, '0');
  const text = level.toUpperCase().padEnd(5) + ' ' + area.padEnd(8) + ' ' + message + fieldsText(fields);
  settings.print(time + ' ' + (settings.color ? COLORS[level] + text + '\x1b[0m' : text));
  if (settings.file) writeToFile(now.toLocaleDateString('sv') + ' ' + time + ' ' + text);
}

function logger(area) {
  return {
    debug: (message, fields) => write('debug', area, message, fields),
    info: (message, fields) => write('info', area, message, fields),
    warn: (message, fields) => write('warn', area, message, fields),
    error: (message, fields) => write('error', area, message, fields)
  };
}

module.exports = { logger, setupLogger, siteOf };
