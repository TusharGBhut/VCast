'use strict';
// Makes tests/e2e/fixtures/clip.webm: a small VP8 + Opus video that Playwright's Chromium can
// really play (it has no H.264/AAC). Run it again only when the fixture must change:
//
//   node tests/e2e/fixtures/make-clip.js [seconds]
//
// The browser records a canvas in real time, so this takes as long as the clip is. Chromium's
// MediaRecorder writes the length and a seek index into the file, so it can be seeked as it is.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const SECONDS = Number(process.argv[2]) || 90;
const OUT = path.join(__dirname, 'clip.webm');

async function record() {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  const base64 = await page.evaluate(async (seconds) => {
    const canvas = document.createElement('canvas');
    canvas.width = 96;
    canvas.height = 54;
    document.body.appendChild(canvas);
    const paint = canvas.getContext('2d');
    const startedAt = performance.now();
    const draw = () => {
      const t = (performance.now() - startedAt) / 1000;
      paint.fillStyle = 'hsl(' + ((t * 12) % 360) + ', 60%, 30%)';
      paint.fillRect(0, 0, 96, 54);
      paint.fillStyle = '#fff';
      paint.font = '20px monospace';
      paint.fillText(t.toFixed(1), 10, 34);
    };
    draw();
    const drawTimer = setInterval(draw, 100);

    const audio = new AudioContext();
    const tone = audio.createOscillator();
    const quiet = audio.createGain();
    quiet.gain.value = 0.02;
    const audioOut = audio.createMediaStreamDestination();
    tone.connect(quiet).connect(audioOut);
    tone.start();

    const stream = new MediaStream([...canvas.captureStream(10).getVideoTracks(), ...audioOut.stream.getAudioTracks()]);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8,opus', videoBitsPerSecond: 20000, audioBitsPerSecond: 8000 });
    const parts = [];
    recorder.ondataavailable = (event) => parts.push(event.data);
    const stopped = new Promise((resolve) => (recorder.onstop = resolve));
    recorder.start();
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    recorder.stop();
    await stopped;
    clearInterval(drawTimer);
    const bytes = new Uint8Array(await new Blob(parts).arrayBuffer());
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(text);
  }, SECONDS);
  await browser.close();
  return Buffer.from(base64, 'base64');
}

record().then((recording) => {
  // 0x4489 is the Duration field. Without it the tests could not seek.
  if (!recording.subarray(0, 4096).includes(Buffer.from([0x44, 0x89]))) throw new Error('The recording has no length; seeking would not work');
  fs.writeFileSync(OUT, recording);
  console.log('Wrote ' + OUT + ' (' + recording.length + ' bytes, ' + SECONDS + ' s)');
});
