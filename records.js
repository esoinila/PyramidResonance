/*
 * PyramidResonance: saved measurements. Pure functions only (no storage, no page),
 * shared by the browser and the tests.
 *
 * A record is one measured spectrum with when, where and how it was taken.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Records = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SCHEMA = 'pyramid-resonance-measurement/1';

  const round = (v, digits) => {
    const k = Math.pow(10, digits);
    return Math.round(v * k) / k;
  };
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const pad = (n) => String(n).padStart(2, '0');

  // Geolocation fix -> plain object, or null if it has no usable coordinates
  function cleanLocation(loc) {
    if (!loc || num(loc.lat) == null || num(loc.lon) == null) return null;
    if (Math.abs(loc.lat) > 90 || Math.abs(loc.lon) > 180) return null;
    return {
      lat: round(loc.lat, 6),            // 6 decimals is about 0.1 m
      lon: round(loc.lon, 6),
      accuracyM: num(loc.accuracyM) == null ? null : round(loc.accuracyM, 1),
      altitudeM: num(loc.altitudeM) == null ? null : round(loc.altitudeM, 1),
      altitudeAccuracyM: num(loc.altitudeAccuracyM) == null ? null : round(loc.altitudeAccuracyM, 1),
      time: typeof loc.time === 'string' ? loc.time : null,
    };
  }

  // Of two fixes, the one to keep: the more accurate, and any fix beats none
  function betterFix(a, b) {
    const A = cleanLocation(a), B = cleanLocation(b);
    if (!A) return B;
    if (!B) return A;
    const accA = A.accuracyM == null ? Infinity : A.accuracyM;
    const accB = B.accuracyM == null ? Infinity : B.accuracyM;
    return accB < accA ? B : A;
  }

  /*
   * Build a record from what the app has on screen.
   * input: { id, time (Date or ISO string), kind, note, room, tempC, fMin, fMax,
   *          sweepDurS, speaker, curve: [{ f, db }], peaks: [{ f, db, prominence, ... }], app }
   */
  function makeRecord(input) {
    const time = input.time instanceof Date ? input.time : new Date(input.time || Date.now());
    const iso = Number.isFinite(time.getTime()) ? time.toISOString() : new Date().toISOString();
    const curve = (input.curve || [])
      .filter((p) => p && num(p.f) != null && num(p.db) != null)
      .map((p) => [round(p.f, 2), round(p.db, 1)]);
    const peaks = (input.peaks || [])
      .filter((p) => p && num(p.f) != null)
      .map((p) => {
        const o = { f: round(p.f, 2), db: num(p.db) == null ? null : round(p.db, 1), prominenceDb: num(p.prominence) == null ? null : round(p.prominence, 1) };
        if (p.edge) o.edge = true;
        if (p.echo) o.echo = true;
        if (p.nearest) o.nearest = String(p.nearest);
        if (p.miss && p.miss !== '–') o.miss = String(p.miss);
        return o;
      });
    return {
      schema: SCHEMA,
      id: String(input.id || iso.replace(/\D/g, '').slice(0, 17) + '-' + Math.random().toString(36).slice(2, 6)),
      time: iso,
      tzOffsetMin: num(input.tzOffsetMin) == null ? -time.getTimezoneOffset() : input.tzOffsetMin,
      kind: input.kind === 'sweep' ? 'sweep' : 'clap',
      note: String(input.note || '').trim().slice(0, 200),
      location: cleanLocation(input.location),
      locationStatus: input.locationStatus || 'pending',   // pending | ok | denied | unavailable | off
      room: input.room || null,
      tempC: num(input.tempC),
      fMin: num(input.fMin),
      fMax: num(input.fMax),
      sweepDurS: input.kind === 'sweep' ? num(input.sweepDurS) : null,
      speaker: input.kind === 'sweep' ? (input.speaker || null) : null,
      peaks,
      curve,                    // [[Hz, dB], ...]; dB is relative, not calibrated
      photo: null,              // { name, type, width, height, takenTime } once a photo is attached
      audio: null,              // { type, format, sampleRate, channels, samples, durationS } when the raw sound was kept
      app: String(input.app || ''),
    };
  }

  // Local date and time of a record, as the person saw it on their watch
  function localParts(rec) {
    const t = new Date(new Date(rec.time).getTime() + (rec.tzOffsetMin || 0) * 60000);
    return {
      date: t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate()),
      time: pad(t.getUTCHours()) + ':' + pad(t.getUTCMinutes()),
      compact: pad(t.getUTCHours()) + pad(t.getUTCMinutes()) + pad(t.getUTCSeconds()),
    };
  }

  // File name stem shared by a record's data, chart and photo, so they sort together
  function fileBase(rec) {
    const p = localParts(rec);
    const slug = String(rec.note || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
    return 'resonance-' + p.date + '-' + p.compact + (slug ? '-' + slug : '');
  }

  function formatLocation(loc) {
    const l = cleanLocation(loc);
    if (!l) return '';
    return l.lat.toFixed(5) + ', ' + l.lon.toFixed(5) +
      (l.accuracyM != null ? ' ±' + Math.round(l.accuracyM) + ' m' : '') +
      (l.altitudeM != null ? ', ' + Math.round(l.altitudeM) + ' m above sea level' : '');
  }

  function mapsUrl(loc) {
    const l = cleanLocation(loc);
    return l ? 'https://maps.google.com/?q=' + l.lat + ',' + l.lon : '';
  }

  function peakSummary(rec, count) {
    const peaks = (rec.peaks || []).slice().sort((a, b) => (b.prominenceDb || 0) - (a.prominenceDb || 0)).slice(0, count || 4)
      .sort((a, b) => a.f - b.f);
    if (!peaks.length) return 'no clear peaks';
    return peaks.map((p) => p.f.toFixed(1)).join(', ') + ' Hz';
  }

  // Short text for the share sheet and the body of an email
  function shareText(rec) {
    const p = localParts(rec);
    const lines = [
      'Resonance measurement (' + rec.kind + '), ' + p.date + ' ' + p.time + (rec.note ? ', ' + rec.note : ''),
      'Peaks: ' + peakSummary(rec, 8),
      'Range: ' + rec.fMin + '–' + rec.fMax + ' Hz',
    ];
    if (rec.location) lines.push('Location: ' + formatLocation(rec.location), mapsUrl(rec.location));
    return lines.join('\n');
  }

  // One file holding many records (photos are not included: they are separate files)
  function exportAll(records, app) {
    return {
      schema: 'pyramid-resonance-export/1',
      exported: new Date().toISOString(),
      app: String(app || ''),
      count: records.length,
      measurements: records,
    };
  }

  // Longest side scaled down to `max`, never up; whole pixels
  function fitSize(width, height, max) {
    if (!(width > 0 && height > 0)) return { width: 0, height: 0 };
    const k = Math.min(1, max / Math.max(width, height));
    return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
  }

  /*
   * Raw sound as a WAV file: mono, 32-bit float, exactly the samples the microphone gave.
   * samples: Float32Array (or array of numbers). Returns an ArrayBuffer.
   */
  function encodeWav(samples, sampleRate) {
    const n = samples.length, rate = Math.round(sampleRate);
    const buf = new ArrayBuffer(58 + n * 4);
    const v = new DataView(buf);
    const text = (at, s) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
    text(0, 'RIFF'); v.setUint32(4, 50 + n * 4, true); text(8, 'WAVE');
    text(12, 'fmt '); v.setUint32(16, 18, true);
    v.setUint16(20, 3, true);            // 3 = IEEE float
    v.setUint16(22, 1, true);            // mono
    v.setUint32(24, rate, true);
    v.setUint32(28, rate * 4, true);     // bytes per second
    v.setUint16(32, 4, true);            // bytes per sample
    v.setUint16(34, 32, true);           // bits per sample
    v.setUint16(36, 0, true);            // no extension
    text(38, 'fact'); v.setUint32(42, 4, true); v.setUint32(46, n, true);
    text(50, 'data'); v.setUint32(54, n * 4, true);
    for (let i = 0; i < n; i++) v.setFloat32(58 + i * 4, Number.isFinite(samples[i]) ? samples[i] : 0, true);
    return buf;
  }

  // What a record says about its sound file
  function audioInfo(sampleCount, sampleRate) {
    const rate = Math.round(sampleRate);
    if (!(sampleCount > 0 && rate > 0)) return null;
    return { type: 'audio/wav', format: 'float32', sampleRate: rate, channels: 1, samples: sampleCount, durationS: round(sampleCount / rate, 3) };
  }

  return { SCHEMA, encodeWav, audioInfo, cleanLocation, betterFix, makeRecord, localParts, fileBase, formatLocation, mapsUrl, peakSummary, shareText, exportAll, fitSize };
});
