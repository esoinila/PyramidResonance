/* PyramidResonance v2: single tones, sweep and microphone measurement. Maths lives in modes.js. */
(function () {
    'use strict';

    const M = window.Modes;
    const R = window.Records;
    const $ = (id) => document.getElementById(id);

    // Must equal VERSION in sw.js (a test checks it). Change both for every release:
    // the new sw.js is what makes phones fetch the new files, all at once.
    const BUILD = '2.4.0';
    const RELEASED = '2026-11-22T18:25:00Z';   // when this version was published; the same value is in sw.js
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
            recording = micOn;
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
        $('clap').disabled = !micOn || clapBusy;
        $('clap').textContent = text || 'Record a clap (4 s)';
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
    function forgetPrepared(rec) {
        if (rec) prepared.delete(rec.id);
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
            if (wav) await dbWrite(['records', 'audio'], (t) => { t.objectStore('audio').put({ type: 'audio/wav', buffer: wav }, rec.id); return t.objectStore('records').put(rec); });
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
        if (unstored.size) return unstored.size + (unstored.size === 1 ? ' measurement is' : ' measurements are') + ' NOT STORED on the phone (' + (storeError || 'storage error') +
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
    function flags(rec) {
        const out = [];
        if (unstored.has(rec)) out.push(['NOT STORED ON THE PHONE: send it now', 'bad']);
        if (rec.interrupted) out.push(['interrupted', 'bad']);
        if (rec.kind === 'clap' && !rec.audio) out.push(['NO SOUND', 'bad']);
        if (rec.disturbed) out.push(['volume changed during the sweep', 'bad']);
        if (!rec.location && rec.locationStatus !== 'pending') out.push(['no location', 'todo']);
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
        const unsent = saved.filter((r) => !r.sentAt).length;
        $('savedCount').textContent = saved.length ? ' ' + saved.length : '';
        $('savedSummary').textContent = saved.length ? saved.length + (saved.length === 1 ? ' measurement' : ' measurements') + ' on this phone, ' + (unsent ? unsent + ' not sent yet.' : 'all sent.') : '';
        $('recentTitle').textContent = saved.length + ' saved on this phone' + (unsent ? ', ' + unsent + ' not sent yet' : ', all sent') + '. Newest first' + (saved.length > 5 ? ' (the last 5; all are on the Saved tab)' : '') + ':';
    }
    // ---------- sessions and places ----------
    const SESSION_GAP_MIN = 30;
    // A measurement made within half an hour of the previous one continues that session; otherwise a new one starts
    // ... and so does one made at a different place: a new place is a new session.
    function currentSessionId() {
        const newest = saved[0];
        if (newest && newest.sessionId && Date.now() - new Date(newest.time).getTime() <= SESSION_GAP_MIN * 60000 &&
            placeKey(newest.sessionNote) === placeKey($('saveNote').value)) return newest.sessionId;
        return R.uuid();
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
        if (own.length === 1 && !saved.some((r) => !skip.has(r) && r.placeId === own[0])) { newPlaces.set(key, own[0]); return own[0]; }
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
        const places = $('placeList');
        places.textContent = '';
        placeNames().forEach((n) => { const o = document.createElement('option'); o.value = n; places.appendChild(o); });
    }
    const dateFi = (p) => { const d = p.date.split('-'); return Number(d[2]) + '.' + Number(d[1]) + '.' + d[0]; };
    const openRecs = new Set();     // records whose extra lines (location, photo, buttons) are unfolded
    let sessEdit = null;            // the session note being typed: { key, value, ids of the records it applies to }
    function renderSaved() {
        const host = $('savedList');
        // the list is rebuilt while a note may be being typed (a location arrives): keep the cursor where it was
        const active = document.activeElement;
        const typing = active && active.classList && (active.classList.contains('recNote') || active.classList.contains('sessNote'))
            ? { cls: active.classList.contains('recNote') ? 'recNote' : 'sessNote', id: active.dataset.id, at: active.selectionStart } : null;
        host.textContent = '';
        $('savedEmpty').hidden = saved.length > 0;
        summaries();
        // the newest few are also listed right under the chart, so each new measurement is seen to arrive
        $('recentBox').hidden = saved.length === 0;
        $('recentList').textContent = '';
        saved.slice(0, 5).forEach((rec) => {
            const b = document.createElement('button'), t = document.createElement('b');
            b.type = 'button';
            t.textContent = R.localParts(rec).time + ':' + R.localParts(rec).compact.slice(4);
            b.appendChild(t);
            b.appendChild(document.createTextNode(' ' + rec.kind + (rec.audio ? ' + sound' : '') + ' · ' + R.peakSummary(rec, 3) + (rec.note ? ' · ' + rec.note : '')));
            const bad = flags(rec).filter((f) => f[1] === 'bad').map((f) => f[0]);
            if (bad.length) { const w = document.createElement('span'); w.className = 'flag-bad'; w.textContent = ' · ' + bad.join(' · '); b.appendChild(w); }
            b.addEventListener('click', () => showRecord(rec));
            $('recentList').appendChild(b);
        });
        const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
        const groups = R.sessions(saved, SESSION_GAP_MIN);
        $('shareAll').hidden = groups.length < 2;
        refreshPlaces();
        groups.forEach((sess) => {
            const card = el('div', null, 'session');
            card.dataset.key = sess.key;
            const info = el('p', null, 'hint sessInfo');
            const describe = () => {
                const n = sess.records.length, sounds = sess.records.filter((r) => r.audio).length, unsent = sess.records.filter((r) => !r.sentAt).length;
                const bad = {};
                sess.records.forEach((r) => flags(r).forEach((f) => { if (f[1] === 'bad') bad[f[0]] = (bad[f[0]] || 0) + 1; }));
                info.textContent = n + (n === 1 ? ' measurement' : ' measurements') + (sounds ? ', ' + sounds + ' with sound' : '') + ' · ' + (unsent ? unsent + ' not sent yet' : 'all sent');
                Object.keys(bad).forEach((k) => { const w = el('span', ' · ' + bad[k] + ' × ' + k, 'flag-bad'); info.appendChild(w); });
            };
            card.appendChild(el('b', dateFi(sess.start) + ' ' + sess.start.time + (sess.end.time !== sess.start.time ? '–' + sess.end.time : ''), 'sessTitle'));
            describe();
            card.appendChild(info);
            // one note for the whole session; it does not replace a different note that single measurements already carry
            const sNote = document.createElement('input');
            sNote.type = 'text'; sNote.className = 'sessNote'; sNote.maxLength = 200; sNote.autocomplete = 'off';
            sNote.placeholder = 'Place or note for this whole session'; sNote.value = sess.note; sNote.dataset.id = sess.key;
            sNote.setAttribute('list', 'placeList');
            sNote.setAttribute('aria-label', 'Note for the session of ' + dateFi(sess.start) + ' ' + sess.start.time);
            // Typing here changes the measurements that carried the session's note when the field was entered
            // (and those with none). A measurement with a different note of its own was set on purpose: left alone.
            // The set is fixed for the whole edit and survives the list being rebuilt meanwhile.
            const edit = sessEdit && sessEdit.key === sess.key ? sessEdit : null;
            if (edit) sNote.value = edit.value;
            const begin = () => {
                if (sessEdit && sessEdit.key === sess.key) return sessEdit;
                const was = placeKey(sNote.value);
                sessEdit = { key: sess.key, value: sNote.value, ids: new Set(sess.records.filter((r) => placeKey(r.sessionNote) === was || !placeKey(r.sessionNote)).map((r) => r.id)) };
                return sessEdit;
            };
            const applySession = (text, final) => {
                const state = begin();
                state.value = text;
                const targets = new Set(sess.records.filter((r) => state.ids.has(r.id)));
                // the place identity is decided once, when the typing is done: the same name is the same place
                const pid = final ? placeIdFor(text, targets) : undefined;
                targets.forEach((r) => {
                    const samePlace = pid === undefined || (r.placeId || null) === (pid || null);
                    if ((r.sessionNote || '') === text && samePlace) return;                       // nothing new for this one
                    r.sessionNote = text;
                    if (pid !== undefined) r.placeId = pid || null;
                    touched(r);
                    clearTimeout(noteTimers.get(r.id));
                    const write = () => { noteTimers.delete(r.id); putRecord(r).catch((e) => savedMsg('The note could not be stored: ' + (e && e.message ? e.message : 'storage error') + '.')); };
                    if (final) write(); else noteTimers.set(r.id, setTimeout(write, 400));
                });
                sess.note = text;
                // a session still being measured: what is typed here also goes with its next measurements
                if (groups[0] === sess && Date.now() - new Date(sess.records[0].time).getTime() <= SESSION_GAP_MIN * 60000) { $('saveNote').value = text; noteTyped(); }
                if (final) { sessEdit = null; refreshPlaces(); }
                describe();
                summaries();
            };
            sNote.addEventListener('focus', begin);
            sNote.addEventListener('input', () => applySession(sNote.value.slice(0, 200), false));
            // 'change' does not always come (the field can be rebuilt under the cursor), so leaving the field finishes the edit too
            const done = () => { if (sessEdit && sessEdit.key === sess.key) applySession(sNote.value.trim().slice(0, 200), true); };
            sNote.addEventListener('change', done);
            sNote.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== sNote && !(document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('sessNote') && document.activeElement.dataset.id === sess.key)) done(); }, 0));
            card.appendChild(sNote);
            const sRow = el('div', null, 'row mt');
            const sKey = 'session:' + sess.key;
            const sendB = el('button', prepared.has(sKey) ? 'Tap to send' : 'Send session as one zip', 'ghost');
            sendB.type = 'button'; sendB.dataset.role = 'shareSession';
            sendB.addEventListener('click', () => send(sKey, () => prepareZip(sess.records.slice().reverse(), sess.fileBase), sendB, 'Send session as one zip'));
            sRow.appendChild(sendB);
            card.appendChild(sRow);
            const list = el('div', null, 'recs');
            sess.records.forEach((rec) => {
                const box = el('div', null, 'rec');
                box.dataset.id = rec.id;
                const p = R.localParts(rec);
                const head = el('p', null, 'recHead');
                head.appendChild(el('b', p.time + ':' + p.compact.slice(4)));
                head.appendChild(document.createTextNode(' ' + (rec.kind === 'sweep' ? 'Sweep' : 'Clap') + ' ' + rec.fMin + '–' + rec.fMax + ' Hz · ' + R.peakSummary(rec, 4) +
                    (rec.audio ? ' · sound ' + rec.audio.durationS.toFixed(1) + ' s' : '')));
                if (placeKey(rec.sessionNote) && placeKey(rec.sessionNote) !== placeKey(sess.note)) head.appendChild(el('span', ' · place: ' + rec.sessionNote, 'flag-todo'));
                box.appendChild(head);
                box.appendChild(flagLine(rec));
                // one line per measurement for a note about just that one, written as it is typed
                const line = el('div', null, 'noteLine');
                const note = document.createElement('input');
                note.type = 'text'; note.className = 'recNote'; note.maxLength = 200; note.autocomplete = 'off';
                note.placeholder = 'Note for this one (optional)'; note.value = rec.note || ''; note.dataset.id = rec.id;
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
                    const text = note.value.trim().slice(0, 200);
                    if (text !== rec.note) { rec.note = text; touched(rec); }
                    marks();
                    clearTimeout(noteTimers.get(rec.id));
                    writeNote();
                });
                line.appendChild(note);
                // location, photo and the buttons for this one measurement are folded away until asked for
                const more = el('div', null, 'more');
                more.hidden = !openRecs.has(rec.id);
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
                const loc = el('p', locationLine(rec) + ' ', 'hint');
                loc.dataset.role = 'location';
                if (rec.location) { const a = el('a', 'map'); a.href = R.mapsUrl(rec.location); a.target = '_blank'; a.rel = 'noopener'; loc.appendChild(a); }
                more.appendChild(loc);
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
                if (rec.sentAt && JSON.stringify(rec.location) !== JSON.stringify(before)) touched(rec);
                if (rec.location && rec.location.accuracyM != null && rec.location.accuracyM <= 10) finish('ok');
                else if (saved.includes(rec)) putRecord(rec).catch(() => {}).then(renderSaved);
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
    async function autoSave(interrupted) {
        if (curveState !== 'done') return;
        const d = roomDims();
        const kind = curveKind;
        const id = kind === 'sweep' ? sweepId : null;       // the same id as its checkpoint, so a recovery can never duplicate it
        if (kind === 'sweep') sweepId = null;
        const rec = R.makeRecord({
            id, time: new Date(), kind, sessionNote: $('saveNote').value, sessionId: currentSessionId(), placeId: placeIdFor($('saveNote').value),
            room: { name: settings.room, lengthM: d.L, widthM: d.W, heightM: d.H },
            tempC: settings.temp, fMin: settings.fMin, fMax: settings.fMax,
            sweepDurS: settings.sweepDur, speaker: settings.speaker,
            curve, peaks: lastPeaks, app: BUILD, locationStatus: 'pending',
            interrupted: !!interrupted, disturbed: kind === 'sweep' && disturbed,
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
        if (!ok) {
            saveNote('NOT STORED on the phone (' + storeError + '). The measurement of ' + at + ' is in the Saved list, held only while the app stays open: send it from there now. The app keeps trying to store it.', true);
        } else if (kind === 'clap' && !rec.audio) {
            saveNote(what + ', but WITHOUT ITS SOUND: the phone gave the app no raw sound for this clap. The spectrum and peaks are saved. Turn the microphone off and on before the next clap. It is number ' + saved.length + ' on the Saved tab.', true);
        } else {
            saveNote(what + (rec.audio ? ', with the sound of the clap' : '') + '. It is number ' + saved.length + ' on the Saved tab (top of the page): open it there to add a photo or send it.');
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
            if (a) files.push(new File([a], base + '.wav', { type: 'audio/wav' })); else missing.push('the sound');
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
        let useZip = !navigator.share || canShareFiles([new File([new Uint8Array(22)], 'probe.zip', { type: 'application/zip' })]);
        let parts = [{ name: base + '.json', type: 'application/json', bytes: new TextEncoder().encode(body), time: new Date() }];
        let sounds = 0, photos = 0;
        for (const rec of list) {
            const b = R.fileBase(rec), when = new Date(rec.time);
            let complete = true;
            if (rec.audio) {
                const a = await blobOf('audio', rec);
                if (a) { parts.push({ name: b + '.wav', type: 'audio/wav', bytes: new Uint8Array(a), time: when }); sounds++; }
                else { complete = false; missing.push('the sound of ' + recTitle(rec)); }
            }
            if (rec.photo) {
                const p = await blobOf('photos', rec);
                if (p) { parts.push({ name: b + '_photo.jpg', type: 'image/jpeg', bytes: new Uint8Array(p), time: when }); photos++; }
                else { complete = false; missing.push('the photo of ' + recTitle(rec)); }
            }
            if (complete) whole.push(rec);
        }
        const count = list.length + ' resonance measurement' + (list.length === 1 ? '' : 's');
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
        return last.start.date + '_to_' + first.end.date + '_all_' + saved.length + '-measurements'; })());

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
            try { pack = await build(); } catch (e) { savedMsg('Could not build the files: ' + (e && e.message ? e.message : 'unknown error') + '.'); button.disabled = false; return; }
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
            (pack.recs || []).forEach((r) => { if (saved.includes(r)) { r.sentAt = now; putRecord(r).catch(() => {}); } });
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
            prepared.set(key, pack);
            button.textContent = 'Tap to send';
        }
    }
    const shareRecord = (rec, button) => send(rec.id, () => prepareRecord(rec), button, 'Send');

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
            const fromDisk = all.filter((r) => !here.has(r.id) && !deleted.has(r.id));
            fromDisk.forEach((r) => {
                // a location search cut short by closing the app will never finish
                if (r.locationStatus === 'pending') r.locationStatus = r.location ? 'ok' : 'unavailable';
                // written as "without sound" while its sound was still on the way: if the sound did arrive, they belong together again
                if (r.audioPending && sounds.has(r.id)) { r.audio = r.audioPending; r.audioMissing = false; delete r.audioPending; putRecord(r).catch(() => {}); }
            });
            saved = saved.concat(fromDisk).sort((a, b) => (a.time < b.time ? 1 : -1));
            const adopted = adoptOldRecords(saved);
            adopted.forEach((r) => { putRecord(r).catch(() => {}); });
            if (adoptOldRecords.moved) {
                savedMsg('Measurements from before this version were grouped into sessions. Where every measurement of a session carried the same note, that note is now the session\'s note (' + adoptOldRecords.moved + ' measurements). Nothing was removed.');
                adoptOldRecords.moved = 0;
            }
            if (loadFailed) { loadFailed = false; storageWarn = ''; savedMsg(''); tabMarks(); }
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
        if (!loadFailed) recoverCheckpoints();
    }

    // ---------- Tabs ----------
    // Four sections of this one page. Switching shows and hides them and loads nothing,
    // so it works the same with no network. Sound and microphone keep running across tabs.
    function showTab(name, byUser) {
        if (!CHOICES.tab.includes(name)) name = DEFAULTS.tab;
        const changed = settings.tab !== name;
        if (byUser && !changed) return;     // tapping the open tab again must not disturb anything on it
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
    $('clap').addEventListener('click', recordClap);
    try { $('saveNote').value = localStorage.getItem('pyramid-res-note') || ''; } catch (e) { /* no stored note */ }
    $('saveNote').addEventListener('input', noteTyped);      // on every keystroke: iOS may never send 'change'
    $('saveNote').addEventListener('change', noteTyped);
    const again = () => { if (loadFailed) loadSaved().then(retryUnstored); else retryUnstored(); };
    setInterval(again, 15000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) again(); });
    $('openSaved').addEventListener('click', () => showTab('saved', true));
    $('photoInput').addEventListener('change', photoChosen);
    $('shareAll').addEventListener('click', () => send('all', async () => prepareAll(), $('shareAll'), 'Send everything as one zip'));

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
        return !!(voice || micOn || clapBusy || recording || curveState === 'done' || unstored.size || pendingWrites || locating || photoBusy || noteTimers.size || typing);
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
