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
      kind: input.kind === 'sweep' ? 'sweep' : input.kind === 'voice' ? 'voice' : 'clap',     // 'voice': a spoken note for the session, not a measurement
      note: String(input.note || '').trim().slice(0, 200),                 // about this one measurement
      sessionNote: String(input.sessionNote || '').trim().slice(0, 1000),  // the place or subject of the whole session, or a longer description of it
      // picked from a short set of values instead of typed each time:
      spot: String(input.spot || '').trim().slice(0, 60),                 // where in the place the phone was ("saddle", "window sill")
      direction: String(input.direction || '').trim().slice(0, 60),       // which way it pointed or lay
      // Stable identities, so that links survive when names are edited or this format grows:
      uuid: isUuid(input.uuid) ? input.uuid : uuid(),                    // this measurement
      sessionId: isUuid(input.sessionId) ? input.sessionId : null,       // the session it was made in
      placeId: isUuid(input.placeId) ? input.placeId : null,             // the place, whatever it is called now
      positionId: isUuid(input.positionId) ? input.positionId : null,    // measurements made without moving the phone share one (from the motion sensor; null without it)
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
      interrupted: !!input.interrupted,   // cut short (Stop, microphone lost, app left): what was recorded up to then
      disturbed: !!input.disturbed,       // the volume was changed during a sweep
      audioMissing: !!input.audioMissing, // a clap whose sound could not be recorded or stored
      sentAt: null,                       // ISO time of the last successful Send, else null: no copy outside the phone yet
      motion: cleanMotion(input.motion),  // how the phone lay and whether it had moved, from its motion sensor; null if not available
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

  const slugOf = (text, max) => String(text || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');

  // File name stem shared by a record's data, chart, photo and sound, so they sort together.
  // The date and time come first and the whole stem is short, because a phone's file list
  // shows only the first twenty-odd characters: "2026-11-23_120106_clap".
  function fileBase(rec) {
    const p = localParts(rec), slug = slugOf(rec.spot || rec.note, 16);     // short: a long name pushes the time out of sight
    return p.date + '_' + p.compact + '_' + (rec.kind === 'sweep' ? 'sweep' : rec.kind === 'voice' ? 'voice' : 'clap') + (slug ? '_' + slug : '');
  }

  // ---------- the phone's position, from its motion sensor ----------
  const mnum = (x, digits) => (typeof x === "number" && Number.isFinite(x) ? Number(x.toFixed(digits == null ? 2 : digits)) : null);
  // Angle in degrees between two 3-vectors; null if either has no length
  function angleDeg(a, b) {
    if (!a || !b) return null;
    const la = Math.hypot(a[0], a[1], a[2]), lb = Math.hypot(b[0], b[1], b[2]);
    if (!(la > 0) || !(lb > 0)) return null;
    const c = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb);
    return Math.acos(Math.max(-1, Math.min(1, c))) * 180 / Math.PI;
  }
  // How a phone lies, in words, from the direction of gravity in its own axes
  // (x to the right of the screen, y to its top, z out of the screen towards the viewer; g points down).
  function poseName(g) {
    if (!g) return 'unknown';
    const n = Math.hypot(g[0], g[1], g[2]);
    if (!(n > 0)) return 'unknown';
    const x = g[0] / n, y = g[1] / n, z = g[2] / n;
    if (z < -0.94) return 'flat, screen up';
    if (z > 0.94) return 'flat, screen down';
    if (y < -0.94) return 'upright';
    if (y > 0.94) return 'upside down';
    // gravity points to the edge the phone rests on
    if (x < -0.94) return 'on its left edge';
    if (x > 0.94) return 'on its right edge';
    const tilt = Math.round(Math.acos(Math.max(-1, Math.min(1, -z))) * 180 / Math.PI);
    return 'tilted ' + tilt + '° from flat';
  }
  // Has the phone been moved between two measurements? prev, cur: { gravity: [x, y, z] } of each;
  // betweenMs: the longest unbroken stretch for which it was clearly in motion in between (a tap on the screen is only a blink).
  // Returns { moved, angleDeg }. A phone turned about the vertical keeps its gravity direction, so the time in motion counts too.
  const MOVED_ANGLE_DEG = 4, MOVED_MS = 500;
  function movedSince(prev, cur, betweenMs) {
    if (!prev || !cur || !prev.gravity || !cur.gravity) return { moved: null, angleDeg: null };
    const a = angleDeg(prev.gravity, cur.gravity);
    return { moved: (a != null && a > MOVED_ANGLE_DEG) || (Number(betweenMs) || 0) >= MOVED_MS, angleDeg: a == null ? null : mnum(a, 1) };
  }
  function cleanMotion(m) {
    // this is a note beside a measurement: whatever is wrong with it, it must never stop the measurement being saved
    try { return cleanMotionUnsafe(m); } catch (e) { return null; }
  }
  function cleanMotionUnsafe(m) {
    if (!m || !Array.isArray(m.gravity) || m.gravity.length !== 3 || !m.gravity.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
    return {
      gravity: m.gravity.map((v) => mnum(v, 3)),                 // m/s², direction of "down" in the phone's axes, averaged over the measurement
      pose: poseName(m.gravity),
      headingDeg: mnum(m.headingDeg, 0),                         // compass direction the top of the phone points to, if the phone gave one
      movedSincePrevious: m.movedSincePrevious === true ? true : m.movedSincePrevious === false ? false : null,
      angleFromPreviousDeg: mnum(m.angleFromPreviousDeg, 1),
      inMotionBeforeMs: mnum(m.inMotionBeforeMs, 0),             // longest unbroken stretch clearly in motion since the previous measurement
      inMotionDuringMs: mnum(m.inMotionDuringMs, 0),             // ... and during this one
      shakeRms: mnum(m.shakeRms, 3),                             // m/s², acceleration without gravity, during the measurement
      turnRms: mnum(m.turnRms, 2),                               // degrees per second, during the measurement
      samples: mnum(m.samples, 0), rateHz: mnum(m.rateHz, 0),
    };
  }

  // A random RFC 4122 version 4 identifier
  function uuid() {
    const c = typeof crypto !== 'undefined' ? crypto : null;
    if (c && c.randomUUID) return c.randomUUID();
    const b = new Uint8Array(16);
    if (c && c.getRandomValues) c.getRandomValues(b); else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => (x + 256).toString(16).slice(1)).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  const isUuid = (x) => typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);

  // Measurements are made in sessions: a run of them with no pause longer than gapMin minutes.
  // Takes records in any order; returns sessions newest first, each with its records newest first.
  function sessions(records, gapMin) {
    const gap = (gapMin == null ? 30 : gapMin) * 60000;
    const sorted = records.slice().sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
    const out = [], byId = {};
    let cur = null, last = 0;
    sorted.forEach((rec) => {
      // a record that knows its session goes there; older records without one are grouped by the pauses
      if (rec.sessionId) {
        if (!byId[rec.sessionId]) { byId[rec.sessionId] = { records: [], id: rec.sessionId }; out.push(byId[rec.sessionId]); }
        byId[rec.sessionId].records.push(rec);
        return;
      }
      const t = new Date(rec.time).getTime();
      if (!cur || t - last > gap) { cur = { records: [], id: null }; out.push(cur); }
      cur.records.push(rec);
      last = t;
    });
    out.sort((a, b) => (a.records[0].time < b.records[0].time ? -1 : 1));
    out.forEach((s) => {
      const first = s.records[0], end = s.records[s.records.length - 1];
      // the note most of its records carry is the session's note
      const count = {};
      s.records.forEach((x) => { const n = x.sessionNote || ''; count[n] = (count[n] || 0) + 1; });
      s.note = Object.keys(count).sort((a, b) => count[b] - count[a] || (a < b ? -1 : 1))[0] || '';
      s.key = s.id || first.id;
      s.start = localParts(first); s.end = localParts(end);
      // a short note is a name and goes into the file name; a long one is a description and does not
      const slug = s.note.length <= 32 ? slugOf(s.note, 24) : '';
      const measured = s.records.filter((x) => x.kind !== 'voice').length;
      // "2026-11-23_1200_bike-cellar_14-measurements"
      s.fileBase = s.start.date + '_' + s.start.compact.slice(0, 4) + (slug ? '_' + slug : '') + '_' + measured + '-measurement' + (measured === 1 ? '' : 's');
      s.records.reverse();
    });
    return out.reverse();
  }

  // File ending for a recorded sound, by its type (a clap is WAV; a voice note is whatever the phone's recorder makes)
  function soundExt(type) {
    const t = String(type || '').toLowerCase();
    if (t.indexOf('wav') >= 0) return '.wav';
    if (t.indexOf('mp4') >= 0 || t.indexOf('aac') >= 0 || t.indexOf('m4a') >= 0) return '.m4a';
    if (t.indexOf('webm') >= 0) return '.webm';
    if (t.indexOf('ogg') >= 0) return '.ogg';
    return '.audio';
  }

  // ---------- one zip file out of many files ----------
  // Stored without compression (sound does not shrink anyway). files: [{ name, bytes: Uint8Array, time: Date }]
  let crcTable = null;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
    }
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function utf8(text) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text);
    return Uint8Array.from(Buffer.from(text, 'utf8'));
  }
  function zipStore(files) {
    const seen = {}, entries = files.map((f) => {
      // two files may not share a name inside one zip
      let name = String(f.name).replace(/[\\/]+/g, '_');
      if (seen[name]) { const dot = name.lastIndexOf('.'); name = (dot > 0 ? name.slice(0, dot) : name) + '_' + (++seen[name]) + (dot > 0 ? name.slice(dot) : ''); } else seen[name] = 1;
      const bytes = f.bytes instanceof Uint8Array ? f.bytes : new Uint8Array(f.bytes);
      const t = f.time instanceof Date && Number.isFinite(f.time.getTime()) ? f.time : new Date();
      return { name: utf8(name), bytes, crc: crc32(bytes),
        dosTime: (t.getHours() << 11) | (t.getMinutes() << 5) | (t.getSeconds() >> 1),
        dosDate: (Math.max(0, t.getFullYear() - 1980) << 9) | ((t.getMonth() + 1) << 5) | t.getDate() };
    });
    let size = 22;
    entries.forEach((e) => { size += 30 + e.name.length + e.bytes.length + 46 + e.name.length; });
    if (size > 0xFFFFFFF0 || entries.length > 0xFFF0) throw new Error('Too much for one zip file.');
    const out = new Uint8Array(size), v = new DataView(out.buffer);
    let at = 0;
    entries.forEach((e) => {
      e.offset = at;
      v.setUint32(at, 0x04034b50, true); v.setUint16(at + 4, 20, true); v.setUint16(at + 6, 0x0800, true); v.setUint16(at + 8, 0, true);
      v.setUint16(at + 10, e.dosTime, true); v.setUint16(at + 12, e.dosDate, true); v.setUint32(at + 14, e.crc, true);
      v.setUint32(at + 18, e.bytes.length, true); v.setUint32(at + 22, e.bytes.length, true);
      v.setUint16(at + 26, e.name.length, true); v.setUint16(at + 28, 0, true);
      out.set(e.name, at + 30); out.set(e.bytes, at + 30 + e.name.length);
      at += 30 + e.name.length + e.bytes.length;
    });
    const dirStart = at;
    entries.forEach((e) => {
      v.setUint32(at, 0x02014b50, true); v.setUint16(at + 4, 20, true); v.setUint16(at + 6, 20, true); v.setUint16(at + 8, 0x0800, true); v.setUint16(at + 10, 0, true);
      v.setUint16(at + 12, e.dosTime, true); v.setUint16(at + 14, e.dosDate, true); v.setUint32(at + 16, e.crc, true);
      v.setUint32(at + 20, e.bytes.length, true); v.setUint32(at + 24, e.bytes.length, true);
      v.setUint16(at + 28, e.name.length, true);
      v.setUint32(at + 42, e.offset, true);
      out.set(e.name, at + 46);
      at += 46 + e.name.length;
    });
    v.setUint32(at, 0x06054b50, true); v.setUint16(at + 8, entries.length, true); v.setUint16(at + 10, entries.length, true);
    v.setUint32(at + 12, at - dirStart, true); v.setUint32(at + 16, dirStart, true);
    return out;
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
      'Resonance measurement (' + rec.kind + '), ' + p.date + ' ' + p.time + (rec.sessionNote ? ', ' + rec.sessionNote : '') + (rec.note ? ', ' + rec.note : ''),
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

  return { SCHEMA, encodeWav, audioInfo, cleanLocation, betterFix, makeRecord, localParts, fileBase, formatLocation, mapsUrl, peakSummary, shareText, exportAll, fitSize, sessions, zipStore, crc32, uuid, isUuid, angleDeg, poseName, movedSince, cleanMotion, soundExt };
});
