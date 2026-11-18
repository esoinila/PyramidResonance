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

// ---------- added after the code review ----------

test('findPeaks sees a peak at either end of the curve', () => {
  const flat = (n) => Array.from({ length: n }, (_, i) => ({ f: 60 + i, db: -60 }));
  const a = flat(40); a[0].db = -40;
  assert.deepStrictEqual(M.findPeaks(a).map((p) => p.f), [60]);
  const b = flat(40); b[39].db = -40;
  assert.deepStrictEqual(M.findPeaks(b).map((p) => p.f), [99]);
});

test('findPeaks copes with empty and very short curves', () => {
  assert.deepStrictEqual(M.findPeaks([]), []);
  assert.deepStrictEqual(M.findPeaks([{ f: 100, db: -20 }]), []);
  assert.deepStrictEqual(M.findPeaks([{ f: 100, db: -20 }, { f: 101, db: -50 }]), []);
});

test('strongestPeaks keeps the most prominent, in frequency order', () => {
  const peaks = [10, 3, 8, 1, 9].map((prominence, i) => ({ f: 100 + i * 10, db: 0, prominence }));
  assert.deepStrictEqual(M.strongestPeaks(peaks, 3).map((p) => p.f), [100, 120, 140]);
});

test('a mode exactly on the edge of the range is included', () => {
  const r = M.ROOMS.khufu, c = M.speedOfSound(20);
  const all = M.roomModes(r.L, r.W, r.H, c, 0, 300);
  const height4 = all.find((m) => m.nx === 0 && m.ny === 0 && m.nz === 4).f;
  assert.ok(M.roomModes(r.L, r.W, r.H, c, 60, height4).some((m) => m.label === '(0,0,4)'), 'upper edge');
  assert.ok(M.roomModes(r.L, r.W, r.H, c, height4, 250).some((m) => m.label === '(0,0,4)'), 'lower edge');
  // a cube whose axial mode sits exactly on a round number
  const cube = M.roomModes(1, 1, 1, 340, 0, 170);
  assert.strictEqual(cube.length, 3);
});

test('estimateModeCount is within 20 % of the real count and is cheap for huge ranges', () => {
  const r = M.ROOMS.khufu, c = M.speedOfSound(20);
  for (const [lo, hi] of [[60, 250], [20, 500], [10, 1000]]) {
    const real = M.roomModes(r.L, r.W, r.H, c, lo, hi).length;
    const est = M.estimateModeCount(r.L, r.W, r.H, c, lo, hi);
    assert.ok(Math.abs(est - real) / real < 0.2, `${lo}-${hi}: ${est} vs ${real}`);
  }
  assert.ok(M.estimateModeCount(100, 100, 100, 343, 10, 4000) > 1e6);
  assert.strictEqual(M.estimateModeCount(0, 1, 1, 343, 10, 100), 0);
});

test('matchMode refuses a far peak and counts the candidates in a dense list', () => {
  const sparse = [{ f: 100 }, { f: 200 }];
  assert.strictEqual(M.matchMode(sparse, 150).mode, null);
  const hit = M.matchMode(sparse, 101);
  assert.strictEqual(hit.mode.f, 100);
  assert.strictEqual(hit.candidates, 1);
  close(hit.errorPct, 1, 1e-9);
  const dense = Array.from({ length: 50 }, (_, i) => ({ f: 195 + i * 0.2 }));
  assert.ok(M.matchMode(dense, 200).candidates > 10);
  assert.strictEqual(M.matchMode([], 100).mode, null);
});

test('bandLevelDb sums the power around the tone and ignores silence', () => {
  const s = new Float32Array(64).fill(-Infinity);
  s[10] = -20; s[11] = -20;
  close(M.bandLevelDb(s, 10, 104), -20 + 10 * Math.log10(2), 1e-6);
  assert.strictEqual(M.bandLevelDb(new Float32Array(64).fill(-Infinity), 10, 100), null);
  // the reading barely moves as the tone slides between two bin centres
  const mk = (frac) => { const a = new Float32Array(64).fill(-200); a[20] = 10 * Math.log10(1 - frac + 1e-9); a[21] = 10 * Math.log10(frac + 1e-9); return a; };
  close(M.bandLevelDb(mk(0.1), 10, 201), M.bandLevelDb(mk(0.9), 10, 209), 1e-3);
});

test('sweepReadingFreq shifts a reading back by the delay', () => {
  assert.strictEqual(M.sweepReadingFreq(60, 250, 60, 0.1, 0.3), null);
  close(M.sweepReadingFreq(60, 250, 60, 0.3, 0.3), 60, 1e-9);
  close(M.sweepReadingFreq(60, 250, 60, 30.3, 0.3), Math.sqrt(60 * 250), 1e-9);
  assert.ok(M.sweepReadingFreq(60, 250, 60, 30, 0.3) < M.sweepFreq(60, 250, 0.5));
  close(M.sweepRate(60, 250, 60, 117.3), 117.3 * Math.log(250 / 60) / 60, 1e-12);
});

// ---------- added after the delta inspection ----------

test('mergeClose lists modes that share a frequency as one row', () => {
  const r = M.ROOMS.khufu;
  const axial = M.roomModes(r.L, r.W, r.H, M.speedOfSound(20), 60, 250).filter((m) => m.type === 'axial');
  const rows = M.mergeClose(axial);
  assert.ok(rows.length < axial.length);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i].f / rows[i - 1].f > 1.001, 'rows are distinct');
  assert.strictEqual(rows.reduce((n, g) => n + 1 + g.also.length, 0), axial.length, 'no mode is lost');
  const first = rows[0];
  close(first.f, 65.5, 0.05);
  assert.strictEqual(first.also.length, 1);
  // the strongest type wins
  const mixed = M.mergeClose([{ f: 100, type: 'oblique' }, { f: 100.05, type: 'axial' }, { f: 120, type: 'tangential' }]);
  assert.deepStrictEqual(mixed.map((g) => g.type), ['axial', 'tangential']);
  assert.deepStrictEqual(M.mergeClose([]), []);
});

test('randomHitChance: sparse list is unlikely, crowded list is near certain, overlaps are not counted twice', () => {
  close(M.randomHitChance([{ f: 100 }], 50, 200, 1.5), Math.log(101.5 / 98.5) / Math.log(4), 1e-9);
  close(M.randomHitChance([{ f: 100 }, { f: 100 }], 50, 200, 1.5), Math.log(101.5 / 98.5) / Math.log(4), 1e-9);
  const crowded = Array.from({ length: 400 }, (_, i) => ({ f: 50 + i * 0.4 }));
  assert.ok(M.randomHitChance(crowded, 50, 200, 1.5) > 0.99);
  assert.strictEqual(M.randomHitChance([], 50, 200, 1.5), 0);
  assert.strictEqual(M.randomHitChance([{ f: 100 }], 200, 50, 1.5), 0);
  assert.ok(M.randomHitChance([{ f: 300 }], 50, 200, 1.5) === 0, 'a mode outside the range does not count');
});

test('findPeaks marks a peak on the edge of the curve', () => {
  const pts = Array.from({ length: 40 }, (_, i) => ({ f: 60 + i, db: -60 }));
  pts[0].db = -40; pts[20].db = -40;
  const peaks = M.findPeaks(pts);
  assert.deepStrictEqual(peaks.map((p) => [p.f, p.edge]), [[60, true], [80, false]]);
});

test('app.js BUILD and sw.js VERSION are the same, and every cached file exists', () => {
  const fs = require('node:fs'), path = require('node:path');
  const root = path.join(__dirname, '..');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  const build = app.match(/const BUILD = '([^']+)'/)[1];
  const version = sw.match(/const VERSION = '([^']+)'/)[1];
  assert.strictEqual(build, version);
  const assets = sw.match(/const ASSETS = \[([^\]]+)\]/)[1].match(/'[^']+'/g).map((s) => s.slice(1, -1));
  assert.ok(assets.length >= 9);
  for (const a of assets) if (a !== './') assert.ok(fs.existsSync(path.join(root, a)), a);
  // every id the script looks up exists in the page
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  for (const m of app.matchAll(/\$\('([A-Za-z]+)'\)/g)) assert.ok(html.includes('id="' + m[1] + '"'), 'missing id ' + m[1]);
});
