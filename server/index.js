'use strict';
const { loadConfig, readEnvFile } = require('./config');
const { createApp } = require('./app');
const { homeNetworkAddresses } = require('./network');
const { logger, setupLogger } = require('./logger');

readEnvFile();
const config = loadConfig();
setupLogger({ level: config.logLevel, file: config.logFile, color: process.stdout.isTTY });
const log = logger('start');
const app = createApp(config);

app.start().then(
  (port) => {
    const addresses = homeNetworkAddresses().map((address) => 'http://' + address + ':' + port);
    log.info('VCast is running', { port, logLevel: config.logLevel, logFile: config.logFile });
    console.log(addresses.length ? '\nOn the TV, open the Internet app and go to:\n  ' + addresses.join('\n  ') : '\nNo home network found. Connect this computer to your Wi-Fi.');
    console.log('Press Ctrl+C to stop.\n');
  },
  (error) => {
    log.error(error.code === 'EADDRINUSE' ? 'Port ' + config.port + ' is in use. Is VCast already running?' : 'VCast could not start', { reason: error });
    process.exit(1);
  }
);

// One bad request must never take VCast down while a film is playing.
process.on('uncaughtException', (error) => log.error('Unexpected problem, carrying on', { reason: error, where: String(error.stack).split('\n')[1] }));

process.on('SIGINT', () => app.stop().then(() => process.exit(0)));
