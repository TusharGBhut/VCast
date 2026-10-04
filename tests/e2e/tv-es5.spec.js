'use strict';
// Old-browser safety of the TV page. A TV browser can be an old Chromium, so everything the TV
// page loads must be plain ES5 and must not lean on newer browser features without a fallback.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const espree = require('espree');

const TV_FOLDER = path.join(__dirname, '..', '..', 'tv');
const read = (name) => fs.readFileSync(path.join(TV_FOLDER, name), 'utf8');

// Fails with the line number of the first piece of syntax newer than ES5.
function assertEs5(source, name) {
  try {
    espree.parse(source, { ecmaVersion: 5, sourceType: 'script' });
  } catch (error) {
    assert.fail(name + ' is not ES5: ' + error.message + ' (line ' + error.lineNumber + ')');
  }
}

test('tv.js has only ES5 syntax', () => {
  assertEs5(read('tv.js'), 'tv/tv.js');
});

test('the hls.js file the TV page loads has only ES5 syntax', () => {
  assertEs5(fs.readFileSync(require.resolve('hls.js/dist/hls.min.js'), 'utf8'), 'hls.min.js');
});

test('tv.js uses no browser feature newer than ES5-era browsers have', () => {
  const NEWER = {
    'Promise (as a global)': /\bnew Promise\b|\bPromise\./,
    'fetch': /\bfetch\s*\(/,
    'classList': /\.classList\b/,
    'dataset': /\.dataset\b/,
    'String includes/startsWith/endsWith/padStart/repeat': /\.(includes|startsWith|endsWith|padStart|padEnd|repeat)\s*\(/,
    'Array find/findIndex/from/of': /\.(find|findIndex)\s*\(|\bArray\.(from|of)\b/,
    'Object.assign/entries/values': /\bObject\.(assign|entries|values|fromEntries)\b/,
    'Map/Set/Symbol/WeakMap': /\bnew (Map|Set|WeakMap|WeakSet)\b|\bSymbol\b/,
    'Number.isFinite and friends': /\bNumber\.(isFinite|isNaN|isInteger|parseFloat|parseInt)\b/,
    'DOM append/prepend/remove/replaceChildren/closest/matches': /\.(append|prepend|replaceChildren|closest|matches|remove|toggleAttribute)\s*\(/,
    'URL / URLSearchParams': /\bnew URL\b|\bURLSearchParams\b/,
    'KeyboardEvent.key or .code (old TVs only give keyCode)': /\bevent\.(key|code)\b/,
    'async helpers': /\b(queueMicrotask|requestIdleCallback|structuredClone)\b/
  };
  const lines = read('tv.js').split('\n');
  const found = [];
  for (const [what, pattern] of Object.entries(NEWER)) {
    lines.forEach((line, index) => {
      if (pattern.test(line.replace(/\/\/.*$/, ''))) found.push('line ' + (index + 1) + ': ' + what);
    });
  }
  assert.deepEqual(found, []);
});

test('the play() result is used as a promise only after checking that it is one', () => {
  // Old browsers return nothing from video.play(), so calling .catch on it would throw.
  const source = read('tv.js');
  assert.match(source, /if \(result && result\['catch'\]\)/);
  assert.doesNotMatch(source, /\.play\(\)\s*\.\s*(then|catch)/);
});

test('localStorage is only touched inside try/catch', () => {
  const lines = read('tv.js').split('\n');
  lines.forEach((line, index) => {
    if (!/localStorage/.test(line)) return;
    const before = lines.slice(Math.max(0, index - 2), index).join('\n');
    assert.match(before, /try \{/, 'tv.js line ' + (index + 1) + ' uses localStorage outside try');
  });
});

test('the TV page has no inline script and loads only its own files', () => {
  const page = read('index.html');
  const scripts = [...page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.deepEqual(scripts.map((script) => script[1].trim()), ['src="hls.min.js"', 'src="tv.js"']);
  for (const script of scripts) assert.equal(script[2].trim(), '', 'no inline code');
  assert.doesNotMatch(page, /type="module"|\bdefer\b|\basync\b/);
  assert.doesNotMatch(page, /https?:\/\//, 'nothing is loaded from another site');
});

test('tv.css avoids layout features old TV browsers lack', () => {
  const css = read('tv.css');
  for (const feature of ['display: grid', 'display: flex', 'var(--', 'calc(', 'clamp(', 'gap:', 'inset:', ':is(', ':where(', '@supports', 'aspect-ratio']) {
    assert.ok(!css.includes(feature), 'tv.css uses ' + feature);
  }
});
