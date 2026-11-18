/*
 * Room-mode maths for PyramidResonance. No audio, no DOM: runs in the browser
 * (window.Modes) and in Node (require) so it can be unit-tested.
 *
 * Model: rigid-walled rectangular room.
 *   f(nx,ny,nz) = c/2 * sqrt((nx/L)^2 + (ny/W)^2 + (nz/H)^2)
 * All lengths in metres, frequencies in hertz, temperature in Celsius.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Modes = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const INCH = 0.0254, FOOT = 0.3048;

  // Chamber dimensions. Khufu: Petrie 1883 means (412.35 x 206.26 x 230.39 in).
  const ROOMS = {
    khufu: {
      name: "Khufu: King's Chamber",
      L: 412.35 * INCH, W: 206.26 * INCH, H: 230.39 * INCH,
      note: 'Flat ceiling, granite walls: close to an ideal box.',
    },
    khafre: {
      name: 'Khafre: burial chamber',
      L: 46.5 * FOOT, W: 16.5 * FOOT, H: 22.5 * FOOT,
      note: 'Gabled ceiling: height modes are only approximate.',
    },
    menkaure: {
      name: 'Menkaure: burial chamber',
      L: 21.88 * FOOT, W: 8.67 * FOOT, H: 11.5 * FOOT,
      note: 'Vaulted ceiling: height modes are only approximate.',
    },
  };

  // Speed of sound in dry air, m/s. 20 C gives 343.2 m/s (1126 ft/s, as in v1).
  function speedOfSound(tempC) {
    return 331.3 * Math.sqrt(1 + tempC / 273.15);
  }

  function modeType(nx, ny, nz) {
    const zeros = (nx === 0) + (ny === 0) + (nz === 0);
    return zeros === 2 ? 'axial' : zeros === 1 ? 'tangential' : 'oblique';
  }

  /*
   * All modes with fMin <= f <= fMax, sorted by frequency.
   * Each: { f, nx, ny, nz, type, label }.
   * The index limits are derived from fMax, so no mode in range is missed.
   */
  function roomModes(L, W, H, c, fMin, fMax) {
    if (!(L > 0 && W > 0 && H > 0 && c > 0) || !(fMax > 0)) return [];
    const lo = Math.max(0, fMin || 0);
    const out = [];
    const maxX = Math.floor(2 * L * fMax / c);
    const maxY = Math.floor(2 * W * fMax / c);
    const maxZ = Math.floor(2 * H * fMax / c);
    for (let nx = 0; nx <= maxX; nx++) {
      for (let ny = 0; ny <= maxY; ny++) {
        for (let nz = 0; nz <= maxZ; nz++) {
          if (nx === 0 && ny === 0 && nz === 0) continue;
          const f = (c / 2) * Math.sqrt((nx / L) ** 2 + (ny / W) ** 2 + (nz / H) ** 2);
          if (f >= lo && f <= fMax) {
            out.push({ f, nx, ny, nz, type: modeType(nx, ny, nz), label: '(' + nx + ',' + ny + ',' + nz + ')' });
          }
        }
      }
    }
    out.sort((a, b) => a.f - b.f || a.nx - b.nx || a.ny - b.ny || a.nz - b.nz);
    return out;
  }

  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  // Nearest equal-tempered note (A4 = 440 Hz), e.g. 117.3 Hz -> { name: 'A#2', cents: 11 }
  function noteName(f) {
    if (!(f > 0)) return { name: '', cents: 0 };
    const midi = 69 + 12 * Math.log2(f / 440);
    const n = Math.round(midi);
    return { name: NOTE_NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1), cents: Math.round((midi - n) * 100) };
  }

  // Frequency at fraction t (0..1) of a logarithmic sweep from f1 to f2
  function sweepFreq(f1, f2, t) {
    const u = Math.min(1, Math.max(0, t));
    return f1 * Math.pow(f2 / f1, u);
  }

  /*
   * Peaks in a measured curve. points: [{ f, db }] sorted by f.
   * A peak is a local maximum that stands at least minProminence dB above the
   * median of its neighbourhood (+-window points). The median removes the slow
   * slope of the speaker and microphone response.
   */
  function findPeaks(points, minProminence, window) {
    const prom = minProminence == null ? 4 : minProminence;
    const w = window == null ? 12 : window;
    const peaks = [];
    for (let i = 1; i < points.length - 1; i++) {
      const p = points[i];
      if (!(p.db > points[i - 1].db && p.db >= points[i + 1].db)) continue;
      const a = Math.max(0, i - w), b = Math.min(points.length, i + w + 1);
      const near = [];
      for (let k = a; k < b; k++) near.push(points[k].db);
      near.sort((x, y) => x - y);
      const median = near[Math.floor(near.length / 2)];
      if (p.db - median >= prom) peaks.push({ f: p.f, db: p.db, prominence: p.db - median });
    }
    // keep the strongest of any peaks closer than 3 % in frequency
    peaks.sort((x, y) => y.prominence - x.prominence);
    const kept = [];
    for (const p of peaks) {
      if (!kept.some((k) => Math.abs(k.f - p.f) / p.f < 0.03)) kept.push(p);
    }
    return kept.sort((x, y) => x.f - y.f);
  }

  // Predicted mode nearest to a measured frequency, with the miss in percent
  function nearestMode(modes, f) {
    let best = null;
    for (const m of modes) {
      if (!best || Math.abs(m.f - f) < Math.abs(best.f - f)) best = m;
    }
    return best ? { mode: best, errorPct: 100 * (f - best.f) / best.f } : null;
  }

  return { ROOMS, speedOfSound, roomModes, modeType, noteName, sweepFreq, findPeaks, nearestMode };
});
