'use strict';
// Tests for the small server files: network, config, logger, pairing.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isThisComputer, isHomeNetwork, homeNetworkAddresses } = require('../../server/network');
const { loadConfig, readEnvFile } = require('../../server/config');
const { logger, setupLogger, siteOf } = require('../../server/logger');
const { Pairing, shortId } = require('../../server/pairing');
const { createKeepAwake, keepAwakeCommand } = require('../../server/keep-awake');
const { EventEmitter } = require('events');

test('network: knows this computer and home addresses from internet ones', () => {
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(isThisComputer(address), true, address);
  for (const address of ['192.168.1.5', undefined, '']) assert.equal(isThisComputer(address), false);
  for (const address of ['10.0.0.2', '192.168.1.5', '172.16.0.1', '172.31.255.1', '169.254.1.1', '::ffff:192.168.0.9', 'fd12:3456::1', 'fe80::1', '127.0.0.1']) {
    assert.equal(isHomeNetwork(address), true, address);
  }
  for (const address of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '2001:db8::1', '', undefined]) assert.equal(isHomeNetwork(address), false, String(address));
});

test('network: lists only home IPv4 addresses of this computer', () => {
  const interfaces = {
    lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    wifi: [
      { family: 'IPv4', internal: false, address: '192.168.1.20' },
      { family: 'IPv6', internal: false, address: 'fe80::1' }
    ],
    vpn: [{ family: 'IPv4', internal: false, address: '100.64.0.3' }],
    broken: undefined
  };
  assert.deepEqual(homeNetworkAddresses(interfaces), ['192.168.1.20']);
  assert.ok(Array.isArray(homeNetworkAddresses()));
});

test('config: defaults, port and log level', () => {
  assert.deepEqual(
    { ...loadConfig({}, []), logFile: 'x', savedTvsFile: 'y' },
    { port: 8787, logLevel: 'info', logFile: 'x', savedTvsFile: 'y', codeLifeSeconds: 300, wrongCodesPerMinute: 5 }
  );
  assert.equal(loadConfig({ VCAST_SAVED_TVS_FILE: '/tmp/tvs.json' }, []).savedTvsFile, '/tmp/tvs.json');
  assert.equal(loadConfig({ VCAST_PORT: '9000' }, []).port, 9000);
  assert.equal(loadConfig({ VCAST_PORT: 'abc' }, []).port, 8787);
  assert.equal(loadConfig({ VCAST_PORT: '70000' }, []).port, 8787);
  assert.equal(loadConfig({ VCAST_LOG_LEVEL: 'warn' }, []).logLevel, 'warn');
  assert.equal(loadConfig({ VCAST_LOG_LEVEL: 'warn' }, ['--debug']).logLevel, 'debug');
  assert.equal(typeof loadConfig().port, 'number');
  assert.equal(loadConfig({ VCAST_PORT: '80.5' }, []).port, 8787);
  assert.equal(loadConfig({ VCAST_LOG_FILE: '/tmp/my.log' }, []).logFile, '/tmp/my.log');
  assert.equal(loadConfig({ VCAST_CODE_LIFE_SECONDS: '60', VCAST_WRONG_CODES_PER_MINUTE: '3' }, []).codeLifeSeconds, 60);
  assert.equal(loadConfig({ VCAST_WRONG_CODES_PER_MINUTE: '3' }, []).wrongCodesPerMinute, 3);
  assert.equal(loadConfig({ VCAST_CODE_LIFE_SECONDS: '5' }, []).codeLifeSeconds, 300, 'too short falls back');
});

test('config: reads a .env file without replacing values already set', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'vcast-env-'));
  const file = path.join(folder, '.env');
  fs.writeFileSync(file, 'VCAST_TEST_FROM_FILE=yes\nVCAST_TEST_ALREADY_SET=from-file\n');
  process.env.VCAST_TEST_ALREADY_SET = 'from-environment';
  assert.equal(readEnvFile(file), true);
  assert.equal(process.env.VCAST_TEST_FROM_FILE, 'yes');
  assert.equal(process.env.VCAST_TEST_ALREADY_SET, 'from-environment');
  assert.equal(readEnvFile(path.join(folder, 'missing.env')), false);
  assert.equal(typeof readEnvFile(), 'boolean');
  fs.rmSync(folder, { recursive: true });
});

test('logger: readable lines, level filter, and no full links', () => {
  const lines = [];
  setupLogger({ level: 'info', print: (line) => lines.push(line) });
  const log = logger('test');
  log.debug('hidden');
  log.info('TV paired', { tv: 'ab12cd', empty: undefined, none: null });
  log.warn('Site said no', { link: 'https://cdn.example.com/a/b.m3u8?token=SECRET', reason: 'two words' });
  log.error('Broke', { reason: new Error('boom'), long: 'x'.repeat(300), bad: 'https://' });
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^\d\d:\d\d:\d\d\.\d{3} INFO {2}test {5}TV paired {2}tv=ab12cd$/);
  assert.match(lines[1], /link=cdn\.example\.com {2}reason="two words"$/);
  assert.doesNotMatch(lines.join('\n'), /SECRET|b\.m3u8/);
  assert.match(lines[2], /reason=boom/);
  assert.match(lines[2], /long=x{120}\.\.\./);
  assert.match(lines[2], /bad=unknown-site/);
  assert.equal(siteOf('https://a.example/x'), 'a.example');

  setupLogger({ level: 'nonsense', color: true, print: (line) => lines.push(line) });
  logger('test').info('colored');
  assert.ok(lines[3].includes('\x1b[36m'));
  setupLogger({ level: 'off' });
});

test('logger: writes to a file, keeps one old file, and survives a file it cannot write', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'vcast-log-'));
  const file = path.join(folder, 'logs', 'vcast.log');
  const lines = [];
  setupLogger({ level: 'debug', file, print: (line) => lines.push(line) });
  logger('test').debug('first line');
  assert.match(fs.readFileSync(file, 'utf8'), /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} DEBUG test {5}first line\n$/);

  fs.writeFileSync(file, 'x'.repeat(2 * 1024 * 1024 + 1));
  logger('test').info('after it got big');
  assert.ok(fs.existsSync(file + '.old'));
  assert.match(fs.readFileSync(file, 'utf8'), /after it got big/);

  setupLogger({ level: 'info', file: folder, print: (line) => lines.push(line) });
  logger('test').info('cannot write this to a folder');
  logger('test').info('still prints');
  assert.ok(lines.some((line) => /^Logging to .* stopped/.test(line)));
  assert.match(lines.at(-1), /still prints/);
  setupLogger({ level: 'off' });
  fs.rmSync(folder, { recursive: true });
});

function fakeSocket() {
  return { closed: false, close() { this.closed = true; } };
}

test('pairing: a code pairs once, wrong and old codes fail', () => {
  let time = 1000;
  const pairing = new Pairing({ now: () => time });
  const tv = pairing.connectTv('television-1', fakeSocket());
  const { code, isNew } = pairing.codeFor(tv);
  assert.match(code, /^\d{6}$/);
  assert.equal(isNew, true);
  assert.deepEqual(pairing.codeFor(tv), { code, isNew: false });

  assert.deepEqual(pairing.pairWithCode('000000' === code ? '111111' : '000000'), { error: 'bad_code' });
  assert.deepEqual(pairing.pairWithCode(undefined), { error: 'bad_code' });
  const result = pairing.pairWithCode(code.slice(0, 3) + ' ' + code.slice(3));
  assert.equal(result.tv, tv);
  assert.equal(pairing.findBySession(result.session), tv);
  assert.equal(pairing.findBySession('nope'), null);
  assert.equal(pairing.findBySession(undefined), null);
  assert.deepEqual(pairing.pairWithCode(code), { error: 'bad_code' }, 'a used code does not work again');

  pairing.unpair(tv);
  assert.equal(pairing.findBySession(result.session), null);
  const second = pairing.codeFor(tv).code;
  time += 301 * 1000;
  assert.deepEqual(pairing.pairWithCode(second), { error: 'bad_code' }, 'an old code does not work');
  assert.equal(pairing.codeFor(tv).isNew, true);
});

test('pairing: a TV opened from the computer pairs with its one-time key, once and in time', () => {
  let time = 0;
  const pairing = new Pairing({ now: () => time });
  const expected = pairing.expectTv();
  assert.equal(pairing.expectTv(), expected, 'asking again while waiting keeps the same key');
  assert.equal(pairing.isWaitingFor(expected.session), true);
  assert.equal(pairing.isWaitingFor('other'), false);
  assert.equal(pairing.isWaitingFor(undefined), false);

  assert.equal(pairing.connectTv('television-1', fakeSocket(), 'wrong-key').session, null);
  const tv = pairing.connectTv('television-2', fakeSocket(), expected.key);
  assert.equal(tv.session, expected.session);
  assert.equal(pairing.isWaitingFor(expected.session), false);
  assert.equal(pairing.connectTv('television-3', fakeSocket(), expected.key).session, null, 'the key works once');

  const late = pairing.expectTv();
  time += 121 * 1000;
  assert.equal(pairing.isWaitingFor(late.session), false);
  assert.equal(pairing.connectTv('television-4', fakeSocket(), late.key).session, null, 'too late');
});

test('pairing: too many wrong codes blocks for a minute', () => {
  let time = 0;
  const pairing = new Pairing({ now: () => time, wrongCodesPerMinute: 2, codeLifeSeconds: 600 });
  const tv = pairing.connectTv('television-1', fakeSocket());
  const { code } = pairing.codeFor(tv);
  assert.equal(pairing.pairWithCode('x').error, 'bad_code');
  assert.equal(pairing.pairWithCode('x').error, 'bad_code');
  assert.equal(pairing.pairWithCode(code).error, 'too_many_tries');
  time += 61000;
  assert.equal(pairing.pairWithCode(code).tv, tv);
});

test('pairing: a TV keeps its record when it reconnects, and old TVs are forgotten', () => {
  let time = 0;
  const pairing = new Pairing({ now: () => time });
  const first = fakeSocket();
  const tv = pairing.connectTv('television-1', first);
  const again = fakeSocket();
  assert.equal(pairing.connectTv('television-1', again), tv);
  assert.equal(first.closed, true);
  pairing.disconnectTv(tv, first);
  assert.equal(tv.socket, again, 'an old socket closing does not disconnect the new one');
  pairing.disconnectTv(tv, again);
  assert.equal(tv.socket, null);

  assert.notEqual(pairing.connectTv('bad id!', fakeSocket()).id, 'bad id!');
  assert.equal(pairing.connectTv(null, fakeSocket()).id.length, 16);
  assert.equal(shortId('abcdefghij'), 'abcdef');

  const forgotten = [];
  pairing.onTvForgotten = (gone) => forgotten.push(gone);
  time += 11 * 60 * 1000;
  assert.deepEqual(pairing.removeOldTvs(), [tv]);
  assert.deepEqual(forgotten, [tv], 'the app is told, so it can end that TV\'s cast');
  assert.equal(pairing.tvs.size, 2);
});

test('pairing: when the list is full it drops an offline TV, never a connected one', () => {
  const pairing = new Pairing();
  const tvs = [];
  for (let i = 0; i < 8; i++) tvs.push(pairing.connectTv('television-' + i, fakeSocket()));
  tvs[3].socket = null;
  pairing.connectTv('television-8', fakeSocket());
  assert.equal(pairing.tvs.has('television-3'), false);

  tvs[5].socket = null;
  tvs[5].session = 'paired';
  pairing.connectTv('television-9', fakeSocket());
  assert.equal(pairing.tvs.has('television-5'), false, 'no offline unpaired TV, so an offline paired one goes');

  assert.equal(pairing.connectTv('television-10', fakeSocket()), null, 'all connected, so the new one is refused');
  assert.equal(pairing.tvs.has('television-0'), true);
  assert.equal(pairing.tvs.size, 8);
});

// A pretend system tool: remembers how it was started and whether it was ended.
function fakeSpawn() {
  const started = [];
  const spawn = (command, args) => {
    const tool = Object.assign(new EventEmitter(), { command, args, killed: false, kill() { this.killed = true; } });
    started.push(tool);
    return tool;
  };
  return { started, spawn };
}

test('keep awake: each system gets its own tool, tied to the VCast process', () => {
  assert.deepEqual(keepAwakeCommand('darwin', 42), ['caffeinate', ['-i', '-s', '-w', '42']]);
  const windows = keepAwakeCommand('win32', 42);
  assert.equal(windows[0], 'powershell');
  assert.match(windows[1][2], /SetThreadExecutionState\(0x80000001\)/);
  assert.match(windows[1][2], /Get-Process -Id 42 /, 'it ends when VCast is gone');
  const linux = keepAwakeCommand('linux', 42);
  assert.equal(linux[0], 'systemd-inhibit');
  assert.ok(linux[1].includes('--pid=42'));
  assert.equal(keepAwakeCommand('plan9', 42), null);
});

test('keep awake: starts the tool once, ends it when no longer needed, and copes without one', () => {
  setupLogger({ level: 'off' });
  const { started, spawn } = fakeSpawn();
  const awake = createKeepAwake({ platform: 'darwin', pid: 42, spawn });
  assert.equal(awake.isOn(), false);
  awake.set(false);
  awake.set(true);
  awake.set(true);
  assert.equal(started.length, 1, 'asked twice, started once');
  assert.deepEqual([started[0].command, started[0].args.at(-1)], ['caffeinate', '42']);
  assert.equal(awake.isOn(), true);
  awake.set(false);
  assert.deepEqual([started[0].killed, awake.isOn()], [true, false]);
  started[0].emit('exit');

  awake.set(true);
  started[1].emit('exit');
  assert.equal(awake.isOn(), false, 'the tool ending by itself is noticed');
  awake.set(true);
  assert.equal(started.length, 3, 'and it is started again when needed');

  const lines = [];
  setupLogger({ level: 'info', print: (line) => lines.push(line) });
  const missing = fakeSpawn();
  const without = createKeepAwake({ platform: 'linux', pid: 42, spawn: missing.spawn });
  without.set(true);
  missing.started[0].emit('error', new Error('spawn systemd-inhibit ENOENT'));
  without.set(true);
  without.set(true);
  assert.equal(missing.started.length, 1, 'a missing tool is not tried again and again');
  assert.equal(lines.filter((line) => /Could not keep the computer awake/.test(line)).length, 1);
  assert.equal(without.isOn(), false);

  const unknown = createKeepAwake({ platform: 'plan9', spawn: missing.spawn });
  unknown.set(true);
  assert.equal(missing.started.length, 1, 'an unknown system starts nothing');
  assert.equal(typeof createKeepAwake().isOn(), 'boolean');
  setupLogger({ level: 'off' });
});
