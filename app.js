/* PyramidResonance v2: single tones, sweep and microphone measurement. Maths lives in modes.js. */
(function () {
    'use strict';

    const M = window.Modes;
    const R = window.Records;
    const $ = (id) => document.getElementById(id);

    // Must equal VERSION in sw.js (a test checks it). Change both for every release:
    // the new sw.js is what makes phones fetch the new files, all at once.
    const BUILD = '2.8.0';
    const RELEASED = '2026-11-26T12:01:00Z';   // when this version was published; the same value is in sw.js
    const MATCH_TOL = 1.5;    // percent: how close a measured peak must be to a listed mode

    // Registering the service worker and reloading into a new version is done by the small
    // script in index.html, so that a release with a broken app.js can still be replaced.
    // It asks this script whether a reload would cost the user something (updater.busy, set at the very end).
    const updater = window.PyramidUpdate || null;

    // ---------- Settings ----------
    const MAX_MODES = 6000;   // refuse ranges that would compute more than this
    const MAX_LISTED = 400;   // buttons in the tone list
    const DEFAULTS = { room: 'khufu', L: 5, W: 4, H: 2.5, temp: 20, fMin: 60, fMax: 250, volume: 0.5, filter: 'axial', sweepDur: 60, speaker: 'bt', tab: 'measure' };
    const LIMITS = { L: [0.5, 100], W: [0.5, 100], H: [0.5, 100], temp: [-20, 50], fMin: [10, 2000], fMax: [20, 4000], volume: [0, 1] };
    const CHOICES = { room: ['khufu', 'khafre', 'menkaure', 'custom'], filter: ['axial', 'tangential', 'all'], sweepDur: [30, 60, 120], speaker: ['bt', 'direct'], tab: ['measure', 'play', 'saved', 'setup'] };
    const settings = Object.assign({}, DEFAULTS);

    // Force every setting into its allowed range, whatever was typed or stored
    function sanitize(s) {
        for (const k of Object.keys(LIMITS)) {
            const v = Number(s[k]);
            s[k] = Number.isFinite(v) ? Math.min(LIMITS[k][1], Math.max(LIMITS[k][0], v)) : DEFAULTS[k];
        }
        for (const k of Object.keys(CHOICES)) {
            if (!CHOICES[k].includes(s[k])) s[k] = DEFAULTS[k];
        }
        return s;
    }
    try {
        const saved = JSON.parse(localStorage.getItem('pyramid-res-v2') || 'null');
        if (saved && typeof saved === 'object') {
            for (const k of Object.keys(DEFAULTS)) if (k in saved) settings[k] = saved[k];
        }
    } catch (e) { /* storage unavailable: defaults are fine */ }
    sanitize(settings);
    function save() {
        try { localStorage.setItem('pyramid-res-v2', JSON.stringify(settings)); } catch (e) { /* ignore */ }
    }

    let modes = [];       // every predicted mode in range
    let shown = [];       // modes after the filter, as listed
    let activeIdx = -1;   // index into shown of the playing tone
    let lastIdx = -1;     // stepper position; survives Stop

    function roomDims() {
        if (settings.room !== 'custom' && M.ROOMS[settings.room]) {
            const r = M.ROOMS[settings.room];
            return { L: r.L, W: r.W, H: r.H };
        }
        return { L: settings.L, W: settings.W, H: settings.H };
    }

    const AXIS = ['length', 'width', 'height'];
    function describe(m) {
        if (m.type === 'axial') {
            const n = [m.nx, m.ny, m.nz];
            const i = n.findIndex((v) => v > 0);
            return AXIS[i] + ' ×' + n[i];
        }
        return m.type + ' ' + m.label;
    }
    function describeRow(m) {
        const all = [m].concat(m.also || []);
        return all.slice(0, 2).map(describe).join(' + ') + (all.length > 2 ? ' +' + (all.length - 2) + ' more' : '');
    }
    function noteText(f) {
        const n = M.noteName(f);
        return n.name + ' ' + (n.cents >= 0 ? '+' : '') + n.cents + '¢';
    }

    // Returns false when the range holds too many modes to compute; nothing is computed then
    function recompute() {
        const d = roomDims();
        const c = M.speedOfSound(settings.temp);
        let warn = '', ok = true;
        if (!(settings.fMax > settings.fMin)) warn = '"To Hz" must be higher than "From Hz".';
        const estimate = warn ? 0 : M.estimateModeCount(d.L, d.W, d.H, c, settings.fMin, settings.fMax);
        if (estimate > MAX_MODES) {
            warn = 'About ' + Math.round(estimate).toLocaleString() + ' modes in that range: too many. Lower "To Hz" or raise "From Hz".';
            ok = false;
        }
        modes = warn ? [] : M.roomModes(d.L, d.W, d.H, c, settings.fMin, settings.fMax);
        const filtered = modes.filter((m) => settings.filter === 'all' || m.type === 'axial' || (settings.filter === 'tangential' && m.type === 'tangential'));
        const merged = M.mergeClose(filtered);
        shown = merged.slice(0, MAX_LISTED);
        $('roomWarn').textContent = warn;
        const r = M.ROOMS[settings.room];
        $('roomNote').textContent = (r ? r.note + ' ' : '') + 'Speed of sound ' + c.toFixed(1) + ' m/s. ' +
            modes.length + ' modes in range, ' + shown.length + ' listed' +
            (merged.length > shown.length ? ' (the lowest ' + MAX_LISTED + ' of ' + merged.length + ')' : '') +
            (merged.length < filtered.length ? '. Modes that share a frequency are one row' : '') + '.';
        // the room is chosen on another tab: say which one these tones and this range belong to
        const roomName = $('room').options[Math.max(0, CHOICES.room.indexOf(settings.room))].textContent;
        const line = 'Room: ' + (settings.room === 'custom' ? d.L + ' × ' + d.W + ' × ' + d.H + ' m' : roomName) + ', ' + settings.fMin + '–' + settings.fMax + ' Hz. Change it in Setup.';
        document.querySelectorAll('.roomLine').forEach((el) => { el.textContent = line; });
        activeIdx = -1;
        lastIdx = -1;
        renderList();
        setButtons();
        drawChart();
        return ok;
    }

    // Built only when the mode list changes; taps just move the highlight
    function renderList() {
        const host = $('modeList');
        host.textContent = '';
        shown.forEach((m, i) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'mode';
            const f = document.createElement('b'); f.textContent = m.f.toFixed(1) + ' Hz';
            const n = document.createElement('span'); n.textContent = noteText(m.f);
            const t = document.createElement('span'); t.textContent = describeRow(m);
            b.append(f, n, t);
            b.addEventListener('click', () => playMode(i));
            host.appendChild(b);
        });
    }
    function setActive(idx) {
        const kids = $('modeList').children;
        if (activeIdx >= 0 && kids[activeIdx]) { kids[activeIdx].classList.remove('active'); kids[activeIdx].removeAttribute('aria-current'); }
        activeIdx = idx;
        if (idx >= 0 && kids[idx]) {
            kids[idx].classList.add('active');
            kids[idx].setAttribute('aria-current', 'true');
            // bring the row into view inside the list only: the page itself must not move under the finger
            const list = $('modeList'), row = kids[idx], top = row.offsetTop - list.offsetTop;
            if (top < list.scrollTop) list.scrollTop = top;
            else if (top + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + row.offsetHeight - list.clientHeight;
        }
    }

    function syncInputs() {
        const d = roomDims();
        const custom = settings.room === 'custom';
        $('room').value = settings.room;
        [['dimL', d.L], ['dimW', d.W], ['dimH', d.H]].forEach(([id, v]) => {
            $(id).value = (Math.round(v * 1000) / 1000).toString();
            $(id).disabled = !custom;
        });
        $('temp').value = settings.temp;
        $('fMin').value = settings.fMin;
        $('fMax').value = settings.fMax;
        $('volume').value = settings.volume;
        $('modeFilter').value = settings.filter;
        $('sweepDur').value = String(settings.sweepDur);
        $('speaker').value = settings.speaker;
    }

    // ---------- Audio output ----------
    let ctx = null;
    let volNode = null;   // one volume control for everything
    let voice = null;     // { osc, env, kind: 'tone' | 'sweep', f1, f2, t0, dur }
    let wakeLock = null;
    let wakePending = false;
    let lastVoiceStopMs = -1e9;
    let lastVoiceF = null;   // frequency of the tone that stopped last (null after a sweep)

    function setSessionType(type) {
        // Safari: lets Web Audio play with the silent switch on, and choose routing with the mic
        try { if (navigator.audioSession) navigator.audioSession.type = type; } catch (e) { /* not supported */ }
    }

    // Must be entered synchronously from a tap: the context is created and resumed before any await
    async function ensureCtx() {
        if (!ctx) {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) throw new Error('This browser has no Web Audio support.');
            ctx = new AC();
            volNode = ctx.createGain();
            volNode.gain.value = settings.volume;
            volNode.connect(ctx.destination);
            ctx.onstatechange = () => {
                if (ctx.state !== 'running' && (voice || clapBusy)) interrupted();
            };
        }
        if (ctx.state !== 'running') {
            let timer = null;
            const timeout = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Audio did not start. Tap again.')), 1500); });
            try { await Promise.race([ctx.resume(), timeout]); } finally { clearTimeout(timer); }
            if (ctx.state !== 'running') throw new Error('Audio did not start. Tap again.');
        }
        return ctx;
    }

    function interrupted() {
        stopAll();
        $('audioWarn').textContent = 'Audio was interrupted. Tap a tone or the sweep to start again.';
    }

    async function acquireWake() {
        if (!navigator.wakeLock || wakeLock || wakePending) return;
        wakePending = true;
        let sentinel = null;
        try { sentinel = await navigator.wakeLock.request('screen'); } catch (e) { sentinel = null; }
        wakePending = false;
        if (!sentinel) return;
        if (voice && !wakeLock) {
            wakeLock = sentinel;
            if (sentinel.addEventListener) sentinel.addEventListener('release', () => { if (wakeLock === sentinel) wakeLock = null; });
        } else {
            try { sentinel.release(); } catch (e) { /* ignore */ }
        }
    }
    function releaseWake() {
        const s = wakeLock;
        wakeLock = null;
        if (s) { try { s.release(); } catch (e) { /* ignore */ } }
    }

    function stopVoice() {
        const v = voice;
        voice = null;
        if (v && ctx) {
            lastVoiceStopMs = performance.now();
            lastVoiceF = v.kind === 'tone' ? v.f1 : null;
            const t = ctx.currentTime;
            try {
                v.env.gain.cancelScheduledValues(t);
                v.env.gain.setValueAtTime(v.env.gain.value, t);
                v.env.gain.linearRampToValueAtTime(0, t + 0.08);
                v.osc.stop(t + 0.1);
            } catch (e) { /* already stopped */ }
        }
        releaseWake();
    }

    // Throws if the browser refuses; callers show the message
    function startVoice(kind, f1, f2, dur) {
        stopVoice();
        const t = ctx.currentTime + 0.02;
        const osc = ctx.createOscillator();
        const env = ctx.createGain();   // fade in and out only; volume is volNode
        osc.type = 'sine';
        osc.frequency.setValueAtTime(f1, t);
        env.gain.setValueAtTime(0, t);
        env.gain.linearRampToValueAtTime(1, t + 0.08);
        osc.connect(env);
        env.connect(volNode);
        const v = { osc, env, kind, f1, f2, t0: t, dur };
        osc.onended = () => {
            try { osc.disconnect(); env.disconnect(); } catch (e) { /* ignore */ }
            if (voice === v) { voice = null; lastVoiceStopMs = performance.now(); lastVoiceF = null; onStopped(v); }
        };
        osc.start(t);
        if (kind === 'sweep') {
            osc.frequency.exponentialRampToValueAtTime(f2, t + dur);
            env.gain.setValueAtTime(1, t + dur);
            env.gain.linearRampToValueAtTime(0, t + dur + 0.08);
            osc.stop(t + dur + 0.1);
        }
        voice = v;
        acquireWake();
        return v;
    }

    function setNow(freqText, info) {
        $('nowFreq').textContent = freqText;
        $('nowInfo').textContent = info;
    }
    // Spoken by screen readers. Used for starts and stops only, never per sweep step.
    function say(text) { $('say').textContent = text; }

    function setButtons() {
        try { motionLine(); } catch (e) { /* the phone-position extra is not ready yet, or missing */ }
        try { voiceButton(); } catch (e) { /* not ready yet */ }
        const sweeping = !!(voice && voice.kind === 'sweep');
        $('stop').disabled = !voice;
        $('sweep').textContent = sweeping ? 'Stop sweep' : 'Start sweep';
        $('sweep').disabled = clapBusy;
        $('prev').disabled = $('next').disabled = shown.length === 0 || clapBusy;
        $('speaker').disabled = $('sweepDur').disabled = sweeping;
    }

    // Called when a voice has ended, by Stop or on its own
    function onStopped(v) {
        releaseWake();
        if (v && v.kind === 'sweep') finishSweep();
        setNow('–', 'Nothing playing');
        say('Stopped');
        setActive(-1);
        setButtons();
        drawChart();
    }

    async function playMode(i) {
        if (!shown.length || clapBusy) return;
        const idx = ((i % shown.length) + shown.length) % shown.length;
        const m = shown[idx];
        lastIdx = idx;   // before the await, so quick taps step on
        leaveViewing();
        try {
            await ensureCtx();
            if (clapBusy) return;
            if (voice && voice.kind === 'sweep') abortSweep();
            keepPartialSweep();      // a sweep being measured is saved before a tone replaces it
            startVoice('tone', m.f, m.f, 0);
        } catch (e) {
            onStopped(null);
            $('audioWarn').textContent = e && e.message ? e.message : 'Audio could not start.';
            return;
        }
        $('audioWarn').textContent = '';
        setActive(idx);
        setNow(m.f.toFixed(1) + ' Hz', noteText(m.f) + ' · ' + describeRow(m));
        say(m.f.toFixed(1) + ' hertz');
        setButtons();
        drawChart();
    }

    function stopAll() {
        const v = voice;
        stopVoice();
        if (v && v.kind === 'sweep') abortSweep();
        keepPartialSweep();
        recording = false;
        cancelClap();
        onStopped(null);
    }

    // ---------- Sweep ----------
    let curve = [];           // measured points [{ f, db }]
    let curveState = 'none';  // 'none' | 'done' (a finished measurement is on screen) | 'saved'
    let viewing = null;       // a saved record being shown in place of the live measurement
    let lastPeaks = [];       // the peaks in the table, as saved with a measurement
    let livePeaks = null;     // what showPeaks was last given, to redraw the table after viewing a saved record

    // Back from a saved record to whatever was measured last
    function leaveViewing() {
        if (!viewing) return;
        viewing = null;
        $('peaks').textContent = '';
        if (curveState !== 'none' && livePeaks) showPeaks(livePeaks);
    }
    let curveKind = '';       // 'sweep' | 'clap'
    let recording = false;    // this sweep is being measured
    let disturbed = false;    // volume was changed while recording
    let sweepTimer = null;
    let lastReadF = 0;

    function emittedFreq() {
        if (!voice || voice.kind !== 'sweep') return null;
        return M.sweepFreq(voice.f1, voice.f2, (ctx.currentTime - voice.t0) / voice.dur);
    }

    // Seconds between the context clock and the sound leaving the speaker
    function outputDelay() {
        const reported = (ctx.baseLatency || 0) + (ctx.outputLatency || 0);
        // Bluetooth speakers buffer about 0.2 s; browsers do not always report it
        return settings.speaker === 'bt' ? Math.max(reported, 0.2) : reported;
    }

    async function toggleSweep() {
        if (clapBusy) return;
        if (voice && voice.kind === 'sweep') { stopAll(); return; }
        if (!(settings.fMax > settings.fMin)) {
            $('audioWarn').textContent = 'Set "To Hz" higher than "From Hz" on the Setup tab first.';
            return;
        }
        leaveViewing();
        try {
            await ensureCtx();
            if (clapBusy) return;
            abortSweep();
            keepPartialSweep();      // never start over the top of an unsaved one
            try { voiceStop(); } catch (e) { /* an extra */ }
            recording = micOn;
            try { if (selected.size) { selected.clear(); syncBoxes(); } } catch (e) { /* an extra */ }
            if (recording) { try { motionBegin(1000); } catch (e) { /* an extra */ } }
            if (recording) { rawAudio = null; curve = []; curveState = 'none'; viewing = null; curveKind = 'sweep'; disturbed = false; sweepId = null; checkpointAt = 0; $('peaks').textContent = ''; }
            lastReadF = 0;
            setActive(-1);
            startVoice('sweep', settings.fMin, settings.fMax, settings.sweepDur);
        } catch (e) {
            recording = false;
            onStopped(null);
            $('audioWarn').textContent = e && e.message ? e.message : 'Audio could not start.';
            return;
        }
        $('audioWarn').textContent = '';
        say('Sweep started');
        sweepTimer = setInterval(sweepTick, 50);
        setButtons();
    }

    function sweepTick() {
        const f = emittedFreq();
        if (f == null) { abortSweep(); return; }
        setNow(f.toFixed(1) + ' Hz', 'Sweeping · ' + noteText(f));
        if (recording && micOn) {
            // The analyser sees the last windowS seconds, and the sound left the speaker late.
            // A reading therefore belongs to the tone emitted (window/2 + output delay) ago.
            const windowS = fast.fftSize / ctx.sampleRate;
            const out = outputDelay();
            const elapsed = ctx.currentTime - voice.t0;
            if (elapsed - out >= windowS) {
                const fr = M.sweepReadingFreq(voice.f1, voice.f2, voice.dur, elapsed, out + windowS / 2);
                if (fr != null && fr >= lastReadF * 1.004) {
                    fast.getFloatFrequencyData(fastSpectrum);
                    const binHz = ctx.sampleRate / fast.fftSize;
                    const smear = M.sweepRate(voice.f1, voice.f2, voice.dur, fr) * windowS / 2;
                    const db = M.bandLevelDb(fastSpectrum, binHz, fr, 3 + Math.ceil(smear / binHz));
                    if (db != null) { curve.push({ f: fr, db }); lastReadF = fr; checkpointSweep(); }
                }
            }
        }
        drawChart(f);
    }

    function abortSweep() {
        clearInterval(sweepTimer);
        sweepTimer = null;
    }

    function finishSweep() {
        abortSweep();
        const wasRecording = recording;
        recording = false;
        if (wasRecording && curveKind === 'sweep' && curve.length >= 1) {
            curveState = 'done';
            showPeaks(curve.length > 10 ? M.findPeaks(curve, 4) : []);
            autoSave(false);
        } else if (wasRecording) { showPeaks([]); saveNote('That sweep measured nothing, so there was nothing to save.'); }
    }

    // ---------- Microphone ----------
    let micOn = false;
    let micBusy = false;
    let micStream = null;
    let micSource = null;
    let fine = null, fineSpectrum = null;   // 32768 points: clap spectrum and level meter
    let fast = null, fastSpectrum = null;   // 8192 points: follows a gliding tone
    let meterTimer = null;
    let clapTimer = null;
    let clapBusy = false;
    let clapRun = 0;          // identifies one recording, so a cancelled one cannot carry on

    // Raw sound of a clap. A small tap node hands the microphone samples to the page, only
    // while a clap is being recorded. The sound is always stored with the measurement.
    let tap = null;           // { node, sink, start(), stop() }
    let rawChunks = null;     // blocks of samples while a clap is being recorded, else null
    let rawCount = 0;
    let rawAudio = null;      // { samples: Float32Array, sampleRate } of the clap on screen
    const RAW_MAX_S = 6;      // never keep more than this, whatever the timers do
    const TAP_SRC = "registerProcessor('pr-tap', class extends AudioWorkletProcessor {" +
        " constructor() { super(); this.on = false; this.port.onmessage = (e) => { this.on = !!e.data; }; }" +
        " process(inputs) { const ch = inputs[0] && inputs[0][0]; if (this.on && ch && ch.length) this.port.postMessage(ch.slice()); return true; } });";

    function tapBlock(block) {
        if (!rawChunks || !ctx || rawCount >= RAW_MAX_S * ctx.sampleRate) return;
        rawChunks.push(block);
        rawCount += block.length;
    }
    async function startTap(source) {
        let node = null, start = null, stop = null;
        try {
            if (ctx.audioWorklet && window.AudioWorkletNode) {
                if (!ctx.prTapModule) {
                    const url = URL.createObjectURL(new Blob([TAP_SRC], { type: 'application/javascript' }));
                    ctx.prTapModule = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
                }
                await ctx.prTapModule;
                node = new AudioWorkletNode(ctx, 'pr-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
                const port = node.port;
                port.onmessage = (e) => tapBlock(e.data);
                start = () => port.postMessage(true);
                stop = () => port.postMessage(false);
            }
        } catch (e) { node = null; ctx.prTapModule = null; }
        if (!node && ctx.createScriptProcessor) {
            // older browsers: the same thing on the main thread
            let on = false;
            node = ctx.createScriptProcessor(4096, 1, 1);
            node.onaudioprocess = (e) => { if (on) tapBlock(new Float32Array(e.inputBuffer.getChannelData(0))); };
            start = () => { on = true; };
            stop = () => { on = false; };
        }
        if (!node) return;
        if (micSource !== source) { try { node.disconnect(); } catch (e) { /* ignore */ } return; }   // microphone went off meanwhile
        // The node only runs while it leads to the output. It writes nothing there, and the
        // gain is zero as well: the microphone is never heard from the speaker.
        const sink = ctx.createGain();
        sink.gain.value = 0;
        source.connect(node); node.connect(sink); sink.connect(ctx.destination);
        tap = { node, sink, start, stop };
    }
    function stopTap() {
        rawChunks = null; rawCount = 0;
        if (!tap) return;
        try { tap.stop(); tap.node.disconnect(); tap.sink.disconnect(); } catch (e) { /* ignore */ }
        if (tap.node.port) tap.node.port.onmessage = null; else tap.node.onaudioprocess = null;
        tap = null;
    }
    function takeRaw() {
        const chunks = rawChunks, n = rawCount;
        rawChunks = null; rawCount = 0;
        if (tap) tap.stop();
        if (!chunks || !n || !ctx) return null;
        const samples = new Float32Array(n);
        let at = 0;
        chunks.forEach((c) => { samples.set(c, at); at += c.length; });
        return { samples, sampleRate: ctx.sampleRate };
    }

    // ---------- Voice notes ----------
    // A spoken note for the session: easier in the field than typing. It is recorded with the phone's own recorder
    // (small files), saved like a measurement (so it is never dropped: memory first, storage right after, retried),
    // listed with its session and sent in the session's zip.
    const voice1 = { rec: null, record: null, chunks: [], t0: 0, timer: null, mime: '', stopping: false, finishing: false, watch: null, cp: null, cpAt: 0, cpBusy: false, limit: false };
    const VOICE_MAX_S = 300;
    const voiceOk = () => typeof MediaRecorder !== 'undefined';
    const mmss = (secs) => { const s = Math.max(0, Math.round(secs)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
    function voiceButton() {
        const b = document.getElementById('voiceBtn');
        if (!b) return;
        if (!voiceOk()) { b.disabled = true; b.textContent = 'Voice notes are not possible on this phone'; return; }
        if (voice1.rec) b.textContent = voice1.stopping ? 'Saving the voice note…' : '■ Stop the voice note · ' + mmss(Math.floor((Date.now() - voice1.t0) / 1000));
        else b.textContent = '● Record a voice note for this session';
        b.setAttribute('aria-pressed', voice1.rec ? 'true' : 'false');
        b.disabled = voice1.rec ? voice1.stopping : (clapBusy || recording || micBusy || voice1.finishing);
    }
    const voiceSound = async (chunks) => {
        const blob = new Blob(chunks, { type: voice1.mime || chunks[0].type || 'audio/mp4' });
        return { type: (blob.type || 'audio/mp4').split(';')[0], buffer: await blob.arrayBuffer() };
    };
    // What has been said so far is written to the phone every few seconds, as a voice note marked "interrupted".
    // If the app is closed or killed in the middle, that copy is what is found on the Saved tab at the next start.
    function voiceCheckpoint(r) {
        if (voice1.rec !== r || voice1.stopping || voice1.finishing || voice1.cpBusy || !voice1.chunks.length) return;
        voice1.cpBusy = true; voice1.cpAt = Date.now();
        const rec = voice1.record, chunks = voice1.chunks.slice(), secs = (Date.now() - voice1.t0) / 1000;
        voice1.cp = (async () => {
            try {
                const s = await voiceSound(chunks);
                if (voice1.rec !== r || voice1.finishing) return;       // the finished note is being written: this copy must not replace it
                const copy = Object.assign({}, rec, { interrupted: true, audio: { type: s.type, format: 'recorder', durationS: Number(secs.toFixed(1)), bytes: s.buffer.byteLength } });
                await dbWrite(['records', 'audio'], (t) => { t.objectStore('audio').put({ type: s.type, buffer: s.buffer }, rec.id); return t.objectStore('records').put(copy); });
                voice1.cpOk = true;
            } catch (e) { /* the note is still held in memory and saved when it ends */ }
            voice1.cpBusy = false;
        })();
    }
    async function voiceToggle() {
        if (voice1.rec) { voiceStop(); return; }
        if (!voiceOk() || clapBusy || recording || voice1.finishing) return;
        $('micWarn').textContent = '';
        if (!micOn && !micBusy) { await toggleMic(); }
        if (!micOn || !micStream || voice1.rec) return;       // refused or failed: the reason is on the page
        try {
            const r = new MediaRecorder(micStream);
            syncSessionNote();
            voice1.chunks = []; voice1.t0 = Date.now(); voice1.mime = r.mimeType || ''; voice1.stopping = false; voice1.limit = false; voice1.cpAt = Date.now(); voice1.cpOk = false;
            voice1.record = R.makeRecord({ time: new Date(voice1.t0), kind: 'voice', sessionNote: $('saveNote').value, sessionId: currentSessionId(), placeId: placeIdFor($('saveNote').value),
                curve: [], peaks: [], app: BUILD, locationStatus: 'unavailable' });
            r.addEventListener('dataavailable', (e) => { if (e.data && e.data.size && voice1.rec === r) voice1.chunks.push(e.data); });
            r.addEventListener('stop', () => voiceFinish(r));
            r.addEventListener('error', () => voiceStop());
            r.start(1000);          // a piece every second, so that an abrupt end still leaves what was said
            voice1.rec = r;
            voice1.timer = setInterval(() => {
                voiceButton();
                if (Date.now() - voice1.t0 > VOICE_MAX_S * 1000) { voice1.limit = true; voiceStop(); }
                else if (Date.now() - voice1.cpAt > 5000) voiceCheckpoint(r);
            }, 500);
        } catch (e) {
            voice1.rec = null;
            $('micWarn').textContent = 'The voice note could not start: ' + (e && e.message ? e.message : 'recorder error') + '.';
        }
        voiceButton();
    }
    // Stopping waits for the recorder to hand over its last piece; if it never answers, what there is is saved anyway
    function voiceStop() {
        const r = voice1.rec;
        if (!r || voice1.stopping) return;
        voice1.stopping = true;
        try { if (r.state !== 'inactive') r.stop(); } catch (e) { /* the watchdog below saves what there is */ }
        voice1.watch = setTimeout(() => voiceFinish(r), 1500);
        voiceButton();
    }
    async function voiceFinish(r) {
        if (voice1.rec !== r || voice1.finishing) return;
        voice1.finishing = true;        // counts as busy until the note is in the list
        clearTimeout(voice1.watch); voice1.watch = null;
        clearInterval(voice1.timer); voice1.timer = null;
        const chunks = voice1.chunks, rec = voice1.record, secs = (Date.now() - voice1.t0) / 1000, limit = voice1.limit;
        try {
            if (voice1.cp) { try { await voice1.cp; } catch (e) { /* ignore */ } }
            if (!chunks.length) { saveNote('The voice note recorded nothing, so there was nothing to save.', true); return; }
            let s = null;
            try { s = await voiceSound(chunks); }
            catch (e) { saveNote('The voice note could not be put together (' + (e && e.message ? e.message : 'error') + '). ' + (voice1.cpOk ? 'The copy written while recording is on the Saved tab after the app is opened again.' : ''), true); return; }
            // a new session started while speaking: the note stays with the session and description it was started in
            if (currentSessionId() === rec.sessionId) {
                syncSessionNote();
                rec.sessionNote = $('saveNote').value.trim().slice(0, NOTE_MAX);
                rec.placeId = placeIdFor(rec.sessionNote);
            }
            rec.audio = { type: s.type, format: 'recorder', durationS: Number(secs.toFixed(1)), bytes: s.buffer.byteLength };
            saved.unshift(rec);
            saved.sort((a, b) => (a.time < b.time ? 1 : -1));
            unstored.add(rec);
            memAudio.set(rec.id, s.buffer);
            forgetPrepared(rec);
            voice1.rec = null; voice1.record = null; voice1.chunks = []; voice1.stopping = false;
            renderSaved();
            const ok = await storeRecord(rec);
            renderSaved();
            tabMarks();
            const len = mmss(secs);
            saveNote(ok ? 'Voice note saved (' + len + ')' + (limit ? ': it was stopped at the longest length of ' + mmss(VOICE_MAX_S) + ', start another to go on' : '') + '. It is with this session on the Saved tab and goes into the session\'s zip.'
                : 'The voice note (' + len + ') is NOT STORED on the phone (' + storeError + '). It is held only while the app stays open: send the session now. The app keeps trying to store it.', !ok || limit);
        } finally {
            if (voice1.rec === r) { voice1.rec = null; voice1.record = null; voice1.chunks = []; }
            voice1.stopping = false; voice1.finishing = false; voice1.cp = null; voice1.cpBusy = false;
            voiceButton();
        }
    }

    // ---------- Motion sensor ----------
    // The phone's own motion sensor tells how the phone lay during a measurement and whether it was moved since
    // the previous one. It is a note beside the measurement, never a condition for it: without the sensor, or
    // without permission, measurements are made and saved exactly the same.
    const motion = { status: 'off', listening: false, measuring: false, n: 0, g: [0, 0, 0], lin2: 0, rot2: 0, t0: 0, tLast: 0, skipUntil: 0,
        run: 0, betweenMs: 0, duringMs: 0, heading: null, last: null, prev: null, prevPlace: null, seen: 0 };
    const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    function onMotion(e) {
        const a = e.accelerationIncludingGravity;
        if (!a || a.x == null || a.y == null || a.z == null) return;
        motion.seen++;
        if (motion.status !== 'on') { motion.status = 'on'; motionLine(); }
        const now = performance.now();
        // a gap in the reports (phone locked, app in the background) hides whatever happened meanwhile:
        // nothing can then be said about "the same position as before"
        if (motion.tLast && now - motion.tLast > 1000) { motion.prev = null; motion.run = 0; }
        const dt = motion.tLast ? Math.min(100, now - motion.tLast) : 0;
        motion.tLast = now;
        // iPhones report the pull of gravity itself; other phones report the opposite (the push of the table)
        const sign = IOS ? 1 : -1;
        const g = [a.x * sign, a.y * sign, a.z * sign];
        const l = e.acceleration, r = e.rotationRate;
        const lin = l && l.x != null ? Math.hypot(l.x, l.y || 0, l.z || 0) : 0;                        // m/s² without gravity
        const rot = r && r.alpha != null ? Math.hypot(r.alpha, r.beta || 0, r.gamma || 0) : 0;         // degrees per second
        motion.last = g;
        const moving = rot > 25 || lin > 1.2;       // clearly being handled, not just resting
        // what counts is the longest unbroken stretch of motion: taps on the screen are many short ones
        motion.run = moving ? motion.run + dt : 0;
        if (!moving) motion.run0 = 0;
        if (motion.measuring) {
            motion.n++;
            motion.g[0] += g[0]; motion.g[1] += g[1]; motion.g[2] += g[2];
            motion.lin2 += lin * lin; motion.rot2 += rot * rot;
            if (now >= motion.skipUntil && motion.run - (motion.run0 || 0) > motion.duringMs) motion.duringMs = motion.run - (motion.run0 || 0);
        } else if (motion.run > motion.betweenMs) motion.betweenMs = motion.run;
    }
    function onHeading(e) {
        const h = typeof e.webkitCompassHeading === 'number' ? e.webkitCompassHeading : (e.absolute && typeof e.alpha === 'number' ? (360 - e.alpha) % 360 : null);
        if (h != null && Number.isFinite(h)) motion.heading = h;
    }
    function motionLine() {
        const text = { off: motion.listening ? 'Phone position: waiting for the motion sensor…' : 'Phone position: not being noted. Tap the button to let the app use the motion sensor.', asking: 'Phone position: waiting for your answer…',
            on: 'Phone position: on. Each measurement notes how the phone lay and whether it was moved since the previous one.',
            denied: 'Phone position: the motion sensor is not allowed. Measurements are saved as usual, without it. To allow it, close the app completely, open it again and answer "Allow".',
            none: 'Phone position: this device gives no motion data. Measurements are saved as usual, without it.' }[motion.status];
        // (an older copy of the page may lack these lines: the sensor is an extra and must never stop anything else)
        const line = document.getElementById('motionLine'), line2 = document.getElementById('motionLine2');
        const ask = document.getElementById('motionAsk'), ask2 = document.getElementById('motionAsk2');
        if (line) line.textContent = text;
        // beside the microphone: one short line and a button that keep their place whether shown or not, so nothing below jumps
        if (line2) line2.textContent = { off: motion.listening ? 'Phone position: waiting for the motion sensor…' : 'Phone position: not being noted.', asking: 'Phone position: waiting for your answer…',
            on: 'Phone position: noted with each measurement.', denied: 'Phone position: sensor not allowed (see Setup).', none: 'Phone position: no motion sensor here.' }[motion.status];
        const done = motion.status === 'on' || motion.status === 'none' || motion.status === 'asking';
        if (ask) ask.hidden = done;
        if (ask2) {     // offered beside the microphone once that is on, never in the same tap
            const show = !done && micOn;
            ask2.style.visibility = show ? 'visible' : 'hidden';
            ask2.disabled = !show;
        }
    }
    // Must be called straight from a tap: an iPhone only shows its permission question then.
    function motionListen() {
        if (motion.listening) return;
        motion.listening = true;
        window.addEventListener('devicemotion', onMotion);
        window.addEventListener('deviceorientation', onHeading);
        window.addEventListener('deviceorientationabsolute', onHeading);
        // a device with no sensor never sends an event
        setTimeout(() => { if (!motion.seen && motion.status !== 'denied' && motion.status !== 'asking') { motion.status = 'none'; motionLine(); } }, 3000);
    }
    // At start the sensor is switched on without anyone having to think of it. Where the phone wants to ask first
    // (an iPhone, once per fresh start, and only in answer to a tap), one "Tap to start" screen provides that tap
    // before any measuring begins. Whatever the answer, and whatever goes wrong here, the app works as usual.
    function motionAuto() {
        if (typeof DeviceMotionEvent === 'undefined') { motion.status = 'none'; motionLine(); return; }
        if (typeof DeviceMotionEvent.requestPermission !== 'function') { motionListen(); return; }      // no question to ask
        const gate = () => {
            const g = document.getElementById('startGate');
            if (!g) return;
            const go = () => { try { motionEnable(); } catch (e) { /* an extra */ } g.hidden = true; };
            const skip = document.getElementById('gateSkip');
            if (skip) skip.addEventListener('click', (e) => { e.stopPropagation(); g.hidden = true; motionLine(); });
            g.addEventListener('click', go);
            document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !g.hidden) { g.hidden = true; motionLine(); } });
            g.hidden = false;
            try { g.focus(); } catch (e) { /* ignore */ }
        };
        let asked;
        // without a tap this only succeeds when the answer was already given since the app was last started
        try { asked = DeviceMotionEvent.requestPermission(); } catch (e) { gate(); return; }
        Promise.resolve(asked).then((answer) => {
            motion.status = answer === 'granted' ? 'off' : 'denied';
            motionListen();
            motionLine();
        }, gate);
    }
    function motionEnable() {
        if (motion.status === 'asking' || (motion.listening && motion.status !== 'denied')) return;     // after a refusal the question can be put again
        const listen = motionListen;
        try {
            if (typeof DeviceMotionEvent === 'undefined') { motion.status = 'none'; motionLine(); return; }
            if (typeof DeviceMotionEvent.requestPermission === 'function') {
                motion.status = 'asking'; motionLine();
                DeviceMotionEvent.requestPermission().then((answer) => {
                    // listening costs nothing and is harmless when nothing comes; the first report that does come turns the status to "on"
                    motion.status = answer === 'granted' ? 'off' : 'denied';
                    listen();
                    motionLine();
                    // the compass has its own question on some versions; it is the same answer on most
                    try { if (answer === 'granted' && typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') DeviceOrientationEvent.requestPermission().catch(() => {}); } catch (e) { /* ignore */ }
                }, () => { motion.status = 'denied'; listen(); motionLine(); });
            } else listen();
        } catch (e) { motion.status = 'none'; motionLine(); }
    }
    // skipMs: the start of a sweep is a tap on the screen, which must not count as moving during it
    function motionBegin(skipMs) {
        if (motion.measuring && motion.duringMs > motion.betweenMs) motion.betweenMs = motion.duringMs;    // one that ended without being saved
        motion.measuring = true;
        motion.run0 = motion.run;       // handling that began before this measurement is not "during" it
        motion.skipUntil = performance.now() + (skipMs || 0);
        motion.n = 0; motion.g = [0, 0, 0]; motion.lin2 = 0; motion.rot2 = 0; motion.duringMs = 0;
        motion.t0 = performance.now();
    }
    // The phone's position for the measurement just ended, or null without sensor data
    function motionEnd(place) {
        if (!motion.measuring) return null;
        motion.measuring = false;
        if (motion.prevPlace !== place) motion.prev = null;      // another place: there is no "previous position" to compare with
        motion.prevPlace = place;
        const n = motion.n;
        // a very short measurement may have caught no report: the latest one is used then
        const gravity = n ? motion.g.map((v) => v / n) : motion.last;
        if (!gravity) return null;
        const cur = { gravity };
        const since = R.movedSince(motion.prev, cur, motion.betweenMs);
        const secs = (performance.now() - motion.t0) / 1000;
        const out = { gravity, headingDeg: motion.heading, movedSincePrevious: since.moved, angleFromPreviousDeg: since.angleDeg,
            inMotionBeforeMs: motion.prev ? motion.betweenMs : null, inMotionDuringMs: motion.duringMs,
            shakeRms: n ? Math.sqrt(motion.lin2 / n) : null, turnRms: n ? Math.sqrt(motion.rot2 / n) : null, samples: n, rateHz: n && secs > 0 ? n / secs : null };
        motion.prev = cur;
        motion.betweenMs = motion.duringMs;     // moving during this one counts as moved before the next
        return out;
    }

    async function toggleMic() {
        if (micBusy) return;
        if (micOn) { micOff(); return; }
        $('micWarn').textContent = '';
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            $('micWarn').textContent = 'No microphone access in this browser. It needs https and a recent browser.';
            return;
        }
        micBusy = true;
        $('mic').disabled = true;
        let stream = null;
        try {
            setSessionType('play-and-record');
            await ensureCtx();
            stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
            });
            micStream = stream;
            micSource = ctx.createMediaStreamSource(stream);
            fine = ctx.createAnalyser(); fine.fftSize = 32768; fine.smoothingTimeConstant = 0;
            fast = ctx.createAnalyser(); fast.fftSize = 8192; fast.smoothingTimeConstant = 0;
            fineSpectrum = new Float32Array(fine.frequencyBinCount);
            fastSpectrum = new Float32Array(fast.frequencyBinCount);
            micSource.connect(fine);   // analysis only: never routed to the speaker
            micSource.connect(fast);
            // without the tap a clap is still measured, but its sound cannot be kept: say so now, not afterwards
            startTap(micSource).catch(() => {}).then(() => { if (micStream === stream && !tap) $('micWarn').textContent = 'This phone is not giving the app the raw sound right now: claps will be saved WITHOUT their sound. Turn the microphone off and on to try again.'; });
            stream.getTracks().forEach((t) => { t.onended = () => { if (micStream === stream) micOff('The microphone was taken away by the system.'); }; });
            micOn = true;
            // the phone-position extra: where no question has to be asked it simply starts; otherwise its button is shown now
            try { motionLine(); } catch (e) { /* an extra */ }
            $('mic').textContent = 'Turn microphone off';
            $('mic').classList.add('on');
            meterTimer = setInterval(meterTick, 100);
        } catch (e) {
            if (stream) stream.getTracks().forEach((t) => t.stop());
            micOff('Microphone not available: ' + (e && e.message ? e.message : e));
        }
        micBusy = false;
        $('mic').disabled = false;
        setClapButton();
    }

    function micOff(message) {
        clearInterval(meterTimer); meterTimer = null;
        cancelClap();
        stopTap();
        keepPartialSweep();
        try { voiceStop(); } catch (e) { /* an extra */ }       // what was said so far is saved
        recording = false;
        if (micSource) { try { micSource.disconnect(); } catch (e) { /* ignore */ } }
        if (micStream) micStream.getTracks().forEach((t) => { t.onended = null; t.stop(); });
        micSource = null; micStream = null; fine = null; fast = null; fineSpectrum = null; fastSpectrum = null;
        micOn = false;
        setSessionType('playback');
        $('mic').textContent = 'Turn microphone on';
        $('mic').classList.remove('on');
        $('meterBar').style.width = '0';
        $('meterText').textContent = 'Microphone off';
        $('micWarn').textContent = message || '';
        setClapButton();
        setButtons();
    }

    function setClapButton(text) {
        $('clap').disabled = clapBusy || micBusy;       // with the microphone off, the tap turns it on first
        $('clap').textContent = text || clapLabel();
    }

    function meterTick() {
        if (!micOn || !ctx) return;
        if (ctx.state !== 'running') {
            // the analyser returns its last frame for ever while paused: do not show it as live
            $('meterBar').style.width = '0';
            $('meterText').textContent = 'Audio is paused. Tap a tone, or turn the microphone off and on.';
            return;
        }
        const binHz = ctx.sampleRate / fine.fftSize;
        fine.getFloatFrequencyData(fineSpectrum);
        let db = null, label = 'loudest in range';
        if (voice && voice.kind === 'tone') {
            db = M.bandLevelDb(fineSpectrum, binHz, voice.f1, 3);
            label = 'at ' + voice.f1.toFixed(1) + ' Hz';
        } else {
            let best = -Infinity;
            const k0 = Math.max(1, Math.floor(settings.fMin / binHz));
            const k1 = Math.min(fineSpectrum.length - 1, Math.ceil(settings.fMax / binHz));
            for (let k = k0; k <= k1; k++) if (fineSpectrum[k] > best) best = fineSpectrum[k];
            db = Number.isFinite(best) ? best : null;
        }
        if (db == null) { $('meterText').textContent = 'Listening…'; return; }
        const pct = Math.max(0, Math.min(100, (db + 100) / 80 * 100)); // -100..-20 dB
        $('meterBar').style.width = pct + '%';
        $('meterText').textContent = db.toFixed(1) + ' dB ' + label;
    }

    let clapFinish = null;    // set while a clap is being recorded: ends it and saves what there is
    function cancelClap(message) {
        if (!clapBusy) return;
        clapRun++;
        const salvage = clapFinish;
        clapFinish = null;
        if (salvage) salvage(true);          // recording had begun: keep the sound and spectrum so far
        else {
            clearInterval(clapTimer); clapTimer = null;
            clapBusy = false;
            rawChunks = null; rawCount = 0;
        }
        if (tap) tap.stop();
        if (message) $('micWarn').textContent = message;
        setClapButton();
        setButtons();
    }

    async function recordClap() {
        if (!micOn || clapBusy || micBusy) return;
        try { voiceStop(); } catch (e) { /* an extra */ }
        // ticks end with the tap that starts a measurement, not some seconds later when the recording begins
        try { if (selected.size) { selected.clear(); syncBoxes(); } } catch (e) { /* an extra */ }
        if (!(settings.fMax > settings.fMin)) {
            $('micWarn').textContent = 'Set "To Hz" higher than "From Hz" on the Setup tab first.';
            return;
        }
        if (voice) stopAll();
        leaveViewing();
        clapBusy = true;
        const run = ++clapRun;
        $('micWarn').textContent = '';
        setClapButton('Wait…');
        setButtons();
        try {
            await ensureCtx();   // audio may have been paused by a call or the lock screen
        } catch (e) {
            if (run === clapRun) cancelClap(e && e.message ? e.message : 'Audio could not start.');
            return;
        }
        if (run !== clapRun || !micOn || !fine) { if (run === clapRun) cancelClap(); return; }

        const binHz = ctx.sampleRate / fine.fftSize;
        const fastBinHz = ctx.sampleRate / fast.fftSize;
        const k0 = Math.max(1, Math.floor(settings.fMin / binHz));
        const k1 = Math.min(fineSpectrum.length - 1, Math.ceil(settings.fMax / binHz));
        const hold = new Float32Array(Math.max(1, k1 - k0 + 1)).fill(-Infinity);
        // A tone that was just playing must ring out and leave the analyser's window first.
        // A stone room can ring for seconds, so after the minimum wait keep waiting (up to
        // 10 s) while the level at that tone's frequency is still falling.
        const oldF = performance.now() - lastVoiceStopMs < 15000 ? lastVoiceF : null;
        const minStart = Math.max(performance.now() + 900, lastVoiceStopMs + 2500);
        const maxStart = Math.max(minStart, lastVoiceStopMs + 10000);
        const levels = [];
        let startMs = null;
        clapTimer = setInterval(() => {
            const now = performance.now();
            if (!micOn || !fine) { cancelClap(); return; }
            if (ctx.state !== 'running') { cancelClap('Audio was interrupted. Tap "Record a clap" again.'); return; }
            if (startMs == null) {
                let settled = true;
                if (oldF != null) {
                    fast.getFloatFrequencyData(fastSpectrum);
                    const db = M.bandLevelDb(fastSpectrum, fastBinHz, oldF, 3);
                    levels.push(db == null ? -200 : db);
                    const n = levels.length;
                    if (n >= 12) {
                        const mean = (arr) => arr.reduce((x, y) => x + y, 0) / arr.length;
                        settled = mean(levels.slice(n - 6)) >= mean(levels.slice(n - 12, n - 6)) - 1.5;
                    } else settled = false;
                }
                if (now >= maxStart || (now >= minStart && settled)) {
                    startMs = now;
                    rawAudio = null; rawChunks = []; rawCount = 0;
                    if (tap) tap.start();
                    if (armClap) armClap();      // from here on an interruption saves instead of dropping
                    try { motionBegin(0); } catch (e) { /* an extra */ }
                } else return;
            }
            if (now < startMs + 4000) {
                $('clap').textContent = 'Clap now…';
                fine.getFloatFrequencyData(fineSpectrum);
                for (let k = k0; k <= k1; k++) if (fineSpectrum[k] > hold[k - k0]) hold[k - k0] = fineSpectrum[k];
                return;
            }
            finish(false);
        }, 60);
        // Ends the recording and saves it. Also called when it is cut short: what was recorded is kept.
        const finish = (interrupted) => {
            clapFinish = null;
            clearInterval(clapTimer); clapTimer = null;
            clapBusy = false;
            rawAudio = takeRaw();
            curve = []; viewing = null;
            for (let k = k0; k <= k1; k++) if (Number.isFinite(hold[k - k0])) curve.push({ f: k * binHz, db: hold[k - k0] });
            curveKind = 'clap';
            disturbed = false;
            setClapButton();
            setButtons();
            if (interrupted && !curve.length && !rawAudio) {
                curveState = 'none';
                showPeaks([]);
                saveNote('The clap was interrupted before any sound was recorded, so there was nothing to save.');
                drawChart();
                return;
            }
            curveState = 'done';
            const peaks = M.findPeaks(curve, 4);
            if (oldF != null) peaks.forEach((p) => { if (Math.abs(p.f - oldF) / oldF * 100 <= MATCH_TOL) p.echo = true; });
            showPeaks(peaks);
            autoSave(interrupted);
            drawChart();
        };
        armClap = () => { clapFinish = finish; };
    }
    let armClap = null;

    // ---------- Results ----------
    function showPeaks(peaks) {
        const host = $('peaks');
        host.textContent = '';
        livePeaks = peaks;
        lastPeaks = [];
        const note = (text) => { const p = document.createElement('p'); p.className = 'hint'; p.textContent = text; host.appendChild(p); };
        if (!peaks.length) {
            if (curveKind === 'sweep' && settings.fMax / settings.fMin < 1.25) {
                note('No clear peaks found. This range is too narrow to tell a peak from its surroundings: widen "From Hz" and "To Hz" so the sweep covers more than the peak itself.');
            } else if (curveKind === 'clap') {
                note('No clear peaks found. Soft furniture soaks up the ringing: try a sharper, louder clap, or a bare room with hard walls.');
            } else {
                note('No clear peaks found. Try more volume, a corner position, or a longer sweep.');
            }
            return;
        }
        let anyEdge = false, anyEcho = false;
        const table = document.createElement('table');
        const head = document.createElement('tr');
        ['Measured', 'Note', 'Nearest listed mode', 'Miss'].forEach((h) => { const th = document.createElement('th'); th.textContent = h; head.appendChild(th); });
        table.appendChild(head);
        M.strongestPeaks(peaks, 12).forEach((p) => {
            const match = M.matchMode(shown, p.f, MATCH_TOL);
            let nearest = 'none within ' + MATCH_TOL + ' %', miss = '–';
            if (match.mode && match.candidates > 2) nearest = match.candidates + ' modes within ' + MATCH_TOL + ' %: too dense to tell';
            else if (match.mode) {
                nearest = match.mode.f.toFixed(1) + ' Hz ' + describeRow(match.mode);
                miss = (match.errorPct >= 0 ? '+' : '') + match.errorPct.toFixed(1) + ' %';
            }
            let measured = p.f.toFixed(1) + ' Hz';
            if (p.edge) { measured += ' (edge)'; anyEdge = true; }
            if (p.echo) { measured += ' (old tone?)'; anyEcho = true; }
            lastPeaks.push(Object.assign({}, p, { nearest, miss }));
            const tr = document.createElement('tr');
            [measured, noteText(p.f), nearest, miss].forEach((c) => { const td = document.createElement('td'); td.textContent = c; tr.appendChild(td); });
            table.appendChild(tr);
        });
        host.appendChild(table);
        const chance = Math.round(100 * M.randomHitChance(shown, settings.fMin, settings.fMax, MATCH_TOL));
        note('Compared with the ' + shown.length + ' modes listed under "Single tones". A frequency picked at random would land within ' +
            MATCH_TOL + ' % of one of them about ' + chance + ' % of the time' +
            (chance >= 40 ? ', so a single match means little. Look for several peaks that fit, and peaks that return when you repeat the measurement.' :
                '. A peak near a listed mode is consistent with it, not proof of it.'));
        if (anyEdge) note('"(edge)": at the very end of the range, so it may be a slope that continues outside it and not a peak.');
        if (anyEcho) note('"(old tone?)": at the frequency of the tone played just before the clap. The room may still have been ringing from it. Wait longer and clap again to check.');
        if (curveKind === 'sweep') {
            // about +-0.15 s of unknown speaker delay, turned into a frequency error
            const pct = 100 * Math.log(settings.fMax / settings.fMin) / settings.sweepDur * 0.15;
            note('Sweep frequencies are good to about ±' + (pct < 0.1 ? '0.1' : pct.toFixed(1)) + ' % because the speaker delay is not known exactly. A strongly ringing room also answers a little late, which pushes sweep peaks slightly upward; the clap does not have that error.' +
                (pct > 0.5 ? ' A longer sweep or a narrower range is more accurate.' : ''));
            if (disturbed) note('The volume was changed during this sweep, so levels before and after the change are not comparable.');
        }
    }

    // Paint one chart. o: { f1, f2, curve: [{ f, db }], marks: modes to tick along the top, cursor: Hz or null }
    function paintChart(g, Wd, Hd, o) {
        const padL = 52, padR = 10, padT = 24, padB = 22;
        g.fillStyle = '#0b0b0b';
        g.fillRect(0, 0, Wd, Hd);
        const f1 = o.f1, f2 = o.f2;
        if (!(f2 > f1) || !(f1 > 0)) return;
        const x = (f) => padL + (Wd - padL - padR) * Math.log(f / f1) / Math.log(f2 / f1);
        g.font = '11px system-ui, sans-serif';
        g.textBaseline = 'middle';
        // frequency grid
        g.strokeStyle = '#2c2c2c'; g.fillStyle = '#a8a8a8'; g.lineWidth = 1; g.textAlign = 'center';
        let lastLabelX = -1e9;
        [20, 30, 40, 50, 60, 80, 100, 150, 200, 300, 400, 600, 800, 1000, 1500, 2000, 3000].forEach((f) => {
            if (f < f1 || f > f2) return;
            g.beginPath(); g.moveTo(x(f), padT); g.lineTo(x(f), Hd - padB); g.stroke();
            if (x(f) - lastLabelX >= 44) { g.fillText(f + ' Hz', Math.min(x(f), Wd - 22), Hd - padB / 2); lastLabelX = x(f); }
        });
        if (lastLabelX < 0) {
            // no round number falls inside a narrow range: label the two ends
            g.textAlign = 'left'; g.fillText(f1 + ' Hz', padL, Hd - padB / 2);
            g.textAlign = 'right'; g.fillText(f2 + ' Hz', Wd - padR, Hd - padB / 2);
            g.textAlign = 'center';
        }
        // predicted modes (the ones listed under "Single tones")
        (o.marks || []).forEach((m) => {
            if (m.f < f1 || m.f > f2) return;
            const axial = m.type === 'axial';
            g.strokeStyle = axial ? '#d4af37' : '#6f5c1d';
            g.lineWidth = axial ? 2 : 1;
            g.beginPath(); g.moveTo(x(m.f), 3); g.lineTo(x(m.f), axial ? 18 : 10); g.stroke();
        });
        // measured curve
        const pts = o.curve || [];
        if (pts.length > 1) {
            let lo = Infinity, hi = -Infinity;
            pts.forEach((p) => { if (p.db < lo) lo = p.db; if (p.db > hi) hi = p.db; });
            lo = Math.max(lo, hi - 60);
            if (hi - lo < 10) lo = hi - 10;
            const y = (db) => padT + (Hd - padT - padB) * (1 - (Math.max(db, lo) - lo) / (hi - lo));
            g.fillStyle = '#a8a8a8'; g.textAlign = 'right';
            g.fillText(hi.toFixed(0) + ' dB', padL - 6, padT + 6);
            g.fillText(lo.toFixed(0) + ' dB', padL - 6, Hd - padB - 6);
            g.strokeStyle = '#d4af37'; g.lineWidth = 2; g.lineJoin = 'round';
            g.beginPath();
            let started = false;
            pts.forEach((p) => {
                if (p.f < f1 || p.f > f2) return;
                if (!started) { g.moveTo(x(p.f), y(p.db)); started = true; } else g.lineTo(x(p.f), y(p.db));
            });
            g.stroke();
        }
        if (o.cursor != null && o.cursor >= f1 && o.cursor <= f2) {
            g.strokeStyle = '#fff'; g.lineWidth = 1; g.setLineDash([4, 4]);
            g.beginPath(); g.moveTo(x(o.cursor), padT); g.lineTo(x(o.cursor), Hd - padB); g.stroke();
            g.setLineDash([]);
        }
    }

    const recCurve = (rec) => rec.curve.map((p) => ({ f: p[0], db: p[1] }));
    function recTitle(rec) {
        const p = R.localParts(rec);
        return p.date + ' ' + p.time + (rec.sessionNote ? ' · ' + rec.sessionNote : '') + (rec.note ? ' · ' + rec.note : '');
    }

    function drawChart(cursorF) {
        const cv = $('chart');
        const dpr = window.devicePixelRatio || 1;
        const Wd = cv.clientWidth || 320, Hd = cv.clientHeight || 220;
        if (cv.width !== Math.round(Wd * dpr) || cv.height !== Math.round(Hd * dpr)) {
            cv.width = Math.round(Wd * dpr);
            cv.height = Math.round(Hd * dpr);
        }
        cv.dataset.points = String(curve.length);   // for tests
        const g = cv.getContext('2d');
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (viewing) {
            $('chartTitle').textContent = 'Saved: ' + recTitle(viewing);
            paintChart(g, Wd, Hd, { f1: viewing.fMin, f2: viewing.fMax, curve: recCurve(viewing), marks: [], cursor: null });
        } else {
            $('chartTitle').textContent = curveKind === 'clap' ? 'Measurement: clap spectrum' : curveKind === 'sweep' ? 'Measurement: sweep' : 'Measurement';
            // cursor: sweep position or the playing tone
            const cf = cursorF != null ? cursorF : (voice && voice.kind === 'tone' ? voice.f1 : null);
            paintChart(g, Wd, Hd, { f1: settings.fMin, f2: settings.fMax, curve, marks: shown, cursor: cf });
        }
    }

    // ---------- Saved measurements ----------
    // Records live in IndexedDB ("records"), photos and raw sound beside them ("photos", "audio", keyed by record id).
    let db = null;
    let saved = [];                 // newest first
    const thumbs = new Map();       // record id -> object URL of its photo
    const prepared = new Map();     // record id or 'all' -> { files, title, text } ready for the share sheet
    let photoTarget = null;
    let photoBusy = false;
    // Nothing measured is ever dropped because storage failed: such records stay in the list,
    // held in memory and marked, and the app keeps trying to write them.
    const unstored = new Set();     // records not (fully) written to the phone yet
    const memAudio = new Map();     // record id -> WAV bytes of an unstored record
    let storeError = '';            // why the last write failed
    let pendingWrites = 0;          // write transactions in flight
    let locating = 0;               // location searches in flight
    let storageWarn = '';           // start-up storage problem, shown in the top bar

    // A storage call that never answers must not hold everything else up: after this long it counts as failed.
    const STORAGE_WAIT_MS = 10000;
    function openDb() {
        return new Promise((resolve, reject) => {
            if (!window.indexedDB) { reject(new Error('This browser has no storage for saved measurements.')); return; }
            let settled = false;
            const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error('the phone storage did not answer')); } }, STORAGE_WAIT_MS);
            const end = (fn, value) => { if (settled) { if (fn === resolve && value) { try { value.close(); } catch (e) { /* ignore */ } } return; } settled = true; clearTimeout(timer); fn(value); };
            let rq;
            try { rq = indexedDB.open('pyramid-res', 2); } catch (e) { end(reject, e); return; }
            rq.onupgradeneeded = () => {
                const d = rq.result;
                if (!d.objectStoreNames.contains('records')) d.createObjectStore('records', { keyPath: 'id' });
                if (!d.objectStoreNames.contains('photos')) d.createObjectStore('photos');
                if (!d.objectStoreNames.contains('audio')) d.createObjectStore('audio');
            };
            rq.onsuccess = () => end(resolve, rq.result);
            rq.onerror = () => end(reject, rq.error || new Error('Storage could not be opened.'));
            rq.onblocked = () => end(reject, new Error('Storage is busy in another tab.'));
        });
    }
    let opening = null;
    function ensureDb() {
        if (db) return Promise.resolve(db);
        if (!opening) {
            opening = openDb().then((d) => {
                // the phone can close the connection behind the app's back: forget it, so the next write opens a new one
                d.onversionchange = () => { try { d.close(); } catch (e) { /* ignore */ } if (db === d) db = null; };
                d.onclose = () => { if (db === d) db = null; };
                db = d;
                opening = null;
                return d;
            }, (e) => { opening = null; throw e; });
        }
        return opening;
    }
    function dropDb() {
        const d = db;
        db = null;
        if (d) { try { d.close(); } catch (e) { /* already gone */ } }
    }
    // One transaction; resolves with the request's result once the data is safely written
    function tx(stores, mode, work) {
        const writing = mode === 'readwrite';
        if (writing) pendingWrites++;
        const p = new Promise((resolve, reject) => {
            if (!db) { reject(new Error('Storage is not available.')); return; }
            let out, settled = false;
            const end = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
            const timer = setTimeout(() => end(reject, new Error('the phone storage did not answer')), STORAGE_WAIT_MS);
            try {
                let t;
                // "strict": the write is on the disk, not only handed to the system, before it counts as done
                try { t = db.transaction(stores, mode, writing ? { durability: 'strict' } : undefined); } catch (e) { t = db.transaction(stores, mode); }
                const rq = work(t);
                if (rq) rq.onsuccess = () => { out = rq.result; };
                t.oncomplete = () => end(resolve, out);
                t.onerror = t.onabort = () => end(reject, t.error || new Error('Storage error.'));
            } catch (e) { end(reject, e); }
        });
        if (writing) p.then(() => { pendingWrites--; }, () => { pendingWrites--; });
        return p;
    }
    // Every write goes through here: the phone may have closed the connection while the app was in the
    // background, so a failed first try is repeated once on a new connection before it counts as a failure.
    async function dbWrite(stores, work) {
        try { await ensureDb(); return await tx(stores, 'readwrite', work); } catch (e) { dropDb(); }
        await ensureDb();
        try { return await tx(stores, 'readwrite', work); } catch (e) { dropDb(); throw e; }
    }
    const deleted = new Set();      // ids the user deleted: a write still in flight must not bring them back
    const inFlight = new Set();     // records being written right now
    // What goes to the phone for a record whose sound is still only in memory: honest about the missing sound
    // (audioPending keeps the sound's description, so that if the sound did reach storage after all it is found again at the next start)
    const dbCopy = (rec) => (unstored.has(rec) && memAudio.has(rec.id) ? Object.assign({}, rec, { audio: null, audioMissing: true, audioPending: rec.audio }) : rec);
    // Any change to a record after it was sent means the copy outside the phone is out of date
    // Files built for a send that waits for its second tap are out of date as soon as anything changes:
    // the record's own, the "everything" zip, and every session zip.
    let changeCount = 0;            // goes up with every change to any record
    const changedAt = new Map();    // record id -> changeCount at its last change
    function forgetPrepared(rec) {
        changeCount++;
        if (rec) { prepared.delete(rec.id); changedAt.set(rec.id, changeCount); }
        Array.from(prepared.keys()).forEach((k) => { if (k === 'all' || String(k).indexOf('session:') === 0) prepared.delete(k); });
    }
    function touched(rec) { rec.sentAt = null; forgetPrepared(rec); }
    // A record still held in memory is written whole by storeRecord, so a small update only needs to wait for that.
    const putRecord = (rec) => {
        forgetPrepared(rec);
        if (deleted.has(rec.id)) return Promise.resolve();
        // being written right now, or waiting to be: storeRecord writes the whole record, and once more when it is done
        if (inFlight.has(rec) || (unstored.has(rec) && !memAudio.has(rec.id))) return Promise.resolve();
        return dbWrite('records', (t) => t.objectStore('records').put(dbCopy(rec)));
    };
    // Writes a record and its sound. On failure the record stays in memory and in the list; if only
    // the sound did not fit, the spectrum is written alone (marked as without sound) and the sound stays in memory.
    async function storeRecord(rec) {
        if (inFlight.has(rec) || deleted.has(rec.id) || !unstored.has(rec)) return !unstored.has(rec);
        inFlight.add(rec);
        const wav = memAudio.get(rec.id) || null;
        let ok = false;
        try {
            if (wav) await dbWrite(['records', 'audio'], (t) => { t.objectStore('audio').put({ type: (rec.audio && rec.audio.type) || 'audio/wav', buffer: wav }, rec.id); return t.objectStore('records').put(rec); });
            else await dbWrite('records', (t) => t.objectStore('records').put(rec));
            unstored.delete(rec);
            memAudio.delete(rec.id);
            ok = true;
            checkpointStored(rec.id);
            // a location or note that arrived while that write was under way is in memory only: write once more
            if (!deleted.has(rec.id)) await dbWrite('records', (t) => t.objectStore('records').put(rec)).catch(() => {});
        } catch (e) {
            storeError = e && e.message ? e.message : 'storage error';
            if (wav && unstored.has(rec) && !deleted.has(rec.id)) {
                try { await dbWrite('records', (t) => t.objectStore('records').put(dbCopy(rec))); } catch (e2) { /* still in memory */ }
            }
        }
        inFlight.delete(rec);
        // deleted while it was being written: take it out again
        if (deleted.has(rec.id)) dbWrite(['records', 'photos', 'audio'], (t) => { t.objectStore('photos').delete(rec.id); t.objectStore('audio').delete(rec.id); return t.objectStore('records').delete(rec.id); }).catch(() => {});
        return ok;
    }
    let retrying = false;
    async function retryUnstored() {
        if (retrying || !unstored.size) return;
        retrying = true;
        let changed = false;
        try {
            for (const rec of Array.from(unstored)) if (await storeRecord(rec)) changed = true;
        } finally { retrying = false; }
        if (changed) { renderSaved(); tabMarks(); }
    }
    function storageNotice() {
        const noun = Array.from(unstored).some(isVoice) ? 'recording' : 'measurement';
        if (unstored.size) return unstored.size + (unstored.size === 1 ? ' ' + noun + ' is' : ' ' + noun + 's are') + ' NOT STORED on the phone (' + (storeError || 'storage error') +
            '). They are held only while the app stays open: send them now from the Saved tab. The app keeps trying to store them.';
        return storageWarn;
    }
    const savedMsg = (text) => { $('savedMsg').textContent = text || ''; };

    function locationLine(rec) {
        if (rec.location) return R.formatLocation(rec.location) + (rec.locationStatus === 'pending' ? ' (improving…)' : '');
        return { pending: 'Getting location…', denied: 'No location: not allowed for this page.', unavailable: 'No location: the phone could not find one.', off: 'No location.' }[rec.locationStatus] || 'No location.';
    }

    const whenShort = (iso) => { const t = new Date(iso), p = (n) => String(n).padStart(2, '0'); return t.getDate() + '.' + (t.getMonth() + 1) + '. ' + p(t.getHours()) + ':' + p(t.getMinutes()); };
    // Everything a person should know about a record at a glance: [text, kind], kind 'bad' is shown in red
    const isVoice = (rec) => rec.kind === 'voice';
    const measured = (list) => list.filter((r) => !isVoice(r));
    function flags(rec) {
        const out = [];
        if (unstored.has(rec)) out.push(['NOT STORED ON THE PHONE: send it now', 'bad']);
        if (rec.interrupted) out.push(['interrupted', 'bad']);
        if (rec.kind === 'clap' && !rec.audio) out.push(['NO SOUND', 'bad']);
        if (rec.disturbed) out.push(['volume changed during the sweep', 'bad']);
        if (rec.motion) {
            if (rec.motion.inMotionDuringMs >= 300) out.push(['PHONE MOVED DURING IT', 'bad']);
            if (rec.motion.movedSincePrevious === true) out.push(['phone moved', 'todo']);
            else if (rec.motion.movedSincePrevious === false) out.push(['same position', 'ok']);
        }
        if (!isVoice(rec) && !rec.location && rec.locationStatus !== 'pending') out.push(['no location', 'todo']);
        out.push(rec.sentAt ? ['sent ' + whenShort(rec.sentAt), 'ok'] : ['not sent yet', 'todo']);
        return out;
    }
    function flagLine(rec) {
        const p = document.createElement('p');
        p.className = 'hint flags';
        flags(rec).forEach(([text, kind], i) => {
            if (i) p.appendChild(document.createTextNode(' · '));
            const sp = document.createElement('span');
            sp.textContent = text; sp.className = 'flag-' + kind;
            p.appendChild(sp);
        });
        return p;
    }
    const noteTimers = new Map();   // record id -> timer of a note waiting to be written
    function summaries() {
        const m = measured(saved), notes = saved.length - m.length;
        const unsent = saved.filter((r) => !r.sentAt).length;
        const voiceText = notes ? ' and ' + notes + (notes === 1 ? ' voice note' : ' voice notes') : '';
        $('savedCount').textContent = m.length ? ' ' + m.length : '';
        $('savedSummary').textContent = saved.length ? m.length + (m.length === 1 ? ' measurement' : ' measurements') + voiceText + ' on this phone, ' + (unsent ? unsent + ' not sent yet.' : 'all sent.') : '';
        $('recentTitle').textContent = m.length + ' saved on this phone' + (unsent ? ', ' + unsent + ' not sent yet' : ', all sent') + '. Newest first; the session being measured is listed whole:';
    }
    // ---------- spot and direction: picked, not typed ----------
    // Two things are said about a measurement by tapping a value from a short set: the spot in the place where the
    // phone was, and its direction. With nothing selected, a tap sets the value for the measurements to come.
    // With measurements selected (their boxes ticked), the same tap gives the value to those.
    const TAGS = [['spot', 'Spot'], ['direction', 'Direction']];
    const tagNext = { spot: '', direction: '' };        // for the next measurements
    const tagExtra = { spot: [], direction: [] };       // values added by hand that no measurement carries yet
    const selected = new Set();                         // ids of the measurements whose box is ticked
    try {
        const t = JSON.parse(localStorage.getItem('pyramid-res-tags') || 'null');
        if (t) TAGS.forEach(([a]) => {
            if (t.next && typeof t.next[a] === 'string') tagNext[a] = t.next[a].slice(0, 60);
            if (t.extra && Array.isArray(t.extra[a])) tagExtra[a] = t.extra[a].filter((v) => typeof v === 'string').map((v) => v.slice(0, 60)).slice(0, 20);
        });
    } catch (e) { /* start with none */ }
    let tagSetAt = 0;       // when a value for the next measurements was last picked
    try { tagSetAt = Number(JSON.parse(localStorage.getItem('pyramid-res-tags') || '{}').setAt) || 0; } catch (e) { tagSetAt = 0; }
    const saveTags = () => { try { localStorage.setItem('pyramid-res-tags', JSON.stringify({ next: tagNext, extra: tagExtra, setAt: tagSetAt })); } catch (e) { /* kept for this run */ } };
    // A picked spot or direction belongs to the session it was picked in. Once that session is over (nothing picked
    // and nothing measured for half an hour) it is dropped, so that tomorrow's first clap elsewhere is not labelled with it.
    function expireTags() {
        if (!tagNext.spot && !tagNext.direction) return;
        const last = Math.max(tagSetAt, saved[0] ? new Date(saved[0].time).getTime() : 0);
        if (Date.now() - last <= SESSION_GAP_MIN * 60000) return;
        tagNext.spot = ''; tagNext.direction = '';
        saveTags();
        renderTagBars();
        try { saveNote('The spot and direction picked in an earlier session were cleared: pick them again for this one.'); } catch (e) { /* an extra */ }
    }
    // the button says what the next measurement will be labelled with, so a left-over value cannot go unnoticed
    function clapLabel() {
        const t = [tagNext.spot, tagNext.direction].filter(Boolean).join(', ');
        return 'Record a clap' + (t ? ' · ' + t : ' (4 s)');
    }
    // In a fixed order (first used first), so that a chip never changes place when it is picked
    function tagValues(attr) {
        const seen = new Set(), out = [];
        const add = (v) => { v = String(v || '').trim(); const k = v.toLowerCase(); if (v && !seen.has(k)) { seen.add(k); out.push(v); } };
        for (let i = saved.length - 1; i >= 0; i--) add(saved[i][attr]);       // oldest measurement first
        tagExtra[attr].slice().reverse().forEach(add);                          // then the ones added by hand, in the order added
        add(tagNext[attr]);
        return out.slice(-16);
    }
    const picked = () => saved.filter((r) => selected.has(r.id));
    // value '' clears. force: set, never toggle off (used when a value has just been typed)
    function setTag(attr, value, force) {
        const recs = picked();
        if (recs.length) {
            recs.forEach((r) => {
                if ((r[attr] || '') === value) return;
                r[attr] = value;
                touched(r);
                putRecord(r).catch((e) => {
                    const why = 'The new ' + attr + ' of a measurement could not be stored (' + (e && e.message ? e.message : 'storage error') + '). It shows on the page but may be gone after a restart: pick it again.';
                    savedMsg(why); saveNote(why, true);
                });
            });
            selected.clear();
            renderSaved();
            return;
        }
        tagNext[attr] = !force && tagNext[attr] === value ? '' : value;
        tagSetAt = Date.now();
        saveTags();
        renderTagBars();
        if (!clapBusy) setClapButton();
    }
    function syncBoxes() {
        document.querySelectorAll('.recSel').forEach((b) => { b.checked = selected.has(b.dataset.id); });
        renderTagBars();
    }
    // ticks all of them, or unticks them if all were ticked already
    function pickMany(recs) {
        const all = recs.length > 0 && recs.every((r) => selected.has(r.id));
        recs.forEach((r) => { if (all) selected.delete(r.id); else selected.add(r.id); });
        syncBoxes();
    }
    function selBox(rec) {
        const b = document.createElement('input');
        b.type = 'checkbox'; b.className = 'recSel'; b.dataset.id = rec.id; b.checked = selected.has(rec.id);
        b.setAttribute('aria-label', 'Select the measurement of ' + R.localParts(rec).time + ':' + R.localParts(rec).compact.slice(4));
        b.addEventListener('change', () => { if (b.checked) selected.add(rec.id); else selected.delete(rec.id); syncBoxes(); });
        const wrap = document.createElement('label');       // the whole 44 px square takes the tap
        wrap.className = 'selWrap';
        wrap.appendChild(b);
        return wrap;
    }
    const tagText = (rec) => TAGS.map(([a]) => rec[a]).filter(Boolean).join(' · ');
    function renderTagBars() {
        const n = picked().length;
        ['tagBar', 'tagBarSaved'].forEach((id) => {
            const host = document.getElementById(id);
            if (!host) return;
            const typing = host.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
            if (typing) return;         // a new value is being typed in this bar: it is redrawn when that is done
            host.textContent = '';
            const lead = document.createElement('div');
            lead.className = 'tagLead';
            const say = document.createElement('span');
            say.className = 'hint';
            say.textContent = n ? n + ' selected: tap a value to give it to ' + (n === 1 ? 'it' : 'them') + '.' : 'For the next measurements. To change earlier ones, tick their boxes first.';
            lead.appendChild(say);
            // always there, so that nothing below moves when the first row is ticked
            const clear = document.createElement('button');
            clear.type = 'button'; clear.className = 'ghost pickBtn'; clear.textContent = 'Clear'; clear.dataset.role = 'clearSelection';
            clear.setAttribute('aria-label', 'Clear the selection');
            clear.style.visibility = n ? 'visible' : 'hidden'; clear.disabled = !n;
            clear.addEventListener('click', () => { selected.clear(); syncBoxes(); });
            lead.appendChild(clear);
            host.appendChild(lead);
            TAGS.forEach(([attr, label]) => {
                const row = document.createElement('div');
                row.className = 'tagRow'; row.dataset.attr = attr;
                const name = document.createElement('span'); name.className = 'tagName'; name.textContent = label;
                row.appendChild(name);
                const chip = (text, value, on, aria) => {
                    const c = document.createElement('button');
                    c.type = 'button'; c.className = 'chip'; c.textContent = text; c.dataset.value = value;
                    c.setAttribute('aria-pressed', on ? 'true' : 'false');
                    if (aria) c.setAttribute('aria-label', aria);
                    row.appendChild(c);
                    return c;
                };
                // a chip tapped while a new value is still being typed means "this one instead": the half-typed value is dropped
                const drop = (e) => { const open = host.querySelector('.chipInput'); if (open && open.cancel) { e.preventDefault(); open.cancel(); } };
                tagValues(attr).forEach((v) => { const c = chip(v, v, !n && tagNext[attr] === v); c.addEventListener('pointerdown', drop); c.addEventListener('click', () => setTag(attr, v)); });
                chip('none', '', false, label + ': none').addEventListener('click', () => setTag(attr, '', true));
                const plus = chip('+ new', '+', false, 'Add a new ' + label.toLowerCase());
                plus.addEventListener('click', () => {
                    const input = document.createElement('input');
                    input.type = 'text'; input.className = 'chipInput'; input.maxLength = 60; input.autocomplete = 'off';
                    input.placeholder = 'new ' + label.toLowerCase(); input.setAttribute('aria-label', 'New ' + label.toLowerCase());
                    let done = false;
                    input.cancel = () => { done = true; input.blur(); input.remove(); renderTagBars(); };
                    const finish = () => {
                        if (done) return;
                        done = true;
                        let v = input.value.trim().slice(0, 60);
                        // the same word in other capitals is the value that exists already
                        const known = tagValues(attr).find((x) => x.toLowerCase() === v.toLowerCase());
                        if (known) v = known;
                        input.blur();
                        input.remove();
                        if (v) {
                            tagExtra[attr] = [v].concat(tagExtra[attr].filter((x) => x.toLowerCase() !== v.toLowerCase())).slice(0, 20);
                            saveTags();
                            setTag(attr, v, true);
                        }
                        renderTagBars();
                    };
                    input.addEventListener('change', finish);
                    input.addEventListener('blur', () => setTimeout(finish, 0));
                    plus.replaceWith(input);
                    input.focus();
                });
                host.appendChild(row);
            });
        });
    }

    // ---------- sessions and places ----------
    const SESSION_GAP_MIN = 30;
    // A measurement made within half an hour of the previous one continues that session; otherwise a new one starts
    // ... and so does one made at a different place: a new place is a new session.
    // A session goes on until 30 minutes pass without a measurement, or until a new one is started on purpose.
    // Changing the description does not start a new session: the description is the session's, and may grow as it goes.
    const NOTE_MAX = 1000;
    let chosenSession = null;       // a new session started on purpose: { id, at }. It stays the session until 30 minutes pass in it.
    const CHOSEN = 'pyramid-res-chosen-session';        // kept over a restart: the intent must not be lost with the page
    try { const c = JSON.parse(localStorage.getItem(CHOSEN) || 'null'); if (c && R.isUuid(c.id) && typeof c.at === 'number') chosenSession = { id: c.id, at: c.at }; } catch (e) { /* none */ }
    const keepChosen = () => { try { if (chosenSession) localStorage.setItem(CHOSEN, JSON.stringify(chosenSession)); else localStorage.removeItem(CHOSEN); } catch (e) { /* it still holds while the app is open */ } };
    let freshSession = null;        // the id for the next record when no session is going on
    const liveNewest = () => { const n = saved[0]; return n && n.sessionId && Date.now() - new Date(n.time).getTime() <= SESSION_GAP_MIN * 60000 ? n : null; };
    function currentSessionId() {
        if (chosenSession) {
            // (also when its first measurement was deleted again: the session before it must not be taken up instead)
            const last = saved.find((r) => r.sessionId === chosenSession.id);
            const ref = last ? new Date(last.time).getTime() : chosenSession.at;
            if (Date.now() - ref <= SESSION_GAP_MIN * 60000) return chosenSession.id;
            chosenSession = null; keepChosen();
        }
        const newest = liveNewest();
        if (newest) { freshSession = null; return newest.sessionId; }
        if (!freshSession || saved.some((r) => r.sessionId === freshSession)) freshSession = R.uuid();
        return freshSession;        // the same one until a record carries it
    }
    const sessionIsNew = () => { const id = currentSessionId(); return !saved.some((r) => r.sessionId === id); };
    function startNewSession() {
        chosenSession = { id: R.uuid(), at: Date.now() };
        keepChosen();
        lastPosition = null;
    }
    // A description that was replaced rather than added to can be put back with one tap: the earlier
    // recordings get the text each of them had, and the new text starts a session of its own.
    // undo: { key: the session, olds: id -> the text it had before the first replacement, text: what they carry now, show }
    let undo = null;
    function noteUndo(u) {
        undo = u;
        const b = document.getElementById('noteUndo');
        if (!b) return;
        b.hidden = !u;
        if (u) b.textContent = 'Undo: keep "' + (u.show.length > 40 ? u.show.slice(0, 38) + '…' : u.show) + '" on the ' + u.olds.size + ' earlier recording' + (u.olds.size === 1 ? '' : 's') + ' of this session, and start a new session for the new text';
    }
    function noteUndoTap() {
        const u = undo;
        if (!u) return false;
        noteUndo(null);
        try {
            // only those that still carry the text that replaced theirs: anything changed since is left as it is
            const targets = saved.filter((r) => u.olds.has(r.id) && placeKey(r.sessionNote) === placeKey(u.text));
            if (!targets.length) { saveNote('There was nothing left to undo: those recordings were changed or deleted since.'); return false; }
            const editing = new Set(targets), writes = [];
            targets.forEach((r) => {
                const old = u.olds.get(r.id) || '';
                r.sessionNote = old;
                r.placeId = old ? placeIdFor(old, editing) : null;
                touched(r);
                writes.push(putRecord(r));
            });
            Promise.all(writes).catch((e) => savedMsg('The note could not be stored: ' + (e && e.message ? e.message : 'storage error') + '.'));
            startNewSession();
            renderSaved(); refreshPlaces(); summaries();
            saveNote('The earlier recordings have their description back. The next measurement starts a new session.');
            return true;
        } catch (e) { saveNote('That could not be undone here: change the description on the Saved tab.', true); return false; }
    }
    // a new session on purpose; if the description was just replaced for it, the earlier recordings get theirs back first
    function newSessionNow() { if (!(undo && undo.key === currentSessionId() && noteUndoTap())) startNewSession(); }
    // What is written under the chart describes the session being measured: a change there reaches the
    // measurements the session already has, so that one description, grown along the way, covers the whole set.
    function syncSessionNote(fill) {
        try {
            const id = currentSessionId();
            const sess = R.sessions(saved, SESSION_GAP_MIN).find((x) => x.records.some((r) => r.sessionId === id));
            if (!sess) return;      // a new session: nothing to bring up to date
            const text = $('saveNote').value.trim().slice(0, NOTE_MAX);
            // an emptied field does not wipe a description: that is done on the Saved tab, on purpose
            if (!text) { if (fill && sess.note) { $('saveNote').value = sess.note; noteTyped(); } return; }
            if (text === sess.note) return;
            const ids = new Set(sess.records.filter((r) => placeKey(r.sessionNote) === placeKey(sess.note) || !placeKey(r.sessionNote)).map((r) => r.id));
            const old = sess.note, grew = !old || text.toLowerCase().includes(old.toLowerCase());
            const olds = new Map(sess.records.filter((r) => ids.has(r.id)).map((r) => [r.id, r.sessionNote || '']));
            if (applySessionNote(sess.key, ids, old, text)) {
                // an undo already offered for this session stays the same undo, back to the first text; else: added to, nothing is lost; replaced, it can be put back
                if (undo && undo.key === sess.key && placeKey(undo.text) === placeKey(old)) noteUndo({ key: undo.key, olds: undo.olds, text, show: undo.show });
                else noteUndo(grew ? null : { key: sess.key, olds, text, show: old });
                renderSaved(); refreshPlaces(); summaries();
            }
        } catch (e) { /* the description still goes with the measurements made from now on */ }
    }
    // A place keeps one identity under its name: the same name gives the same id, a new name a new id.
    // editing: the records whose note is being changed right now; they do not count as evidence for the new name.
    const placeKey = (name) => String(name || '').trim().toLowerCase();
    const newPlaces = new Map();    // names first used in this run -> the id they were given, so every caller gets the same one
    function placeIdFor(name, editing) {
        const key = placeKey(name);
        if (!key) return null;
        const skip = editing || new Set();
        const known = saved.find((r) => !skip.has(r) && r.placeId && placeKey(r.sessionNote) === key);
        if (known) return known.placeId;
        // a place that is only being renamed (nothing else uses its id) keeps its identity
        const own = Array.from(new Set(Array.from(skip).map((r) => r.placeId).filter(Boolean)));
        if (own.length === 1 && !saved.some((r) => !skip.has(r) && r.placeId === own[0])) {
            Array.from(newPlaces.keys()).forEach((k) => { if (newPlaces.get(k) === own[0]) newPlaces.delete(k); });    // its earlier names no longer mean this place
            newPlaces.set(key, own[0]);
            return own[0];
        }
        if (!newPlaces.has(key)) newPlaces.set(key, R.uuid());
        return newPlaces.get(key);
    }
    // The places used before, newest first, offered as suggestions wherever a session note is typed
    function placeNames() {
        const seen = new Set(), out = [];
        saved.forEach((r) => { const n = (r.sessionNote || '').trim(); if (n && !seen.has(placeKey(n))) { seen.add(placeKey(n)); out.push(n); } });
        return out.slice(0, 40);
    }
    // Records saved before sessions and identities existed get them once, by the pauses between them.
    // The note they carried was the place note of that time, so it becomes the session's note if they agree.
    function adoptOldRecords(list) {
        const changed = [];
        R.sessions(list.filter((r) => !r.sessionId), SESSION_GAP_MIN).forEach((sess) => {
            const sid = R.uuid();
            const notes = new Set(sess.records.map((r) => (r.note || '').trim()));
            const common = notes.size === 1 && sess.records.length > 1 ? Array.from(notes)[0] : '';
            sess.records.forEach((r) => {
                r.sessionId = sid;
                if (!R.isUuid(r.uuid)) r.uuid = R.uuid();
                if (r.sessionNote == null) r.sessionNote = '';
                if (common && !r.sessionNote) { r.sessionNote = common; r.note = ''; adoptOldRecords.moved = (adoptOldRecords.moved || 0) + 1; }
                changed.push(r);
            });
        });
        list.forEach((r) => { if (!R.isUuid(r.uuid)) { r.uuid = R.uuid(); if (!changed.includes(r)) changed.push(r); } });
        // places: one id per name
        const ids = {};
        list.forEach((r) => { const k = placeKey(r.sessionNote); if (k && r.placeId) ids[k] = ids[k] || r.placeId; });
        list.forEach((r) => {
            const k = placeKey(r.sessionNote);
            if (k && !r.placeId) { ids[k] = ids[k] || R.uuid(); r.placeId = ids[k]; if (!changed.includes(r)) changed.push(r); }
            if (r.placeId === undefined) r.placeId = null;
        });
        return changed;
    }
    function refreshPlaces() {
        const box = $('placeBox'), host = $('placeChips');
        if (!box || !host) return;
        if (undo && undo.key !== currentSessionId()) noteUndo(null);       // that session is over: its undo is no longer offered here
        host.textContent = '';
        const chip = (label, title, act) => {
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'chip'; b.textContent = label; if (title) b.title = title;
            b.addEventListener('click', () => { act(); box.open = false; });
            host.appendChild(b);
        };
        const going = !sessionIsNew();
        if (going) chip('New session, same description', '', () => { const put = !!undo; newSessionNow(); if (!put || !$('saveMsg').textContent.includes('new session')) saveNote('The next measurement starts a new session.'); refreshPlaces(); });
        const now = placeKey($('saveNote').value);
        placeNames().filter((n) => placeKey(n) !== now).slice(0, 6).forEach((n) => chip(n.length > 38 ? n.slice(0, 36) + '…' : n, n, () => {
            if (going) newSessionNow();
            $('saveNote').value = n; noteTyped();
            saveNote('The description was set to "' + (n.length > 60 ? n.slice(0, 58) + '…' : n) + '".' + (going ? ' The next measurement starts a new session.' : ''));
            refreshPlaces();
        }));
        box.hidden = !host.childNodes.length;
        $('placeSummary').textContent = going ? 'Start a new session, or use an earlier description' : 'Use an earlier description';
    }
    // A session note is applied when its field is left (or Enter is pressed), in one step.
    // ids: the measurements the field stands for, fixed when the field was drawn: those that carried the session's
    // note then, and those with none. A measurement with a different note of its own was set on purpose and is
    // never in that set, whatever is typed later. was: the text the field last stood for.
    const DRAFT = 'pyramid-res-session-note-draft';
    function applySessionNote(key, ids, was, text) {
        text = String(text || '').trim().slice(0, NOTE_MAX);
        if (text === String(was || '').trim()) return false;            // nothing was changed: nothing is touched
        const sess = R.sessions(saved, SESSION_GAP_MIN).find((x) => x.key === key);
        if (!sess) return false;
        let targets = new Set(sess.records.filter((r) => ids.has(r.id)));
        if (!targets.size) targets = new Set(sess.records);       // the ones it stood for are gone: the note is the session's, so it goes to all that are left
        if (!targets.size) return false;
        const pid = placeIdFor(text, targets);      // the same name is the same place; a mere rename keeps the identity
        const writes = [];
        targets.forEach((r) => {
            if ((r.sessionNote || '') === text && (r.placeId || null) === (pid || null)) return;
            r.sessionNote = text;
            r.placeId = pid || null;
            touched(r);
            writes.push(putRecord(r));
        });
        // the copy noted down while typing is thrown away only when every measurement has really been written
        Promise.all(writes).then(() => {
            try { const d = JSON.parse(localStorage.getItem(DRAFT) || 'null'); if (d && d.key === key && String(d.text || '').trim().slice(0, NOTE_MAX) === text) localStorage.removeItem(DRAFT); } catch (e) { /* ignore */ }
        }, (e) => savedMsg('The note could not be stored: ' + (e && e.message ? e.message : 'storage error') + '.'));
        // The session being measured right now: its note also goes with the next measurements,
        // unless something else has been typed under the chart for them meanwhile.
        const live = saved[0] && sess.records[0] === saved[0] && Date.now() - new Date(saved[0].time).getTime() <= SESSION_GAP_MIN * 60000;
        if (live && placeKey($('saveNote').value) === placeKey(was)) { $('saveNote').value = text; noteTyped(); }
        return true;
    }
    const idsOf = (input) => new Set(String(input.dataset.ids || '').split(' ').filter(Boolean));
    function saveDraft(input) { try { localStorage.setItem(DRAFT, JSON.stringify({ key: input.dataset.id, ids: input.dataset.ids || '', was: input.dataset.was || '', text: input.value })); } catch (e) { /* ignore */ } }
    function dropDraft(key) { try { const d = JSON.parse(localStorage.getItem(DRAFT) || 'null'); if (!d || d.key === key) localStorage.removeItem(DRAFT); } catch (e) { /* ignore */ } }
    // A session note that was being typed when the app was closed is applied at the next start
    function recoverDraft() {
        const forget = () => { try { localStorage.removeItem(DRAFT); } catch (e) { /* ignore */ } };
        let d = null;
        try { d = JSON.parse(localStorage.getItem(DRAFT) || 'null'); } catch (e) { d = null; }
        if (!d || typeof d.key !== 'string' || typeof d.text !== 'string') { forget(); return; }
        const ids = new Set(String(d.ids || '').split(' ').filter(Boolean));
        // compared with what the measurements carry now, so a note that did get written before the app closed is not applied again
        const want = d.text.trim().slice(0, NOTE_MAX);
        const one = saved.find((r) => ids.has(r.id) && (r.sessionNote || '') !== want);      // one that the text has not reached yet
        if (!one || !applySessionNote(d.key, ids, one.sessionNote || '', d.text)) { forget(); return; }   // (applying it removes the draft once written)
        renderSaved();
        savedMsg(want ? 'A session note that was being typed when the app closed ("' + want.slice(0, 60) + '") was applied.' : 'A session note that was being cleared when the app closed was cleared.');
    }
    const uncommittedNotes = () => Array.from(document.querySelectorAll('#savedList .sessNote')).some((i) => i.value.trim().slice(0, NOTE_MAX) !== (i.dataset.was || ''));
    function commitSessionNotes(except) {
        let changed = false;
        document.querySelectorAll('#savedList .sessNote').forEach((input) => {
            if (input === except) return;
            const was = input.dataset.was || '';
            if (applySessionNote(input.dataset.id, idsOf(input), was, input.value)) {
                changed = true;
                input.dataset.was = input.value.trim().slice(0, NOTE_MAX);
                // it now also stands for measurements of its session that already carried the new note
                { const sess = R.sessions(saved, SESSION_GAP_MIN).find((x) => x.key === input.dataset.id), stood = idsOf(input);
                    if (sess) sess.records.forEach((r) => { if (placeKey(r.sessionNote) === placeKey(input.dataset.was)) stood.add(r.id); });
                    input.dataset.ids = Array.from(stood).join(' '); }
                const card = input.closest('.session');
                if (card && card.refreshInPlace) card.refreshInPlace(input.dataset.was);
            }
        });
        if (changed) { refreshPlaces(); summaries(); }
        return changed;
    }
    const dateFi = (p) => { const d = p.date.split('-'); return Number(d[2]) + '.' + Number(d[1]) + '.' + d[0]; };
    const openRecs = new Set();     // records whose extra lines (location, photo, buttons) are unfolded
    let rebuilding = false;
    const voiceUrls = new Set();    // sounds handed to the page's players, given back when the list is drawn again
    function renderSaved() {
        const host = $('savedList');
        // the list is rebuilt while a note may be being typed (a location arrives): keep the cursor where it was
        const active = document.activeElement;
        const noteClass = active && active.classList ? ['recNote', 'sessNote', 'posNote'].find((c) => active.classList.contains(c)) : null;
        const typing = noteClass
            ? { cls: noteClass, id: active.dataset.id, at: active.selectionStart, value: active.value, was: active.dataset.was || '', ids: active.dataset.ids || '' } : null;
        // session notes typed but not yet applied are applied now, except the one still being typed, which is carried over as it is
        commitSessionNotes(typing && typing.cls === 'sessNote' ? active : null);
        rebuilding = true;      // fields removed from the page fire 'change' and 'blur' in some browsers: those are not the user's
        try {
            voiceUrls.forEach((u) => { try { URL.revokeObjectURL(u); } catch (e) { /* ignore */ } }); voiceUrls.clear();
            host.textContent = '';
            $('savedEmpty').hidden = saved.length > 0;
            summaries();
            // the newest few are also listed right under the chart, so each new measurement is seen to arrive
            $('recentBox').hidden = measured(saved).length === 0;
            const recentAt = $('recentList').scrollTop;
            $('recentList').textContent = '';
            // while a session is being measured, all of it is listed (it is what gets tagged); otherwise the newest five
            const liveId = saved[0] && saved[0].sessionId && Date.now() - new Date(saved[0].time).getTime() <= SESSION_GAP_MIN * 60000 ? saved[0].sessionId : null;
            const recent = measured(liveId ? saved.filter((r) => r.sessionId === liveId).slice(0, 60) : saved.slice(0, 5));
            recent.forEach((rec) => {
                const row = document.createElement('div');
                row.className = 'recentRow';
                row.appendChild(selBox(rec));
                const b = document.createElement('button'), t = document.createElement('b');
                b.type = 'button';
                t.textContent = R.localParts(rec).time + ':' + R.localParts(rec).compact.slice(4);
                b.appendChild(t);
                b.appendChild(document.createTextNode(' ' + rec.kind + (rec.audio ? ' + sound' : '') + ' · ' + R.peakSummary(rec, 3)));
                const tags = [tagText(rec), rec.note].filter(Boolean).join(' · ');
                if (tags) { const g = document.createElement('span'); g.className = 'flag-todo'; g.textContent = ' · ' + tags; b.appendChild(g); }
                const bad = flags(rec).filter((f) => f[1] === 'bad').map((f) => f[0]);
                if (bad.length) { const w = document.createElement('span'); w.className = 'flag-bad'; w.textContent = ' · ' + bad.join(' · '); b.appendChild(w); }
                b.addEventListener('click', () => showRecord(rec));
                row.appendChild(b);
                $('recentList').appendChild(row);
            });
            $('recentList').scrollTop = recentAt;
            renderTagBars();
            const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
            const groups = R.sessions(saved, SESSION_GAP_MIN);
            $('shareAll').hidden = groups.length < 2;
            refreshPlaces();
            groups.forEach((sess) => {
                const card = el('div', null, 'session');
                card.dataset.key = sess.key;
                const info = el('p', null, 'hint sessInfo');
                const describe = () => {
                    const rows = measured(sess.records), notes = sess.records.length - rows.length;
                    const n = rows.length, sounds = rows.filter((r) => r.audio).length, unsent = sess.records.filter((r) => !r.sentAt).length;
                    const bad = {};
                    sess.records.forEach((r) => flags(r).forEach((f) => { if (f[1] === 'bad') bad[f[0]] = (bad[f[0]] || 0) + 1; }));
                    info.textContent = n + (n === 1 ? ' measurement' : ' measurements') + (sounds ? ', ' + sounds + ' with sound' : '') + (notes ? ' · ' + notes + (notes === 1 ? ' voice note' : ' voice notes') : '') + ' · ' + (unsent ? unsent + ' not sent yet' : 'all sent');
                    Object.keys(bad).forEach((k) => { const w = el('span', ' · ' + bad[k] + ' × ' + k, 'flag-bad'); info.appendChild(w); });
                };
                card.appendChild(el('b', dateFi(sess.start) + ' ' + sess.start.time + (sess.end.time !== sess.start.time ? '–' + sess.end.time : ''), 'sessTitle'));
                describe();
                card.appendChild(info);
                // one note for the whole session; it does not replace a different note that single measurements already carry
                // a box of several lines: a set of measurements is best described once, in a few sentences, typed or dictated
                const sNote = document.createElement('textarea');
                sNote.className = 'sessNote'; sNote.maxLength = 1000; sNote.rows = 3; sNote.autocomplete = 'off';
                sNote.placeholder = 'Describe this session: place, where the phone was, what changed between the measurements. Type or dictate.'; sNote.value = sess.note; sNote.dataset.id = sess.key;
                sNote.setAttribute('aria-label', 'Note for the session of ' + dateFi(sess.start) + ' ' + sess.start.time);
                sNote.dataset.was = sess.note;
                sNote.dataset.ids = sess.records.filter((r) => placeKey(r.sessionNote) === placeKey(sess.note) || !placeKey(r.sessionNote)).map((r) => r.id).join(' ');
                // a field being typed in keeps its text and the measurements it stood for when the typing began
                if (typing && typing.cls === 'sessNote' && typing.id === sess.key) {
                    sNote.value = typing.value; sNote.dataset.was = typing.was;
                    // ... plus any that joined the session meanwhile carrying that same note (a clap that finished while typing)
                    const stood = new Set(typing.ids.split(' ').filter(Boolean));
                    sess.records.forEach((r) => { if (placeKey(r.sessionNote) === placeKey(typing.was) || !placeKey(r.sessionNote)) stood.add(r.id); });
                    sNote.dataset.ids = Array.from(stood).join(' ');
                }
                // The lines that depend on the session note are redrawn where they stand. The list is not rebuilt here:
                // the tap that ended the typing is often on a button of this very list, and must still find it.
                card.refreshInPlace = (note) => {
                    sess.note = note;
                    card.querySelectorAll('.rec').forEach((box) => {
                        const rec = sess.records.find((r) => r.id === box.dataset.id);
                        if (!rec) return;
                        const old = box.querySelector('.flags'); if (old) old.replaceWith(flagLine(rec));
                        const tag = box.querySelector('.placeTag');
                        const differs = placeKey(rec.sessionNote) && placeKey(rec.sessionNote) !== placeKey(note);
                        if (tag) { tag.textContent = differs ? ' · place: ' + rec.sessionNote : ''; }
                        const one = box.querySelector('[data-role=share]');
                        if (one && !prepared.has(rec.id)) one.textContent = 'Send';
                    });
                    const all = card.querySelector('[data-role=shareSession]');
                    if (all && !prepared.has('session:' + sess.key)) all.textContent = 'Send session as one zip';     // files built before this change are gone
                    describe();
                };
                const finish = () => {
                    if (rebuilding || !sNote.isConnected) return;
                    commitSessionNotes();
                };
                // what is being typed is also noted down at once, so that it survives the app being closed before the field is left
                sNote.addEventListener('input', () => { if (sNote.value.trim().slice(0, NOTE_MAX) === (sNote.dataset.was || '')) dropDraft(sess.key); else saveDraft(sNote); });
                sNote.addEventListener('change', finish);
                // 'change' does not always come on a phone, so leaving the field finishes the edit too
                sNote.addEventListener('blur', () => setTimeout(finish, 0));
                card.appendChild(sNote);
                const sRow = el('div', null, 'row mt');
                const sKey = 'session:' + sess.key;
                const sendB = el('button', prepared.has(sKey) ? 'Tap to send' : 'Send session as one zip', 'ghost');
                sendB.type = 'button'; sendB.dataset.role = 'shareSession';
                sendB.addEventListener('click', () => {
                    commitSessionNotes();       // a note typed a moment ago belongs in what is sent
                    // the session as it is now, not as it was when this button was drawn
                    send(sKey, () => { const now = R.sessions(saved, SESSION_GAP_MIN).find((x) => x.key === sess.key) || sess; return prepareZip(now.records.slice().reverse(), now.fileBase); }, sendB, 'Send session as one zip');
                });
                sRow.appendChild(sendB);
                const pickAll = el('button', 'Select all', 'ghost');
                pickAll.type = 'button'; pickAll.dataset.role = 'pickSession';
                pickAll.addEventListener('click', () => pickMany(measured(sess.records)));
                sRow.appendChild(pickAll);
                card.appendChild(sRow);
                // spoken notes of the session: listened to here, sent in the session's zip
                sess.records.filter(isVoice).forEach((rec) => {
                    const p = R.localParts(rec), secs = Math.round((rec.audio && rec.audio.durationS) || 0);
                    const box = el('div', null, 'voiceNote');
                    box.dataset.id = rec.id;
                    const head = el('p', null, 'recHead');
                    head.appendChild(el('b', 'Voice note ' + p.time + ':' + p.compact.slice(4)));
                    head.appendChild(document.createTextNode(' · ' + Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0') + (rec.audio ? '' : ' · THE SOUND IS MISSING')));
                    box.appendChild(head);
                    box.appendChild(flagLine(rec));
                    const row = el('div', null, 'row');
                    const play = el('button', 'Play', 'ghost'); play.type = 'button'; play.dataset.role = 'playVoice';
                    play.addEventListener('click', async () => {
                        const buf = await blobOf('audio', rec);
                        if (!buf) { savedMsg('The sound of this voice note could not be found in storage.'); return; }
                        const old = box.querySelector('audio');
                        if (old) { try { URL.revokeObjectURL(old.src); } catch (e) { /* ignore */ } old.remove(); }
                        const a = document.createElement('audio');
                        const cannot = () => savedMsg('This phone could not play the voice note here. It is stored, and it is in the session\'s zip: send the session and listen to it from there.');
                        a.controls = true; a.src = URL.createObjectURL(new Blob([buf], { type: (rec.audio && rec.audio.type) || 'audio/mp4' }));
                        voiceUrls.add(a.src);
                        a.addEventListener('error', cannot);
                        box.appendChild(a);
                        a.play().catch((e) => { if (!e || e.name !== 'AbortError') cannot(); });
                    });
                    row.appendChild(play);
                    const del = el('button', 'Delete', 'ghost'); del.type = 'button'; del.dataset.role = 'delete';
                    del.addEventListener('click', () => deleteRecord(rec, del));
                    row.appendChild(del);
                    box.appendChild(row);
                    card.appendChild(box);
                });
                const list = el('div', null, 'recs');
                const rowsOfSession = measured(sess.records);
                // positions in the order they were measured in: Position 1 is the first of the session
                const positions = [];
                rowsOfSession.slice().reverse().forEach((r) => { if (r.positionId && !positions.includes(r.positionId)) positions.push(r.positionId); });
                rowsOfSession.forEach((rec, index) => {
                    const pos = rec.positionId || null;
                    const group = pos ? rowsOfSession.filter((r) => r.positionId === pos) : null;
                    if (pos && (index === 0 || rowsOfSession[index - 1].positionId !== pos)) {
                        const head = el('div', null, 'posGroup');
                        head.dataset.id = pos;
                        const newest = group[0];
                        head.appendChild(el('span', 'Position ' + (positions.indexOf(pos) + 1) + ' · ' + group.length + (group.length === 1 ? ' measurement' : ' measurements') +
                            (newest.motion ? ' · phone ' + newest.motion.pose : ''), 'hint posTitle'));
                        const pick = el('button', 'Select', 'ghost pickBtn');
                        pick.type = 'button'; pick.dataset.role = 'pickPosition';
                        pick.setAttribute('aria-label', 'Select the ' + group.length + ' measurements of position ' + (positions.indexOf(pos) + 1));
                        pick.addEventListener('click', () => pickMany(group));
                        head.appendChild(pick);
                        list.appendChild(head);
                    }
                    const box = el('div', null, 'rec');
                    box.dataset.id = rec.id;
                    const p = R.localParts(rec);
                    const head = el('p', null, 'recHead');
                    head.appendChild(selBox(rec));
                    head.appendChild(el('b', ' ' + p.time + ':' + p.compact.slice(4)));
                    head.appendChild(document.createTextNode(' ' + (rec.kind === 'sweep' ? 'Sweep' : 'Clap') + ' ' + rec.fMin + '–' + rec.fMax + ' Hz · ' + R.peakSummary(rec, 4) +
                        (rec.audio ? ' · sound ' + rec.audio.durationS.toFixed(1) + ' s' : '')));
                    head.appendChild(el('span', placeKey(rec.sessionNote) && placeKey(rec.sessionNote) !== placeKey(sess.note) ? ' · place: ' + rec.sessionNote : '', 'flag-todo placeTag'));
                    if (tagText(rec)) head.appendChild(el('span', ' · ' + tagText(rec), 'flag-todo recTags'));
                    box.appendChild(head);
                    box.appendChild(flagLine(rec));
                    // one line per measurement for a note about just that one, written as it is typed
                    const line = el('div', null, 'noteLine');
                    const note = document.createElement('input');
                    note.type = 'text'; note.className = 'recNote'; note.maxLength = 200; note.autocomplete = 'off';
                    note.placeholder = 'Typed note for this one (optional)'; note.value = rec.note || ''; note.dataset.id = rec.id;
                    note.setAttribute('aria-label', 'Note for the measurement of ' + p.time + ':' + p.compact.slice(4));
                    const writeNote = () => { noteTimers.delete(rec.id); putRecord(rec).catch((e) => savedMsg('The note could not be stored: ' + (e && e.message ? e.message : 'storage error') + '.')); };
                    // only this record's own lines are refreshed: rebuilding the list here would swallow the tap that ended the typing
                    const marks = () => { const old = box.querySelector('.flags'); if (old) old.replaceWith(flagLine(rec)); describe(); summaries(); };
                    note.addEventListener('input', () => {
                        rec.note = note.value.slice(0, 200);
                        touched(rec);
                        marks();
                        clearTimeout(noteTimers.get(rec.id));
                        noteTimers.set(rec.id, setTimeout(writeNote, 400));
                    });
                    note.addEventListener('change', () => {
                        if (rebuilding || !note.isConnected) return;     // the list was rebuilt under the cursor: the typing goes on in the new field
                        const text = note.value.trim().slice(0, 200);
                        if (text !== rec.note) { rec.note = text; touched(rec); }
                        marks();
                        clearTimeout(noteTimers.get(rec.id));
                        writeNote();
                    });
                    // a typed note, the location, the photo and the buttons for this one measurement are folded away until asked for
                    const more = el('div', null, 'more');
                    more.hidden = !openRecs.has(rec.id);
                    more.appendChild(note);
                    if (rec.note && more.hidden) line.appendChild(el('span', rec.note, 'hint recNoteShown'));
                    else line.appendChild(el('span', '', 'recNoteShown'));
                    const toggle = el('button', more.hidden ? 'More' : 'Less', 'ghost moreBtn');
                    toggle.type = 'button'; toggle.dataset.role = 'more';
                    toggle.setAttribute('aria-expanded', more.hidden ? 'false' : 'true');
                    toggle.addEventListener('click', () => {
                        more.hidden = !more.hidden;
                        if (more.hidden) openRecs.delete(rec.id); else openRecs.add(rec.id);
                        toggle.textContent = more.hidden ? 'More' : 'Less';
                        toggle.setAttribute('aria-expanded', more.hidden ? 'false' : 'true');
                    });
                    line.appendChild(toggle);
                    box.appendChild(line);
                    if (pos) box.classList.add('inPos');
                    const loc = el('p', locationLine(rec) + ' ', 'hint');
                    loc.dataset.role = 'location';
                    if (rec.location) { const a = el('a', 'map'); a.href = R.mapsUrl(rec.location); a.target = '_blank'; a.rel = 'noopener'; loc.appendChild(a); }
                    more.appendChild(loc);
                    if (rec.motion) {
                        const m = rec.motion;
                        more.appendChild(el('p', 'Phone: ' + m.pose + (m.headingDeg != null ? ', top pointing to ' + m.headingDeg + '°' : '') +
                            (m.angleFromPreviousDeg != null ? ', leaning ' + m.angleFromPreviousDeg + '° differently than in the previous measurement' : '') +
                            (m.inMotionBeforeMs ? ', handled for ' + (m.inMotionBeforeMs / 1000).toFixed(1) + ' s before it' : '') + '.', 'hint'));
                    }
                    if (rec.photo) {
                        const img = document.createElement('img');
                        img.alt = 'Photo for this measurement';
                        if (thumbs.has(rec.id)) img.src = thumbs.get(rec.id);
                        else loadThumb(rec.id, img);
                        more.appendChild(img);
                    }
                    const row = el('div', null, 'row mt');
                    const button = (label, role, handler) => { const b = el('button', label, 'ghost'); b.type = 'button'; b.dataset.role = role; b.addEventListener('click', () => handler(rec, b)); row.appendChild(b); };
                    button('Show', 'show', showRecord);
                    button(rec.photo ? 'New photo' : 'Add photo', 'photo', pickPhoto);
                    button(prepared.has(rec.id) ? 'Tap to send' : 'Send', 'share', shareRecord);
                    button('Delete', 'delete', deleteRecord);
                    more.appendChild(row);
                    box.appendChild(more);
                    list.appendChild(box);
                });
                card.appendChild(list);
                host.appendChild(card);
            });
        } finally { rebuilding = false; }
        if (typing) {
            const again = Array.from(host.querySelectorAll('.' + typing.cls)).find((n) => n.dataset.id === typing.id);
            if (again) { again.focus(); try { again.setSelectionRange(typing.at, typing.at); } catch (e) { /* ignore */ } }
        }
    }

    async function loadThumb(id, img) {
        try {
            const p = await tx('photos', 'readonly', (t) => t.objectStore('photos').get(id));
            if (!p) return;
            const url = URL.createObjectURL(new Blob([p.buffer], { type: p.type }));
            thumbs.set(id, url);
            if (img.isConnected) img.src = url;
        } catch (e) { /* the list still works without the picture */ }
    }

    // Started when a measurement is saved. Keeps the best fix of the first 15 s, or stops early at 10 m.
    function startLocate(rec) {
        if (!navigator.geolocation) { rec.locationStatus = 'unavailable'; return; }
        let done = false, watch = null, timer = null;
        locating++;
        const finish = (status) => {
            if (done) return;
            done = true;
            locating--;
            if (watch != null) navigator.geolocation.clearWatch(watch);
            clearTimeout(timer);
            rec.locationStatus = rec.location ? 'ok' : status;
            if (saved.includes(rec)) putRecord(rec).catch(() => {}).then(renderSaved);
        };
        try {
            watch = navigator.geolocation.watchPosition((pos) => {
                if (done) return;
                const c = pos.coords;
                const before = rec.location;
                rec.location = R.betterFix(rec.location, {
                    lat: c.latitude, lon: c.longitude, accuracyM: c.accuracy,
                    altitudeM: c.altitude, altitudeAccuracyM: c.altitudeAccuracy, time: new Date(pos.timestamp).toISOString(),
                });
                const better = JSON.stringify(rec.location) !== JSON.stringify(before);
                if (better && rec.sentAt) touched(rec);
                if (rec.location && rec.location.accuracyM != null && rec.location.accuracyM <= 10) finish('ok');
                else if (better && saved.includes(rec)) putRecord(rec).catch(() => {}).then(renderSaved);
            }, (err) => {
                // code 1 = refused. Other errors may be followed by a fix, so only the timer ends those.
                if (err && err.code === 1) finish('denied');
            }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
        } catch (e) { finish('unavailable'); return; }
        timer = setTimeout(() => finish('unavailable'), 15000);
    }

    // Every measurement is stored at once, with no tap: nothing measured may be lost because a
    // button was not pressed. It goes into the list first and to the phone's storage right after;
    // if storage refuses, it stays in the list (in memory), marked, and the app keeps trying.
    function saveNote(text, bad) {
        $('saveMsg').textContent = text;
        $('saveMsg').className = bad ? 'warn' : 'hint';
    }
    let lastPosition = null;        // { sessionId, positionId } of the last measurement that had sensor data
    async function autoSave(interrupted) {
        if (curveState !== 'done') return;
        // a session note finished but not yet applied counts for this measurement; one still being typed is left to its typist
        { const a = document.activeElement; commitSessionNotes(a && a.classList && a.classList.contains('sessNote') ? a : null); }
        const d = roomDims();
        const kind = curveKind;
        // the phone's position is a note beside the measurement: nothing about it may stop the save
        let phone = null;
        syncSessionNote(true);
        const sid = currentSessionId();
        try { phone = motionEnd(sid); } catch (e) { phone = null; }
        // Measurements made without moving the phone belong together: they share a position, and the note of that position.
        // ("the previous one" is the last measurement the sensor saw, which need not be the newest row: that one may have been deleted)
        let positionId = null;
        try {
            if (phone) {
                const same = phone.movedSincePrevious === false && lastPosition && lastPosition.sessionId === sid;
                positionId = same ? lastPosition.positionId : R.uuid();
                lastPosition = { sessionId: sid, positionId };
            }
        } catch (e) { positionId = null; }
        const id = kind === 'sweep' ? sweepId : null;       // the same id as its checkpoint, so a recovery can never duplicate it
        if (kind === 'sweep') sweepId = null;
        const rec = R.makeRecord({
            id, time: new Date(), kind, sessionNote: $('saveNote').value, sessionId: sid, placeId: placeIdFor($('saveNote').value), positionId, spot: tagNext.spot, direction: tagNext.direction,
            room: { name: settings.room, lengthM: d.L, widthM: d.W, heightM: d.H },
            tempC: settings.temp, fMin: settings.fMin, fMax: settings.fMax,
            sweepDurS: settings.sweepDur, speaker: settings.speaker,
            curve, peaks: lastPeaks, app: BUILD, locationStatus: 'pending',
            interrupted: !!interrupted, disturbed: kind === 'sweep' && disturbed, motion: phone,
        });
        // the sound of a clap is always kept: it is what later analysis needs
        let wav = null;
        if (kind === 'clap' && rawAudio) {
            rec.audio = R.audioInfo(rawAudio.samples.length, rawAudio.sampleRate);
            if (rec.audio) wav = R.encodeWav(rawAudio.samples, rawAudio.sampleRate);
        }
        if (kind === 'clap' && !rec.audio) rec.audioMissing = true;
        curveState = 'saved';
        saved.unshift(rec);
        unstored.add(rec);
        if (wav) memAudio.set(rec.id, wav);
        forgetPrepared(rec);
        renderSaved();
        startLocate(rec);
        const ok = await storeRecord(rec);
        retryUnstored();                    // earlier ones that are still waiting
        renderSaved();
        tabMarks();
        const p = (n) => String(n).padStart(2, '0'), t = new Date(rec.time);
        const at = p(t.getHours()) + ':' + p(t.getMinutes()) + ':' + p(t.getSeconds());
        const what = (interrupted ? 'The interrupted ' + kind + ' was saved as far as it got, at ' : 'Saved by itself at ') + at;
        const m = rec.motion;
        const where = !m ? '' : m.inMotionDuringMs >= 300 ? ' The phone MOVED DURING this measurement.' : m.movedSincePrevious === true ? ' The phone was moved since the previous one.' : m.movedSincePrevious === false ? ' Same phone position as the previous one.' : '';
        if (!ok) {
            saveNote('NOT STORED on the phone (' + storeError + '). The measurement of ' + at + ' is in the Saved list, held only while the app stays open: send it from there now. The app keeps trying to store it.', true);
        } else if (kind === 'clap' && !rec.audio) {
            saveNote(what + ', but WITHOUT ITS SOUND: the phone gave the app no raw sound for this clap. The spectrum and peaks are saved. Turn the microphone off and on before the next clap.' + where + ' It is number ' + measured(saved).length + ' on the Saved tab.', true);
        } else {
            saveNote(what + (rec.audio ? ', with the sound of the clap' : '') + '.' + where + ' It is number ' + measured(saved).length + ' on the Saved tab (top of the page): open it there to add a photo or send it.');
        }
        // ask the phone not to clear this data when it runs low on space, and say what it answered
        askPersist();
    }
    // If the phone kills the app in the middle of a sweep no code runs, so nothing could be saved then.
    // The points measured so far are therefore noted down every two seconds, and picked up at the next start.
    const CHECKPOINT = 'pyramid-res-sweep-';      // + the id of the sweep: each sweep has its own safety copy
    let checkpointAt = 0;
    let sweepId = null;         // the id the running sweep will be saved under; its safety copy carries the same one
    // What an earlier run of the app left behind is read once, now, before this run can write any of its own
    const leftBehind = [];
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.indexOf(CHECKPOINT) === 0) { try { leftBehind.push(JSON.parse(localStorage.getItem(key))); } catch (e) { /* unreadable: skipped */ } }
        }
    } catch (e) { /* no localStorage */ }
    function checkpointSweep() {
        const now = Date.now();
        if (now - checkpointAt < 2000 || !recording || curveKind !== 'sweep') return;
        checkpointAt = now;
        const d = roomDims();
        if (!sweepId) sweepId = R.makeRecord({ kind: 'sweep' }).id;
        try {
            localStorage.setItem(CHECKPOINT + sweepId, JSON.stringify(R.makeRecord({
                id: sweepId, time: new Date(), kind: 'sweep', sessionNote: $('saveNote').value, sessionId: currentSessionId(), placeId: placeIdFor($('saveNote').value),
                room: { name: settings.room, lengthM: d.L, widthM: d.W, heightM: d.H },
                tempC: settings.temp, fMin: settings.fMin, fMax: settings.fMax, sweepDurS: settings.sweepDur, speaker: settings.speaker,
                curve, peaks: [], app: BUILD, locationStatus: 'unavailable', interrupted: true, disturbed,
            })));
        } catch (e) { /* no room for it: the sweep itself goes on */ }
    }
    // The safety copy of a sweep is thrown away only once that very sweep is in the phone storage (or measured nothing)
    function checkpointStored(id) { if (id) { try { localStorage.removeItem(CHECKPOINT + id); } catch (e) { /* ignore */ } } }
    async function recoverCheckpoints() {
        let got = 0, stored = 0, points = 0;
        for (const rec of leftBehind.splice(0)) {
            if (!rec || !rec.id) continue;
            if (rec.id === sweepId) continue;                                   // the sweep running right now
            const ok = rec.schema === R.SCHEMA && Array.isArray(rec.curve) && rec.curve.length > 0;
            if (!ok || deleted.has(rec.id) || saved.some((r) => r.id === rec.id)) { checkpointStored(rec.id); continue; }   // nothing in it, or already saved
            const pts = rec.curve.map((p) => ({ f: p[0], db: p[1] }));
            rec.peaks = R.makeRecord({ kind: 'sweep', curve: pts, peaks: pts.length > 10 ? M.findPeaks(pts, 4) : [] }).peaks;
            saved.push(rec);
            unstored.add(rec);
            got++; points += pts.length;
            if (await storeRecord(rec)) stored++;
        }
        if (!got) return;
        saved.sort((a, b) => (a.time < b.time ? 1 : -1));
        renderSaved();
        tabMarks();
        saveNote('The app was closed in the middle of ' + (got === 1 ? 'a sweep' : got + ' sweeps') + ' last time. What had been measured up to then (' + points + ' points) was recovered and ' +
            (stored === got ? 'saved' : 'is in the list, NOT STORED yet') + ': on the Saved tab, marked "interrupted".', stored !== got);
    }

    // A sweep cut short (Stop, the microphone taken away, a tone or setting chosen) still holds real data: keep it.
    function keepPartialSweep() {
        if (!(recording && curveKind === 'sweep')) return;
        recording = false;
        if (curve.length < 1) { checkpointStored(sweepId); sweepId = null; saveNote('That sweep measured nothing, so there was nothing to save.'); return; }
        curveState = 'done';
        showPeaks(curve.length > 10 ? M.findPeaks(curve, 4) : []);
        autoSave(true);
    }
    // The note under the chart goes with the measurements made after it is typed. It never changes
    // a measurement that is already saved: those have their own note field on the Saved tab.
    function noteTyped() {
        try { localStorage.setItem('pyramid-res-note', $('saveNote').value); } catch (e) { /* the note still works for this session */ }
    }
    let persistAsked = false;
    function askPersist() {
        const say = (kept) => { $('persistLine').textContent = kept ? 'The phone has agreed not to clear this storage by itself.' : 'The phone has not promised to keep this storage: if it runs very short of space it may clear it. Send what matters.'; };
        try {
            if (!(navigator.storage && navigator.storage.persist)) return;
            if (persistAsked) { navigator.storage.persisted().then(say, () => {}); return; }
            persistAsked = true;
            navigator.storage.persist().then(say, () => {});
        } catch (e) { /* ignore */ }
    }

    function showRecord(rec) {
        commitSessionNotes();
        if (voice || clapBusy) stopAll();
        viewing = rec;
        const host = $('peaks');
        host.textContent = '';
        const note = (text) => { const p = document.createElement('p'); p.className = 'hint'; p.textContent = text; host.appendChild(p); };
        if (rec.peaks.length) {
            const table = document.createElement('table');
            const head = document.createElement('tr');
            ['Measured', 'Note', 'Nearest listed mode', 'Miss'].forEach((h) => { const th = document.createElement('th'); th.textContent = h; head.appendChild(th); });
            table.appendChild(head);
            rec.peaks.forEach((p) => {
                const tr = document.createElement('tr');
                [p.f.toFixed(1) + ' Hz' + (p.edge ? ' (edge)' : '') + (p.echo ? ' (old tone?)' : ''), noteText(p.f), p.nearest || '–', p.miss || '–']
                    .forEach((c) => { const td = document.createElement('td'); td.textContent = c; tr.appendChild(td); });
                table.appendChild(tr);
            });
            host.appendChild(table);
        } else note('No clear peaks in this measurement.');
        note('This is a saved measurement' + (rec.location ? ' from ' + R.formatLocation(rec.location) : '') + '. A new clap or sweep replaces it on screen; the saved copy stays on the Saved tab.');
        showTab('measure');     // the chart lives there
        drawChart();
        $('chartTitle').style.scrollMarginTop = ($('top').offsetHeight + 12) + 'px';   // clear of the sticky bar, however tall it is now
        if ($('chartTitle').scrollIntoView) $('chartTitle').scrollIntoView({ block: 'start', behavior: 'smooth' });
    }

    function pickPhoto(rec, button) {
        // a photo taken through the app exists nowhere else: replacing it needs a second tap
        if (rec.photo && button && button.dataset.armed !== '1') {
            button.dataset.armed = '1';
            button.textContent = 'Replace the photo?';
            setTimeout(() => { if (button.isConnected) { button.dataset.armed = ''; button.textContent = 'New photo'; } }, 4000);
            return;
        }
        photoTarget = rec;
        const input = $('photoInput');
        input.value = '';
        input.click();      // iOS offers "Take Photo" and "Photo Library"
    }
    async function photoChosen() {
        const rec = photoTarget, file = $('photoInput').files && $('photoInput').files[0];
        photoTarget = null;
        if (!rec || !file || !saved.includes(rec)) return;
        savedMsg('');
        const url = URL.createObjectURL(file);
        photoBusy = true;
        try {
            const img = new Image();
            img.src = url;
            await img.decode();
            const size = R.fitSize(img.naturalWidth, img.naturalHeight, 1600);
            const cv = document.createElement('canvas');
            cv.width = size.width; cv.height = size.height;
            cv.getContext('2d').drawImage(img, 0, 0, size.width, size.height);
            const blob = await new Promise((resolve) => cv.toBlob(resolve, 'image/jpeg', 0.85));
            if (!blob) throw new Error('the picture could not be converted');
            const buffer = await blob.arrayBuffer();
            const info = { name: file.name || '', type: 'image/jpeg', width: size.width, height: size.height,
                takenTime: file.lastModified ? new Date(file.lastModified).toISOString() : null };
            // the record says "has a photo" before the write starts, so no other write of it can say otherwise;
            // put back if the write fails
            const old = rec.photo, oldSent = rec.sentAt;
            rec.photo = info;
            try {
                await dbWrite(['records', 'photos'], (t) => { t.objectStore('photos').put({ type: 'image/jpeg', buffer }, rec.id); return t.objectStore('records').put(dbCopy(rec)); });
            } catch (e) { rec.photo = old; rec.sentAt = oldSent; throw e; }
            touched(rec);           // also drops a prepared "send all" that would lack this photo
            if (thumbs.has(rec.id)) { URL.revokeObjectURL(thumbs.get(rec.id)); thumbs.delete(rec.id); }
        } catch (e) {
            savedMsg('The photo could not be added: ' + (e && e.message ? e.message : 'unknown error') + '.');
        } finally {
            URL.revokeObjectURL(url);
            photoBusy = false;
        }
        renderSaved();
    }

    function chartPng(rec) {
        const W = 640, H = 300, scale = 2;
        const cv = document.createElement('canvas');
        cv.width = W * scale; cv.height = H * scale;
        const g = cv.getContext('2d');
        g.setTransform(scale, 0, 0, scale, 0, 0);
        g.fillStyle = '#0b0b0b'; g.fillRect(0, 0, W, H);
        g.setTransform(scale, 0, 0, scale, 0, 44 * scale);
        paintChart(g, W, H - 44, { f1: rec.fMin, f2: rec.fMax, curve: recCurve(rec), marks: [], cursor: null });
        g.setTransform(scale, 0, 0, scale, 0, 0);
        g.fillStyle = '#fff'; g.font = 'bold 13px system-ui, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle';
        g.fillText(recTitle(rec).slice(0, 80), 10, 14);
        g.fillStyle = '#a8a8a8'; g.font = '11px system-ui, sans-serif';
        g.fillText('Peaks: ' + R.peakSummary(rec, 6) + (rec.location ? '   ·   ' + R.formatLocation(rec.location) : ''), 10, 32);
        return new Promise((resolve) => cv.toBlob(resolve, 'image/png'));
    }

    // The bytes of a record's sound or photo, or null if they cannot be found
    async function blobOf(store, rec) {
        if (store === 'audio' && memAudio.has(rec.id)) return memAudio.get(rec.id);
        try { await ensureDb(); const x = await tx(store, 'readonly', (t) => t.objectStore(store).get(rec.id)); return x ? x.buffer : null; } catch (e) { return null; }
    }
    async function prepareRecord(rec) {
        const base = R.fileBase(rec), missing = [];
        const files = [new File([JSON.stringify(rec, null, 1)], base + '.json', { type: 'application/json' })];
        const png = await chartPng(rec);
        if (png) files.push(new File([png], base + '_chart.png', { type: 'image/png' }));
        if (rec.photo) {
            const p = await blobOf('photos', rec);
            if (p) files.push(new File([p], base + '_photo.jpg', { type: 'image/jpeg' })); else missing.push('the photo');
        }
        if (rec.audio) {
            const a = await blobOf('audio', rec);
            if (a) files.push(new File([a], base + R.soundExt(rec.audio.type), { type: rec.audio.type || 'audio/wav' })); else missing.push('the sound');
        }
        return { files, title: 'Resonance measurement', text: R.shareText(rec), missing, recs: missing.length ? [] : [rec] };
    }
    // A set of measurements as ONE zip file: a .json with all spectra and details, every sound, every photo.
    // list: oldest first. If the phone will not share a zip, the same files go out loose; if it
    // will not take that many, the spectra go alone and the page says so.
    const canShareFiles = (files) => { try { return !!(navigator.share && navigator.canShare && navigator.canShare({ files })); } catch (e) { return false; } };
    async function prepareZip(list, base) {
        const missing = [], whole = [];
        const body = JSON.stringify(R.exportAll(list, BUILD), null, 1);
        // asked before anything big is built, so that only one copy of the sounds is ever held
        let useZip = !(navigator.share && navigator.canShare) || canShareFiles([new File([new Uint8Array(22)], 'probe.zip', { type: 'application/zip' })]);
        let parts = [{ name: base + '.json', type: 'application/json', bytes: new TextEncoder().encode(body), time: new Date() }];
        let sounds = 0, photos = 0;
        for (const rec of list) {
            const b = R.fileBase(rec), when = new Date(rec.time);
            let complete = true;
            if (rec.audio) {
                const a = await blobOf('audio', rec);
                if (a) { parts.push({ name: b + R.soundExt(rec.audio.type), type: rec.audio.type || 'audio/wav', bytes: new Uint8Array(a), time: when }); sounds++; }
                else { complete = false; missing.push('the sound of ' + recTitle(rec)); }
            } else if (isVoice(rec)) { complete = false; missing.push('the voice note of ' + recTitle(rec)); }      // a voice note is its sound
            if (rec.photo) {
                const p = await blobOf('photos', rec);
                if (p) { parts.push({ name: b + '_photo.jpg', type: 'image/jpeg', bytes: new Uint8Array(p), time: when }); photos++; }
                else { complete = false; missing.push('the photo of ' + recTitle(rec)); }
            }
            if (complete) whole.push(rec);
        }
        const nm = measured(list).length, nv = list.length - nm;
        const count = nm + ' resonance measurement' + (nm === 1 ? '' : 's') + (nv ? ' and ' + nv + ' voice note' + (nv === 1 ? '' : 's') : '');
        const holds = 'a .json file with all spectra, ' + sounds + ' sound file' + (sounds === 1 ? '' : 's') + ' and ' + photos + ' photo' + (photos === 1 ? '' : 's') + '.';
        let whyNot = 'This phone will not share a zip file';
        if (useZip) {
            try {
                const zip = new File([R.zipStore(parts)], base + '.zip', { type: 'application/zip' });
                parts = null;       // the zip is the only copy kept from here on
                return { files: [zip], title: 'Resonance measurements', text: count + ' in one zip: ' + holds, missing, recs: whole, fallback: null };
            } catch (e) { useZip = false; whyNot = 'The zip file could not be built (' + (e && e.message ? e.message : 'unknown error') + ')'; }
        }
        const loose = parts.map((p) => new File([p.bytes], p.name, { type: p.type }));
        parts = null;
        const pack = { files: loose, title: 'Resonance measurements', text: count + ' as ' + loose.length + ' separate files: ' + holds, missing, recs: whole,
            say: whyNot + ', so the ' + loose.length + ' files were offered loose instead.',
            fallback: loose.length > 1 ? { files: [loose[0]], recs: list.filter((r) => !r.audio && !r.photo),
                note: 'This phone will not share that many files at once, so ONLY THE SPECTRA are in this send. THE SOUNDS AND PHOTOS ARE NOT: send those measurements one at a time (More, then Send).' } : null };
        return pack;
    }
    const prepareAll = () => prepareZip(saved.slice().reverse(), (() => { const g = R.sessions(saved, SESSION_GAP_MIN); const last = g[g.length - 1], first = g[0];
        return last.start.date + '_to_' + first.end.date + '_all_' + measured(saved).length + '-measurements'; })());

    function download(files) {
        files.forEach((f, i) => setTimeout(() => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(f); a.download = f.name;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 30000);
        }, i * 400));
    }

    // The share sheet only opens straight from a tap. Building the files takes a moment, so if
    // the phone refuses the first try, the files are kept and the button asks for one more tap.
    async function send(key, build, button, idleLabel) {
        savedMsg('');
        let pack = prepared.get(key);
        const secondTry = !!pack;
        if (!pack) {
            button.disabled = true;
            try { const before = changeCount; pack = await build(); pack.builtAt = before; } catch (e) { savedMsg('Could not build the files: ' + (e && e.message ? e.message : 'unknown error') + '.'); button.disabled = false; return; }
            button.disabled = false;
        }
        const notes = [];
        if (pack.missing && pack.missing.length) notes.push('NOT INCLUDED, because the app could not find it in storage: ' + pack.missing.join(', ') + '.');
        const canShare = canShareFiles;
        const asText = (files) => files.map((f) => (f.type === 'application/json' ? new File([f], f.name + '.txt', { type: 'text/plain' }) : f));
        // the pack itself, then what it falls back to: the first one this phone will share is used, and the page says which
        let shareable = false;
        for (let option = pack, depth = 0; option && depth < 4; option = option.fallback, depth++) {
            // some phones refuse .json in the share sheet: the same text as a .txt file is tried too
            const files = canShare(option.files) ? option.files : (navigator.share && canShare(asText(option.files)) ? asText(option.files) : null);
            if (!files) continue;
            if (depth && option.note) notes.push(option.note);
            if (!depth && option.say) notes.push(option.say);
            pack = Object.assign({}, pack, { files, recs: option.recs, fallback: null });
            shareable = true;
            break;
        }
        if (!shareable) {
            download(pack.files);
            savedMsg(['This browser cannot open a share sheet for files, so ' + pack.files.length + ' file' + (pack.files.length === 1 ? ' was' : 's were') + ' handed to it as downloads. Check that they arrived; the measurements stay marked "not sent yet".'].concat(notes).join(' '));
            return;
        }
        try {
            await navigator.share({ files: pack.files, title: pack.title, text: pack.text });
            prepared.delete(key);
            button.textContent = idleLabel;
            // remember what has left the phone, so it is plain what has no copy elsewhere yet
            const now = new Date().toISOString();
            // ... but not a record that changed after these files were built: what left the phone is its older state
            (pack.recs || []).filter((r) => saved.includes(r) && (changedAt.get(r.id) || 0) <= (pack.builtAt == null ? Infinity : pack.builtAt))
                .forEach((r) => { r.sentAt = now; const keep = changedAt.get(r.id); putRecord(r).catch(() => {}); if (keep == null) changedAt.delete(r.id); else changedAt.set(r.id, keep); });
            renderSaved();
            savedMsg(notes.join(' '));
        } catch (e) {
            if (e && e.name === 'AbortError') { prepared.delete(key); button.textContent = idleLabel; savedMsg(['Not sent: the share sheet was closed.'].concat(notes).join(' ')); return; }   // closed the sheet
            if (secondTry) {
                prepared.delete(key);
                button.textContent = idleLabel;
                savedMsg('The phone refused to share these files (' + (e && e.message ? e.message : 'no reason given') + '). Nothing was sent and nothing was removed.' + (key === 'all' || String(key).indexOf('session:') === 0 ? ' Try sending the measurements one at a time (More, then Send).' : ''));
                return;
            }
            // kept for the second tap only if nothing has changed since it was built
            if (pack.builtAt === changeCount) { prepared.set(key, pack); button.textContent = 'Tap to send'; }
            else { button.textContent = idleLabel; savedMsg('Something changed while the files were being built. Tap once more to send the current state.'); }
        }
    }
    const shareRecord = (rec, button) => { commitSessionNotes(); return send(rec.id, () => prepareRecord(rec), button, 'Send'); };

    function deleteRecord(rec, button) {
        if (button.dataset.armed !== '1') {
            button.dataset.armed = '1';
            button.textContent = 'Really delete?';
            setTimeout(() => { if (button.isConnected) { button.dataset.armed = ''; button.textContent = 'Delete'; } }, 4000);
            return;
        }
        const wasUnstored = unstored.has(rec);
        deleted.add(rec.id);
        clearTimeout(noteTimers.get(rec.id)); noteTimers.delete(rec.id);
        dbWrite(['records', 'photos', 'audio'], (t) => { t.objectStore('photos').delete(rec.id); t.objectStore('audio').delete(rec.id); return t.objectStore('records').delete(rec.id); })
            .catch((e) => { if (!wasUnstored) throw e; })     // one that never reached storage only has to leave the list
            .then(() => {
                unstored.delete(rec); memAudio.delete(rec.id);
                tabMarks();
                saved = saved.filter((r) => r !== rec);
                forgetPrepared(rec);
                if (thumbs.has(rec.id)) { URL.revokeObjectURL(thumbs.get(rec.id)); thumbs.delete(rec.id); }
                if (viewing === rec) { viewing = null; $('peaks').textContent = ''; drawChart(); }
                renderSaved();
            })
            .catch((e) => { deleted.delete(rec.id); savedMsg('Could not delete: ' + (e && e.message ? e.message : 'storage error') + '.'); });
    }

    let loadFailed = false;
    async function loadSaved() {
        try {
            await ensureDb();
            const all = await tx('records', 'readonly', (t) => t.objectStore('records').getAll()) || [];
            const sounds = new Set();
            try { const k = await tx('audio', 'readonly', (t) => t.objectStore('audio').getAllKeys()); (k || []).forEach((id) => sounds.add(id)); } catch (e) { /* the check below is then skipped */ }
            const here = new Set(saved.map((r) => r.id));       // measured before this answer came: those stay as they are
            const fromDisk = all.filter((r) => !here.has(r.id) && !deleted.has(r.id) && !(voice1.record && voice1.record.id === r.id));     // (a voice note still being recorded has a safety copy there)
            fromDisk.forEach((r) => {
                // a location search cut short by closing the app will never finish
                if (r.locationStatus === 'pending') r.locationStatus = r.location ? 'ok' : 'unavailable';
                // written as "without sound" while its sound was still on the way: if the sound did arrive, they belong together again
                if (r.audioPending && sounds.has(r.id)) {
                    const whole = r.audioPending;
                    r.audio = whole; r.audioMissing = false; delete r.audioPending;
                    if (r.kind !== 'voice') putRecord(r).catch(() => {});
                    // a voice note: the sound found may be the shorter safety copy written while it was being recorded
                    else tx('audio', 'readonly', (t) => t.objectStore('audio').get(r.id)).then((x) => {
                        const got = x && x.buffer ? x.buffer.byteLength : 0;
                        if (got && whole.bytes && got !== whole.bytes) {
                            r.interrupted = true;
                            r.audio = Object.assign({}, whole, { bytes: got, durationS: Number(((whole.durationS || 0) * got / whole.bytes).toFixed(1)) });
                            renderSaved();
                        }
                        return putRecord(r);
                    }).catch(() => {});
                }
            });
            saved = saved.concat(fromDisk).sort((a, b) => (a.time < b.time ? 1 : -1));
            if (loadFailed) { loadFailed = false; storageWarn = ''; savedMsg(''); tabMarks(); }
            const adopted = adoptOldRecords(saved);
            adopted.forEach((r) => { putRecord(r).catch(() => {}); });
            if (adoptOldRecords.moved) {
                savedMsg('Measurements from before this version were grouped into sessions. Where every measurement of a session carried the same note, that note is now the session\'s note (' + adoptOldRecords.moved + ' measurements). Nothing was removed.');
                adoptOldRecords.moved = 0;
            }
        } catch (e) {
            dropDb();
            loadFailed = true;      // tried again every 15 s and whenever the app is returned to
            savedMsg('Saved measurements are not available here: ' + (e && e.message ? e.message : 'no storage') + '.');
            // said before anything is measured, on every tab
            storageWarn = 'Measurements CANNOT BE STORED in this browser (' + (e && e.message ? e.message : 'no storage') + '). They will be held only while the app stays open, so send each one right away. Private browsing does this: open the page in a normal tab or from the home-screen icon.';
            tabMarks();
        }
        renderSaved();
        if (saved.length) askPersist();
        if (!loadFailed) { recoverDraft(); recoverCheckpoints(); }
        try { expireTags(); if (!clapBusy) setClapButton(); } catch (e) { /* an extra */ }
    }

    // ---------- Tabs ----------
    // Four sections of this one page. Switching shows and hides them and loads nothing,
    // so it works the same with no network. Sound and microphone keep running across tabs.
    function showTab(name, byUser) {
        if (!CHOICES.tab.includes(name)) name = DEFAULTS.tab;
        if (byUser) commitSessionNotes();
        const changed = settings.tab !== name;
        if (byUser && !changed) return;     // tapping the open tab again must not disturb anything on it
        if (byUser && selected.size) { selected.clear(); syncBoxes(); }      // ticks made on one tab must not act unseen on another
        settings.tab = name;
        if (byUser) save();
        CHOICES.tab.forEach((t) => {
            const on = t === name, button = $('tabBtn-' + t);
            $('tab-' + t).hidden = !on;
            button.setAttribute('aria-selected', on ? 'true' : 'false');
            button.tabIndex = on ? 0 : -1;
        });
        // the "now playing" card with volume and Stop is needed on both sound tabs: it moves with you
        if (name === 'measure') $('nowSlotMeasure').appendChild($('nowCard'));
        if (name === 'play') $('nowSlotPlay').appendChild($('nowCard'));
        if (name === 'measure') drawChart();    // a hidden canvas has no size: draw now that it shows
        tabMarks();     // at once, so the top bar never changes height a moment after the switch
        if (byUser && changed) window.scrollTo(0, 0);
    }
    // marks on the tab buttons, so that a tone or an open microphone is never out of sight
    function tabMarks() {
        const sweeping = !!voice && voice.kind === 'sweep';
        $('dotPlay').hidden = !voice || sweeping;
        $('dotMeasure').hidden = !(micOn || clapBusy || sweeping);
        // Stop, the frequency and the level stay in reach on every tab while something sounds
        $('stripStop').disabled = !voice;
        // with the microphone on, the level at the playing tone is shown next to it (the line is always there: nothing jumps)
        const level = voice && micOn && /dB/.test($('meterText').textContent) ? 'Microphone: ' + $('meterText').textContent : '';
        if ($('nowLevel').textContent !== level) $('nowLevel').textContent = level;
        // a warning written on a tab that is not open is repeated here, so nothing fails silently
        const notes = [storageNotice(), settings.tab === 'play' ? '' : $('audioWarn').textContent, settings.tab === 'measure' ? '' : $('micWarn').textContent].filter(Boolean).join(' ');
        if ($('notice').textContent !== notes) $('notice').textContent = notes;
        $('notice').hidden = !notes;
    }

    // ---------- Version check ----------
    // Date and time in the phone's own time zone, e.g. "21.11.2026 20:00"
    function formatWhen(iso) {
        const t = new Date(iso);
        if (!Number.isFinite(t.getTime())) return 'at an unknown time';
        const p = (n) => String(n).padStart(2, '0');
        return t.getDate() + '.' + (t.getMonth() + 1) + '.' + t.getFullYear() + ' ' + p(t.getHours()) + ':' + p(t.getMinutes());
    }
    // 1 when version a is newer than b, -1 when older, 0 when the same ("2.10.0" is newer than "2.9.9")
    function compareVersions(a, b) {
        const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
        for (let i = 0; i < Math.max(x.length, y.length); i++) {
            const d = (x[i] || 0) - (y[i] || 0);
            if (d) return d > 0 ? 1 : -1;
        }
        return 0;
    }
    // Asks the server which version is published now, past every cache. sw.js is never in
    // the offline cache, so this request always goes to the network.
    async function checkUpdate() {
        const msg = (text) => { $('updateMsg').textContent = text; };
        const button = $('checkUpdate');
        button.disabled = true;
        msg('Checking…');
        try { await checkUpdateNow(msg); } catch (e) { msg('The check failed. You have version ' + BUILD + '.'); }
        button.disabled = false;
    }
    async function checkUpdateNow(msg) {
        let text = null, reached = false;
        const stop = new AbortController();
        const timer = setTimeout(() => stop.abort(), 8000);   // covers the whole download, not only its start
        let badStatus = 0;
        try {
            const res = await fetch('./sw.js?check=' + Date.now(), { cache: 'no-store', signal: stop.signal });
            if (res.ok) { text = await res.text(); reached = true; } else { badStatus = res.status; reached = true; }
        } catch (e) { /* no network, or too slow to finish */ }
        clearTimeout(timer);
        // the patterns are put together from two pieces so that no release tool can mistake them for the constants
        const find = (name) => { const m = text && text.match(new RegExp('const ' + name + " = '([^']+)'")); return m ? m[1] : null; };
        const version = find('VERSION'), released = find('RELEASED');
        if (!version) {
            msg(!reached ? 'Could not check: no connection to the server, or it is too slow. You have version ' + BUILD + '.'
                : badStatus ? 'Could not check: the server answered with an error (' + badStatus + '). You have version ' + BUILD + '.'
                    : 'Could not check: the answer was not from the app\'s server (a network that wants a login first does this). You have version ' + BUILD + '.');
            return;
        }
        const order = compareVersions(version, BUILD);
        if (order === 0) { msg('This is the newest version (checked ' + formatWhen(new Date().toISOString()) + ').'); return; }
        if (order < 0) { msg('The server still offers the older version ' + version + '; you already have ' + BUILD + '. Nothing to do.'); return; }
        const what = 'Version ' + version + (released ? ', published ' + formatWhen(released) + ',' : '');
        const loadIt = () => { $('updateNote').hidden = false; msg(what + ' is downloaded. Tap "Load the new version" at the top of the page.'); };
        if (updater && updater.ready) { loadIt(); return; }
        const reg = updater && updater.reg;
        if (!reg) { msg(what + ' is available. Close the app completely and open it again to get it.'); return; }
        msg(what + ' is available. Downloading it…');
        // a file did not arrive, or the server has published only part of the release so far
        const failed = () => msg(what + ' is available, but it could not be installed yet. You still have the whole version ' + BUILD + '. Try again in a few minutes.');
        // what to say once the browser has fetched the new sw.js; also runs late, after a slow download
        const afterUpdate = () => {
            if (updater.ready) { loadIt(); return; }
            const worker = reg.installing || reg.waiting;
            if (!worker) {
                // the address without "?check" can be a few minutes behind right after a release
                msg(what + ' is available, but the server is still handing out the old files. This passes within about 10 minutes of a release: try again then.');
                return;
            }
            msg(what + ' is downloading. When it is ready the page reloads by itself, or a "Load the new version" button appears at the top if you are in the middle of something.');
            worker.addEventListener('statechange', () => { if (worker.state === 'redundant' && !updater.ready) failed(); });
            if (worker.state === 'redundant') failed();
        };
        const slowTimer = setTimeout(() => msg(what + ' is available. The download is slow; it continues by itself, and you can keep using the app.'), 20000);
        const update = reg.update().then(
            () => { clearTimeout(slowTimer); afterUpdate(); },
            () => { clearTimeout(slowTimer); msg(what + ' is available, but the download did not start. Try again with a better connection.'); });
        // the button is given back after 21 s at the latest; the message above still follows the download
        await Promise.race([update, new Promise((resolve) => setTimeout(resolve, 21000))]);
    }

    // ---------- Wiring ----------
    // Apply a settings change. A change that would need too many modes is undone.
    function change(mutate) {
        const before = Object.assign({}, settings);
        // whatever is being measured is ended and saved with the settings it was measured with, before they change
        if (voice || clapBusy) stopAll();
        keepPartialSweep();
        mutate();
        sanitize(settings);
        // a complaint about the old settings is out of date now
        ['audioWarn', 'micWarn'].forEach((id) => { if ($(id).textContent.includes('Setup tab')) $(id).textContent = ''; });
        if (voice || clapBusy) stopAll();
        rawAudio = null; curve = []; curveKind = ''; curveState = 'none'; viewing = null; recording = false; $('peaks').textContent = '';
        if (!recompute()) {
            const message = $('roomWarn').textContent;
            Object.assign(settings, before);
            recompute();
            $('roomWarn').textContent = message + ' Kept the previous settings.';
        }
        save();
        syncInputs();
    }
    function num(id, key) {
        $(id).addEventListener('change', () => {
            const v = parseFloat($(id).value);
            if (!Number.isFinite(v)) { syncInputs(); return; }
            change(() => { settings[key] = v; });
        });
    }
    num('dimL', 'L'); num('dimW', 'W'); num('dimH', 'H');
    num('temp', 'temp'); num('fMin', 'fMin'); num('fMax', 'fMax');

    $('room').addEventListener('change', () => change(() => { settings.room = $('room').value; }));
    $('modeFilter').addEventListener('change', () => change(() => { settings.filter = $('modeFilter').value; }));
    $('sweepDur').addEventListener('change', () => { settings.sweepDur = parseInt($('sweepDur').value, 10); sanitize(settings); save(); syncInputs(); });
    $('speaker').addEventListener('change', () => { settings.speaker = $('speaker').value; sanitize(settings); save(); syncInputs(); });
    $('volume').addEventListener('input', () => {
        settings.volume = parseFloat($('volume').value);
        sanitize(settings);
        if (volNode && ctx) volNode.gain.setTargetAtTime(settings.volume, ctx.currentTime, 0.03);
        if (recording) disturbed = true;
        save();
    });
    $('prev').addEventListener('click', () => playMode(lastIdx < 0 ? shown.length - 1 : lastIdx - 1));
    $('next').addEventListener('click', () => playMode(lastIdx + 1));
    $('stop').addEventListener('click', stopAll);
    $('stripStop').addEventListener('click', stopAll);
    // a warning in the top bar goes away when tapped
    $('notice').addEventListener('click', () => { $('audioWarn').textContent = ''; $('micWarn').textContent = ''; tabMarks(); });   // a storage warning stays until the problem is gone
    $('sweep').addEventListener('click', toggleSweep);
    $('mic').addEventListener('click', toggleMic);
    // One tap is enough: if the microphone is off, it is turned on first and the clap recording follows.
    $('clap').addEventListener('click', async () => {
        if (!micOn && !micBusy && !clapBusy) {
            await toggleMic();
            if (!micOn) return;         // refused or failed: the reason is on the page
        }
        recordClap();
    });
    try { $('saveNote').value = localStorage.getItem('pyramid-res-note') || ''; } catch (e) { /* no stored note */ }
    $('saveNote').addEventListener('input', noteTyped);      // on every keystroke: iOS may never send 'change'
    $('saveNote').addEventListener('change', () => { noteTyped(); if (!rebuilding) syncSessionNote(); });
    const again = () => { if (loadFailed) loadSaved().then(retryUnstored); else retryUnstored(); };
    setInterval(again, 15000);
    document.addEventListener('visibilitychange', () => { if (document.hidden) { commitSessionNotes(); try { voiceStop(); } catch (e) { /* an extra */ } } else { again(); try { expireTags(); if (!clapBusy) setClapButton(); } catch (e) { /* an extra */ } } });
    window.addEventListener('pagehide', () => { commitSessionNotes(); });
    $('openSaved').addEventListener('click', () => showTab('saved', true));
    $('photoInput').addEventListener('change', photoChosen);
    $('shareAll').addEventListener('click', () => { commitSessionNotes(); send('all', async () => prepareAll(), $('shareAll'), 'Send everything as one zip'); });

    // A hidden page cannot be trusted to keep playing: stop, so the screen never lies
    document.addEventListener('visibilitychange', () => {
        if (document.hidden && (voice || clapBusy)) stopAll();
    });
    window.addEventListener('resize', () => drawChart());

    CHOICES.tab.forEach((t, i) => {
        $('tabBtn-' + t).addEventListener('click', () => showTab(t, true));
        // arrow keys move between tabs, as a tab list should
        $('tabBtn-' + t).addEventListener('keydown', (e) => {
            const last = CHOICES.tab.length - 1;
            const to = e.key === 'ArrowRight' ? (i + 1) % (last + 1) : e.key === 'ArrowLeft' ? (i + last) % (last + 1) : e.key === 'Home' ? 0 : e.key === 'End' ? last : -1;
            if (to < 0 || to === i) return;
            e.preventDefault();
            const next = CHOICES.tab[to];
            showTab(next, true);
            $('tabBtn-' + next).focus();
        });
    });
    showTab(settings.tab);
    setInterval(tabMarks, 400);

    try { const vb = document.getElementById('voiceBtn'); if (vb) { vb.addEventListener('click', voiceToggle); voiceButton(); } } catch (e) { /* an extra */ }
    try { const ub = document.getElementById('noteUndo'); if (ub) ub.addEventListener('click', noteUndoTap); } catch (e) { /* an extra */ }
    // the phone-position extra is wired last of the optional things and can never stop the start-up
    try {
        motionLine();
        motionAuto();
        ['motionAsk', 'motionAsk2'].forEach((id) => { const b = document.getElementById(id); if (b) b.addEventListener('click', motionEnable); });
        document.addEventListener('visibilitychange', () => { if (document.hidden) { motion.prev = null; motion.run = 0; } });
    } catch (e) { /* ignore */ }
    $('build').textContent = 'Version ' + BUILD;
    $('released').textContent = ', published ' + formatWhen(RELEASED);
    $('checkUpdate').addEventListener('click', checkUpdate);
    setSessionType('playback');
    // Last of all, when everything it reads exists: an automatic reload must not cut off a sound,
    // a measurement in progress, or a finished measurement that has not been saved yet.
    if (updater) updater.unstored = () => unstored.size;
    if (updater) updater.busy = () => {
        const a = document.activeElement;
        const typing = !!a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && (a.type === 'text' || a.type === 'number')));
        return !!(voice || micOn || clapBusy || recording || curveState === 'done' || unstored.size || pendingWrites || locating || photoBusy || noteTimers.size || typing || uncommittedNotes() || voice1.rec || voice1.finishing);
    };
    syncInputs();
    if (!recompute()) {
        // a stored range that is too large: fall back to the default range, keep the room
        settings.fMin = DEFAULTS.fMin; settings.fMax = DEFAULTS.fMax; settings.filter = DEFAULTS.filter;
        syncInputs(); recompute(); save();
    }
    setClapButton();
    loadSaved();
})();
