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
   * The index limits are derived from fMax with one spare index per axis, and the
   * upper bound has a tiny tolerance, so a mode sitting exactly on fMax is kept.
   * Call estimateModeCount first: the count grows with the cube of fMax.
   */
  function roomModes(L, W, H, c, fMin, fMax) {
    if (!(L > 0 && W > 0 && H > 0 && c > 0) || !(fMax > 0)) return [];
    const lo = Math.max(0, fMin || 0);
    const out = [];
    const hi = fMax * (1 + 1e-9);
    const maxX = Math.floor(2 * L * fMax / c) + 1;
    const maxY = Math.floor(2 * W * fMax / c) + 1;
    const maxZ = Math.floor(2 * H * fMax / c) + 1;
    for (let nx = 0; nx <= maxX; nx++) {
      for (let ny = 0; ny <= maxY; ny++) {
        for (let nz = 0; nz <= maxZ; nz++) {
          if (nx === 0 && ny === 0 && nz === 0) continue;
          const f = (c / 2) * Math.sqrt((nx / L) ** 2 + (ny / W) ** 2 + (nz / H) ** 2);
          if (f >= lo && f <= hi) {
            out.push({ f, nx, ny, nz, type: modeType(nx, ny, nz), label: '(' + nx + ',' + ny + ',' + nz + ')' });
          }
        }
      }
    }
    out.sort((a, b) => a.f - b.f || a.nx - b.nx || a.ny - b.ny || a.nz - b.nz);
    return out;
  }

  // Approximate number of modes below f (the standard volume + surface + edge formula)
  function modesBelow(L, W, H, c, f) {
    if (!(f > 0)) return 0;
    const k = f / c;
    const V = L * W * H, S = 2 * (L * W + L * H + W * H), E = 4 * (L + W + H);
    return (4 * Math.PI / 3) * V * k * k * k + (Math.PI / 4) * S * k * k + (E / 8) * k;
  }
  // Cheap estimate of how many modes roomModes would return, for refusing huge ranges
  function estimateModeCount(L, W, H, c, fMin, fMax) {
    if (!(L > 0 && W > 0 && H > 0 && c > 0) || !(fMax > 0)) return 0;
    return Math.max(0, modesBelow(L, W, H, c, fMax) - modesBelow(L, W, H, c, Math.max(0, fMin || 0)));
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
   * A peak is a local maximum whose prominence is at least minProminence dB.
   * Prominence is how far the curve must drop from the peak before it can rise
   * to anything higher: the peak's height above the deeper-sided saddle. Unlike
   * a comparison with the neighbourhood average, this finds broad humps as well
   * as narrow spikes, and ignores a slow overall slope. (The third argument, a
   * window, is no longer used.)
   */
  function findPeaks(points, minProminence) {
    const prom = minProminence == null ? 4 : minProminence;
    const n = points.length;
    const peaks = [];
    for (let i = 0; i < n; i++) {
      const p = points[i];
      // a local maximum; the first and last points count if they top their one neighbour
      const left = i === 0 ? -Infinity : points[i - 1].db;
      const right = i === n - 1 ? -Infinity : points[i + 1].db;
      if (n < 3 || !(p.db > left && p.db >= right)) continue;
      // lowest point on each side before the curve rises above this peak (or ends)
      let lMin = Infinity, rMin = Infinity;
      for (let k = i - 1; k >= 0 && points[k].db <= p.db; k--) if (points[k].db < lMin) lMin = points[k].db;
      for (let k = i + 1; k < n && points[k].db <= p.db; k++) if (points[k].db < rMin) rMin = points[k].db;
      const base = i === 0 ? rMin : i === n - 1 ? lMin : Math.max(lMin, rMin);
      const prominence = p.db - base;
      // edge: the curve was cut off here, so this may be a slope and not a true peak
      if (prominence >= prom) peaks.push({ f: p.f, db: p.db, prominence, edge: i === 0 || i === n - 1 });
    }
    // keep the strongest of any peaks closer than 3 % in frequency
    peaks.sort((x, y) => y.prominence - x.prominence);
    const kept = [];
    for (const p of peaks) {
      if (!kept.some((k) => Math.abs(k.f - p.f) / p.f < 0.03)) kept.push(p);
    }
    return kept.sort((x, y) => x.f - y.f);
  }

  // The `count` most prominent peaks, returned in frequency order
  function strongestPeaks(peaks, count) {
    return peaks.slice().sort((x, y) => y.prominence - x.prominence).slice(0, count).sort((x, y) => x.f - y.f);
  }

  /*
   * Modes that share a frequency (65.5 Hz is both width x2 and length x4 in the
   * King's Chamber) sound the same, so list them as one row. Returns the first of
   * each group with `also` = the other members and the strongest type of the group.
   */
  function mergeClose(modes, relTol) {
    const tol = relTol == null ? 0.001 : relTol;
    const rank = { axial: 0, tangential: 1, oblique: 2 };
    const out = [];
    for (const m of modes) {
      const g = out[out.length - 1];
      if (g && Math.abs(m.f - g.f) / g.f <= tol) {
        g.also.push(m);
        if (rank[m.type] < rank[g.type]) g.type = m.type;
      } else {
        out.push(Object.assign({}, m, { also: [] }));
      }
    }
    return out;
  }

  /*
   * Chance (0..1) that a frequency picked at random in [fMin, fMax] (evenly on a
   * log scale) lands within tolPct of some listed mode. Shown next to matches so a
   * "match" against a crowded list is not mistaken for evidence.
   */
  function randomHitChance(modes, fMin, fMax, tolPct) {
    if (!(fMax > fMin) || !(fMin > 0) || !modes.length) return 0;
    const t = tolPct / 100;
    const spans = modes.map((m) => [Math.max(fMin, m.f * (1 - t)), Math.min(fMax, m.f * (1 + t))])
      .filter((s) => s[1] > s[0]).sort((a, b) => a[0] - b[0]);
    let covered = 0, end = 0;
    for (const s of spans) {
      const a = Math.max(s[0], end);
      if (s[1] > a) { covered += Math.log(s[1] / a); end = s[1]; }
    }
    return Math.min(1, covered / Math.log(fMax / fMin));
  }

  // Predicted mode nearest to a measured frequency, with the miss in percent
  function nearestMode(modes, f) {
    let best = null;
    for (const m of modes) {
      if (!best || Math.abs(m.f - f) < Math.abs(best.f - f)) best = m;
    }
    return best ? { mode: best, errorPct: 100 * (f - best.f) / best.f } : null;
  }

  /*
   * Honest matching of a measured peak to predicted modes.
   * Returns { mode, errorPct, candidates } where candidates is how many predicted
   * modes lie within tolPct of the measurement. mode is null when none do.
   * With many candidates a "match" means nothing, and the caller should say so.
   */
  function matchMode(modes, f, tolPct) {
    const tol = tolPct == null ? 3 : tolPct;
    let candidates = 0;
    for (const m of modes) if (Math.abs(m.f - f) / m.f * 100 <= tol) candidates++;
    const near = nearestMode(modes, f);
    if (!near || Math.abs(near.errorPct) > tol) return { mode: null, errorPct: null, candidates: 0 };
    return { mode: near.mode, errorPct: near.errorPct, candidates };
  }

  /*
   * Level in dB of one tone in an AnalyserNode spectrum (dB per bin).
   * Sums the power of the bins around f, which covers the window's main lobe,
   * so the reading does not ripple as a gliding tone crosses bin centres.
   */
  function bandLevelDb(spectrum, binHz, f, halfBins) {
    const h = halfBins == null ? 3 : halfBins;
    const centre = Math.round(f / binHz);
    let power = 0, any = false;
    for (let k = Math.max(1, centre - h); k <= Math.min(spectrum.length - 1, centre + h); k++) {
      const db = spectrum[k];
      if (Number.isFinite(db)) { power += Math.pow(10, db / 10); any = true; }
    }
    return any && power > 0 ? 10 * Math.log10(power) : null;
  }

  /*
   * Which frequency a level reading taken `elapsed` seconds into a sweep belongs to.
   * The analyser looks back over its window and the sound reaches the microphone
   * late, so the reading describes the tone emitted `delay` seconds ago.
   * Returns null while the delayed tone has not started yet.
   */
  function sweepReadingFreq(f1, f2, dur, elapsed, delay) {
    const t = elapsed - delay;
    if (!(dur > 0) || t < 0) return null;
    return sweepFreq(f1, f2, t / dur);
  }

  // Sweep rate in Hz per second at frequency f of a logarithmic sweep
  function sweepRate(f1, f2, dur, f) {
    return f * Math.log(f2 / f1) / dur;
  }

  return { ROOMS, speedOfSound, roomModes, estimateModeCount, modeType, noteName, sweepFreq, sweepRate, sweepReadingFreq,
    findPeaks, strongestPeaks, nearestMode, matchMode, bandLevelDb, mergeClose, randomHitChance };
});
