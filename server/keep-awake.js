'use strict';
// Keeps the computer from going to sleep while a video is being sent to the TV, using the tool
// each system already has. The screen may still switch off and lock; only sleep is held back.
// Closing a laptop lid still puts it to sleep: no app is allowed to stop that.
const { spawn } = require('child_process');
const { logger } = require('./logger');

const log = logger('awake');

// Windows has no ready-made tool, so a small PowerShell script asks the system to stay awake
// for as long as VCast (process PID) is running.
const WINDOWS_SCRIPT = [
  "$power = Add-Type -PassThru -Namespace VCast -Name Power -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint flags);'",
  '$power::SetThreadExecutionState(0x80000001) | Out-Null',
  'while (Get-Process -Id PID -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 15 }'
].join('; ');

// The command for each system. Every one of them ends by itself when VCast stops, so the
// computer is never left awake by mistake.
function keepAwakeCommand(platform, pid) {
  if (platform === 'darwin') return ['caffeinate', ['-i', '-s', '-w', String(pid)]];
  if (platform === 'win32') return ['powershell', ['-NoProfile', '-Command', WINDOWS_SCRIPT.replace('PID', String(pid))]];
  if (platform === 'linux') return ['systemd-inhibit', ['--what=idle:sleep', '--why=VCast is sending a video to the TV', 'tail', '--pid=' + pid, '-f', '/dev/null']];
  return null;
}

function createKeepAwake(options) {
  options = options || {};
  const command = keepAwakeCommand(options.platform || process.platform, options.pid || process.pid);
  let running = null;
  // Set when the system has no such tool, so it is not tried again every second.
  let cannot = !command;

  return {
    isOn: () => !!running,
    // set(true) while a video plays on a TV, set(false) when none does.
    set(needed) {
      if (needed === !!running) return;
      if (!needed) {
        running.kill();
        running = null;
        return log.info('The computer may sleep again');
      }
      if (cannot) return;
      const started = (options.spawn || spawn)(command[0], command[1], { stdio: 'ignore' });
      started.on('error', (error) => {
        cannot = true;
        if (running === started) running = null;
        log.warn('Could not keep the computer awake', { reason: error });
      });
      started.on('exit', () => {
        if (running === started) running = null;
      });
      running = started;
      log.info('Keeping the computer awake while the TV plays');
    }
  };
}

module.exports = { createKeepAwake, keepAwakeCommand };
