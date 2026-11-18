const test = require('node:test');
const assert = require('node:assert');
const M = require('../modes.js');

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} vs ${b}`);

test('speed of sound: 20 C is 343.2 m/s, as v1 assumed (1126 ft/s)', () => {
  close(M.speedOfSound(20), 343.2, 0.1);
  close(M.speedOfSound(20) / 0.3048, 1126, 0.5);
  assert.ok(M.speedOfSound(30) > M.speedOfSound(10));
});

test("King's Chamber fundamentals match the v1 list", () => {
  const r = M.ROOMS.khufu;
  const modes = M.roomModes(r.L, r.W, r.H, M.speedOfSound(20), 0, 100);
  const f = (nx, ny, nz) => modes.find((m) => m.nx === nx && m.ny === ny && m.nz === nz).f;
  close(f(1, 0, 0), 16.39, 0.02, 'length');
  close(f(0, 0, 1), 29.32, 0.02, 'height');
  close(f(0, 1, 0), 32.75, 0.03, 'width');
  close(f(1, 0, 1), 33.59, 0.03, 'tangential');
});

test('the fourth height mode is near 117 Hz and is axial', () => {
  const r = M.ROOMS.khufu;
  const modes = M.roomModes(r.L, r.W, r.H, M.speedOfSound(20), 60, 250);
  const m = modes.find((x) => x.nx === 0 && x.ny === 0 && x.nz === 4);
  close(m.f, 117.3, 0.2);
  assert.strictEqual(m.type, 'axial');
});

test('modes are sorted, inside the range, and none are missed', () => {
  const c = 343.2, L = 6.2, W = 3.1, H = 2.7, lo = 50, hi = 400;
  const modes = M.roomModes(L, W, H, c, lo, hi);
  for (let i = 1; i < modes.length; i++) assert.ok(modes[i].f >= modes[i - 1].f);
  modes.forEach((m) => assert.ok(m.f >= lo && m.f <= hi));
  let brute = 0;
  for (let a = 0; a < 40; a++) for (let b = 0; b < 40; b++) for (let d = 0; d < 40; d++) {
    if (!a && !b && !d) continue;
    const f = (c / 2) * Math.hypot(a / L, b / W, d / H);
    if (f >= lo && f <= hi) brute++;
  }
  assert.strictEqual(modes.length, brute);
});

test('mode types', () => {
  assert.strictEqual(M.modeType(2, 0, 0), 'axial');
  assert.strictEqual(M.modeType(1, 1, 0), 'tangential');
  assert.strictEqual(M.modeType(1, 2, 3), 'oblique');
});

test('bad input gives an empty list, not a crash', () => {
  assert.deepStrictEqual(M.roomModes(0, 3, 3, 343, 20, 200), []);
  assert.deepStrictEqual(M.roomModes(5, 3, NaN, 343, 20, 200), []);
  assert.deepStrictEqual(M.roomModes(5, 3, 3, 343, 20, 0), []);
});

test('note names', () => {
  assert.deepStrictEqual(M.noteName(440), { name: 'A4', cents: 0 });
  assert.strictEqual(M.noteName(261.63).name, 'C4');
  assert.strictEqual(M.noteName(117.3).name, 'A#2');
  assert.strictEqual(M.noteName(16.39).name, 'C0');
});

test('log sweep hits its ends and its geometric middle', () => {
  close(M.sweepFreq(60, 240, 0), 60, 1e-9);
  close(M.sweepFreq(60, 240, 1), 240, 1e-9);
  close(M.sweepFreq(60, 240, 0.5), 120, 1e-9);
  close(M.sweepFreq(60, 240, 2), 240, 1e-9);
});

test('findPeaks finds resonances on a sloping response and ignores ripple', () => {
  const pts = [];
  for (let f = 60; f <= 250; f += 1) {
    let db = -70 + 0.08 * (f - 60) + 0.6 * Math.sin(f);          // speaker slope + ripple
    db += 12 * Math.exp(-((f - 117) ** 2) / 8);                   // resonance
    db += 9 * Math.exp(-((f - 176) ** 2) / 8);                    // resonance
    pts.push({ f, db });
  }
  const peaks = M.findPeaks(pts, 4, 12);
  assert.deepStrictEqual(peaks.map((p) => Math.round(p.f)), [117, 176]);
});

test('nearestMode reports the miss in percent', () => {
  const modes = [{ f: 100 }, { f: 117.3 }, { f: 150 }];
  const n = M.nearestMode(modes, 119);
  assert.strictEqual(n.mode.f, 117.3);
  close(n.errorPct, 1.45, 0.02);
  assert.strictEqual(M.nearestMode([], 100), null);
});
