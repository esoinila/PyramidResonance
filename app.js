/* PyramidResonance v2: single tones, sweep and microphone measurement. Maths lives in modes.js. */
(function () {
    'use strict';

    const M = window.Modes;
    const $ = (id) => document.getElementById(id);

    // Must equal VERSION in sw.js (a test checks it). Change both for every release:
    // the new sw.js is what makes phones fetch the new files, all at once.
    const BUILD = '2.0.0';
    const MATCH_TOL = 1.5;    // percent: how close a measured peak must be to a listed mode

    if ('serviceWorker' in navigator) {
        const hadController = !!navigator.serviceWorker.controller;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (!hadController) return;           // first install: this page is already the new version
            let reloaded = false;
            try { reloaded = sessionStorage.getItem('pyramid-res-reloaded') === BUILD; sessionStorage.setItem('pyramid-res-reloaded', BUILD); } catch (e) { /* ignore */ }
            if (!reloaded && !voice && !micOn && !clapBusy) { location.reload(); return; }
            $('updateNote').hidden = false;
        });
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then((reg) => {
                // a home-screen app is often resumed, not relaunched: look for an update then too
                document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
            }).catch((err) => console.log('Service worker registration failed', err));
        });
    }

    // ---------- Settings ----------
    const MAX_MODES = 6000;   // refuse ranges that would compute more than this
    const MAX_LISTED = 400;   // buttons in the tone list
    const DEFAULTS = { room: 'khufu', L: 5, W: 4, H: 2.5, temp: 20, fMin: 60, fMax: 250, volume: 0.5, filter: 'axial', sweepDur: 60, speaker: 'bt' };
    const LIMITS = { L: [0.5, 100], W: [0.5, 100], H: [0.5, 100], temp: [-20, 50], fMin: [10, 2000], fMax: [20, 4000], volume: [0, 1] };
    const CHOICES = { room: ['khufu', 'khafre', 'menkaure', 'custom'], filter: ['axial', 'tangential', 'all'], sweepDur: [30, 60, 120], speaker: ['bt', 'direct'] };
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
            if (kids[idx].scrollIntoView) kids[idx].scrollIntoView({ block: 'nearest' });
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
        try {
            await ensureCtx();
            if (clapBusy) return;
            if (voice && voice.kind === 'sweep') abortSweep();
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
        recording = false;
        cancelClap();
        onStopped(null);
    }

    // ---------- Sweep ----------
    let curve = [];           // measured points [{ f, db }]
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
            $('audioWarn').textContent = 'Set "To Hz" higher than "From Hz" in the Room card first.';
            return;
        }
        try {
            await ensureCtx();
            if (clapBusy) return;
            abortSweep();
            recording = micOn;
            if (recording) { curve = []; curveKind = 'sweep'; disturbed = false; $('peaks').textContent = ''; }
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
                    if (db != null) { curve.push({ f: fr, db }); lastReadF = fr; }
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
        if (wasRecording && curveKind === 'sweep' && curve.length > 10) showPeaks(M.findPeaks(curve, 4, 30));   // +-30 points is about +-12 %: wide enough for a broad peak
        else if (wasRecording) showPeaks([]);
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

    function cancelClap(message) {
        if (!clapBusy) return;
        clapRun++;
        clearInterval(clapTimer); clapTimer = null;
        clapBusy = false;
        if (message) $('micWarn').textContent = message;
        setClapButton();
        setButtons();
    }

    async function recordClap() {
        if (!micOn || clapBusy || micBusy) return;
        if (!(settings.fMax > settings.fMin)) {
            $('micWarn').textContent = 'Set "To Hz" higher than "From Hz" in the Room card first.';
            return;
        }
        if (voice) stopAll();
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
                if (now >= maxStart || (now >= minStart && settled)) startMs = now;
                else return;
            }
            if (now < startMs + 4000) {
                $('clap').textContent = 'Clap now…';
                fine.getFloatFrequencyData(fineSpectrum);
                for (let k = k0; k <= k1; k++) if (fineSpectrum[k] > hold[k - k0]) hold[k - k0] = fineSpectrum[k];
                return;
            }
            clearInterval(clapTimer); clapTimer = null;
            clapBusy = false;
            curve = [];
            for (let k = k0; k <= k1; k++) if (Number.isFinite(hold[k - k0])) curve.push({ f: k * binHz, db: hold[k - k0] });
            curveKind = 'clap';
            disturbed = false;
            setClapButton();
            setButtons();
            const peaks = M.findPeaks(curve, 6, 14);
            if (oldF != null) peaks.forEach((p) => { if (Math.abs(p.f - oldF) / oldF * 100 <= MATCH_TOL) p.echo = true; });
            showPeaks(peaks);
            drawChart();
        }, 60);
    }

    // ---------- Results ----------
    function showPeaks(peaks) {
        const host = $('peaks');
        host.textContent = '';
        const note = (text) => { const p = document.createElement('p'); p.className = 'hint'; p.textContent = text; host.appendChild(p); };
        if (!peaks.length) {
            if (curveKind === 'sweep' && settings.fMax / settings.fMin < 1.25) {
                note('No clear peaks found. This range is too narrow to tell a peak from its surroundings: widen "From Hz" and "To Hz" so the sweep covers more than the peak itself.');
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
        const padL = 52, padR = 10, padT = 24, padB = 22;
        g.fillStyle = '#0b0b0b';
        g.fillRect(0, 0, Wd, Hd);
        $('chartTitle').textContent = curveKind === 'clap' ? 'Measurement: clap spectrum' : curveKind === 'sweep' ? 'Measurement: sweep' : 'Measurement';
        const f1 = settings.fMin, f2 = settings.fMax;
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
        shown.forEach((m) => {
            const axial = m.type === 'axial';
            g.strokeStyle = axial ? '#d4af37' : '#6f5c1d';
            g.lineWidth = axial ? 2 : 1;
            g.beginPath(); g.moveTo(x(m.f), 3); g.lineTo(x(m.f), axial ? 18 : 10); g.stroke();
        });
        // measured curve
        if (curve.length > 1) {
            let lo = Infinity, hi = -Infinity;
            curve.forEach((p) => { if (p.db < lo) lo = p.db; if (p.db > hi) hi = p.db; });
            lo = Math.max(lo, hi - 60);
            if (hi - lo < 10) lo = hi - 10;
            const y = (db) => padT + (Hd - padT - padB) * (1 - (Math.max(db, lo) - lo) / (hi - lo));
            g.fillStyle = '#a8a8a8'; g.textAlign = 'right';
            g.fillText(hi.toFixed(0) + ' dB', padL - 6, padT + 6);
            g.fillText(lo.toFixed(0) + ' dB', padL - 6, Hd - padB - 6);
            g.strokeStyle = '#d4af37'; g.lineWidth = 2; g.lineJoin = 'round';
            g.beginPath();
            let started = false;
            curve.forEach((p) => {
                if (p.f < f1 || p.f > f2) return;
                if (!started) { g.moveTo(x(p.f), y(p.db)); started = true; } else g.lineTo(x(p.f), y(p.db));
            });
            g.stroke();
        }
        // cursor: sweep position or the playing tone
        const cf = cursorF != null ? cursorF : (voice && voice.kind === 'tone' ? voice.f1 : null);
        if (cf != null && cf >= f1 && cf <= f2) {
            g.strokeStyle = '#fff'; g.lineWidth = 1; g.setLineDash([4, 4]);
            g.beginPath(); g.moveTo(x(cf), padT); g.lineTo(x(cf), Hd - padB); g.stroke();
            g.setLineDash([]);
        }
    }

    // ---------- Wiring ----------
    // Apply a settings change. A change that would need too many modes is undone.
    function change(mutate) {
        const before = Object.assign({}, settings);
        mutate();
        sanitize(settings);
        if (voice || clapBusy) stopAll();
        curve = []; curveKind = ''; recording = false; $('peaks').textContent = '';
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
    $('sweep').addEventListener('click', toggleSweep);
    $('mic').addEventListener('click', toggleMic);
    $('clap').addEventListener('click', recordClap);

    // A hidden page cannot be trusted to keep playing: stop, so the screen never lies
    document.addEventListener('visibilitychange', () => {
        if (document.hidden && (voice || clapBusy)) stopAll();
    });
    window.addEventListener('resize', () => drawChart());

    $('build').textContent = 'Version ' + BUILD;
    $('reload').addEventListener('click', () => location.reload());
    setSessionType('playback');
    syncInputs();
    if (!recompute()) {
        // a stored range that is too large: fall back to the default range, keep the room
        settings.fMin = DEFAULTS.fMin; settings.fMax = DEFAULTS.fMax; settings.filter = DEFAULTS.filter;
        syncInputs(); recompute(); save();
    }
    setClapButton();
})();
