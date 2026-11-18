/* PyramidResonance v2: single tones, sweep and microphone measurement. Maths lives in modes.js. */
(function () {
    'use strict';

    const M = window.Modes;
    const $ = (id) => document.getElementById(id);

    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('./sw.js').catch((err) => console.log('Service worker registration failed', err));
        });
    }

    // ---------- Settings ----------
    const DEFAULTS = { room: 'khufu', L: 5, W: 4, H: 2.5, temp: 20, fMin: 60, fMax: 250, volume: 0.5, filter: 'axial', sweepDur: 60 };
    const settings = Object.assign({}, DEFAULTS);
    try {
        const saved = JSON.parse(localStorage.getItem('pyramid-res-v2') || 'null');
        if (saved && typeof saved === 'object') {
            for (const k of Object.keys(DEFAULTS)) {
                if (typeof saved[k] === typeof DEFAULTS[k]) settings[k] = saved[k];
            }
        }
    } catch (e) { /* storage unavailable: defaults are fine */ }
    function save() {
        try { localStorage.setItem('pyramid-res-v2', JSON.stringify(settings)); } catch (e) { /* ignore */ }
    }

    let modes = [];       // every predicted mode in range
    let shown = [];       // modes after the filter, as listed
    let activeIdx = -1;   // index into shown of the playing tone

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
    function noteText(f) {
        const n = M.noteName(f);
        return n.name + ' ' + (n.cents >= 0 ? '+' : '') + n.cents + '¢';
    }

    function recompute() {
        const d = roomDims();
        const c = M.speedOfSound(settings.temp);
        let warn = '';
        if (!(settings.fMax > settings.fMin)) warn = '"To Hz" must be higher than "From Hz".';
        else if (!(d.L > 0 && d.W > 0 && d.H > 0)) warn = 'Enter length, width and height in metres.';
        modes = warn ? [] : M.roomModes(d.L, d.W, d.H, c, settings.fMin, settings.fMax);
        shown = modes.filter((m) => settings.filter === 'all' || m.type === 'axial' || (settings.filter === 'tangential' && m.type === 'tangential'));
        $('roomWarn').textContent = warn;
        const r = M.ROOMS[settings.room];
        $('roomNote').textContent = (r ? r.note + ' ' : '') + 'Speed of sound ' + c.toFixed(1) + ' m/s. ' +
            modes.length + ' modes in range, ' + shown.length + ' listed.';
        activeIdx = -1;
        renderList();
        drawChart();
    }

    function renderList() {
        const host = $('modeList');
        host.textContent = '';
        shown.forEach((m, i) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'mode' + (i === activeIdx ? ' active' : '');
            b.setAttribute('role', 'listitem');
            const f = document.createElement('b'); f.textContent = m.f.toFixed(1) + ' Hz';
            const n = document.createElement('span'); n.textContent = noteText(m.f);
            const t = document.createElement('span'); t.textContent = describe(m);
            b.append(f, n, t);
            b.addEventListener('click', () => playMode(i));
            host.appendChild(b);
        });
        $('prev').disabled = $('next').disabled = shown.length === 0;
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
    }

    // ---------- Audio output ----------
    let ctx = null;
    let voice = null;     // { osc, gain, kind: 'tone' | 'sweep', f1, f2, t0, dur }
    let wakeLock = null;

    function setSessionType(type) {
        // Safari: lets Web Audio play with the silent switch on, and choose routing with the mic
        try { if (navigator.audioSession) navigator.audioSession.type = type; } catch (e) { /* not supported */ }
    }

    async function ensureCtx() {
        if (!ctx) {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) throw new Error('This browser has no Web Audio support.');
            ctx = new AC();
        }
        if (ctx.state !== 'running') await ctx.resume();
        return ctx;
    }

    function stopVoice() {
        const v = voice;
        voice = null;
        if (v && ctx) {
            const t = ctx.currentTime;
            try {
                v.gain.gain.cancelScheduledValues(t);
                v.gain.gain.setValueAtTime(v.gain.gain.value, t);
                v.gain.gain.linearRampToValueAtTime(0, t + 0.08);
                v.osc.stop(t + 0.1);
            } catch (e) { /* already stopped */ }
        }
        if (wakeLock) { try { wakeLock.release(); } catch (e) { /* ignore */ } wakeLock = null; }
    }

    function startVoice(kind, f1, f2, dur) {
        stopVoice();
        const t = ctx.currentTime + 0.02;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(f1, t);
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(settings.volume, t + 0.08);
        osc.connect(gain);
        gain.connect(ctx.destination);
        const v = { osc, gain, kind, f1, f2, t0: t, dur };
        if (kind === 'sweep') {
            osc.frequency.exponentialRampToValueAtTime(f2, t + dur);
            gain.gain.setValueAtTime(settings.volume, t + dur);
            gain.gain.linearRampToValueAtTime(0, t + dur + 0.08);
            osc.stop(t + dur + 0.1);
        }
        osc.onended = () => {
            osc.disconnect();
            gain.disconnect();
            if (voice === v) { voice = null; onStopped(v); }
        };
        osc.start(t);
        voice = v;
        return v;
    }

    function setNow(freqText, info) {
        $('nowFreq').textContent = freqText;
        $('nowInfo').textContent = info;
    }

    function setButtons() {
        $('stop').disabled = !voice;
        $('sweep').textContent = voice && voice.kind === 'sweep' ? 'Stop sweep' : 'Start sweep';
    }

    function onStopped(v) {
        if (v && v.kind === 'sweep') finishSweep();
        setNow('–', 'Nothing playing');
        activeIdx = -1;
        renderList();
        setButtons();
        drawChart();
    }

    async function playMode(i) {
        if (!shown.length) return;
        const idx = ((i % shown.length) + shown.length) % shown.length;
        const m = shown[idx];
        try {
            await ensureCtx();
        } catch (e) { $('audioWarn').textContent = e.message; return; }
        $('audioWarn').textContent = '';
        if (voice && voice.kind === 'sweep') abortSweep();
        startVoice('tone', m.f, m.f, 0);
        activeIdx = idx;
        setNow(m.f.toFixed(1) + ' Hz', noteText(m.f) + ' · ' + describe(m));
        renderList();
        const el = $('modeList').children[idx];
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
        setButtons();
        drawChart();
    }

    function stopAll() {
        const v = voice;
        stopVoice();
        if (v && v.kind === 'sweep') abortSweep();
        onStopped(null);
    }

    // ---------- Sweep ----------
    let curve = [];          // measured points [{ f, db }]
    let curveKind = '';      // 'sweep' | 'clap'
    let sweepTimer = null;
    let lastSweepF = 0;

    function currentSweepFreq() {
        if (!voice || voice.kind !== 'sweep') return null;
        const t = (ctx.currentTime - voice.t0) / voice.dur;
        return M.sweepFreq(voice.f1, voice.f2, t);
    }

    async function toggleSweep() {
        if (voice && voice.kind === 'sweep') { stopAll(); return; }
        if (!(settings.fMax > settings.fMin)) return;
        try {
            await ensureCtx();
        } catch (e) { $('audioWarn').textContent = e.message; return; }
        $('audioWarn').textContent = '';
        activeIdx = -1;
        renderList();
        if (micOn) { curve = []; curveKind = 'sweep'; $('peaks').textContent = ''; }
        lastSweepF = 0;
        startVoice('sweep', settings.fMin, settings.fMax, settings.sweepDur);
        try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { wakeLock = null; }
        clearInterval(sweepTimer);
        sweepTimer = setInterval(sweepTick, 50);
        setButtons();
    }

    function sweepTick() {
        const f = currentSweepFreq();
        if (f == null) { clearInterval(sweepTimer); sweepTimer = null; return; }
        setNow(f.toFixed(1) + ' Hz', 'Sweeping · ' + noteText(f));
        if (micOn && curveKind === 'sweep' && ctx.currentTime >= voice.t0 && f >= lastSweepF * 1.004) {
            // the tone moves during one FFT window: search as many bins as it can cross
            const windowS = analyser.fftSize / ctx.sampleRate;
            const rate = f * Math.log(voice.f2 / voice.f1) / voice.dur;
            const db = levelAt(f, rate * windowS);
            if (db != null) { curve.push({ f, db }); lastSweepF = f; }
        }
        drawChart(f);
    }

    function abortSweep() {
        clearInterval(sweepTimer);
        sweepTimer = null;
    }

    function finishSweep() {
        abortSweep();
        if (curveKind === 'sweep' && curve.length > 10) showPeaks(M.findPeaks(curve, 4, 12));
    }

    // ---------- Microphone ----------
    let micOn = false;
    let micStream = null;
    let micSource = null;
    let analyser = null;
    let spectrum = null;
    let meterTimer = null;
    let clapTimer = null;

    function levelAt(f, spanHz) {
        if (!analyser) return null;
        analyser.getFloatFrequencyData(spectrum);
        const binHz = ctx.sampleRate / analyser.fftSize;
        const centre = Math.round(f / binHz);
        const half = Math.max(2, Math.ceil((spanHz || 0) / binHz) + 1);
        let best = -Infinity;
        for (let k = Math.max(1, centre - half); k <= Math.min(spectrum.length - 1, centre + half); k++) {
            if (spectrum[k] > best) best = spectrum[k];
        }
        return Number.isFinite(best) ? best : null;
    }

    async function toggleMic() {
        if (micOn) { micOff(); return; }
        $('micWarn').textContent = '';
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            $('micWarn').textContent = 'No microphone access in this browser. It needs https and a recent browser.';
            return;
        }
        try {
            setSessionType('play-and-record');
            await ensureCtx();
            micStream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
            });
            micSource = ctx.createMediaStreamSource(micStream);
            analyser = ctx.createAnalyser();
            analyser.fftSize = 32768;
            analyser.smoothingTimeConstant = 0;
            spectrum = new Float32Array(analyser.frequencyBinCount);
            micSource.connect(analyser); // analysis only: never routed to the speaker
            micOn = true;
            $('mic').textContent = 'Turn microphone off';
            $('mic').classList.add('on');
            $('clap').disabled = false;
            meterTimer = setInterval(meterTick, 100);
        } catch (e) {
            micOff();
            $('micWarn').textContent = 'Microphone not available: ' + (e && e.message ? e.message : e);
        }
    }

    function micOff() {
        clearInterval(meterTimer); meterTimer = null;
        clearInterval(clapTimer); clapTimer = null;
        if (micSource) { try { micSource.disconnect(); } catch (e) { /* ignore */ } }
        if (micStream) micStream.getTracks().forEach((t) => t.stop());
        micSource = null; micStream = null; analyser = null; spectrum = null;
        micOn = false;
        setSessionType('playback');
        $('mic').textContent = 'Turn microphone on';
        $('mic').classList.remove('on');
        $('clap').disabled = true;
        $('clap').textContent = 'Record a clap (4 s)';
        $('meterBar').style.width = '0';
        $('meterText').textContent = 'Microphone off';
    }

    function meterTick() {
        if (!micOn) return;
        let f = null, label = 'loudest in range';
        if (voice && voice.kind === 'tone') { f = voice.f1; label = 'at ' + f.toFixed(1) + ' Hz'; }
        else if (voice && voice.kind === 'sweep') { f = currentSweepFreq(); label = 'at sweep tone'; }
        let db;
        if (f != null) db = levelAt(f, 0);
        else {
            analyser.getFloatFrequencyData(spectrum);
            const binHz = ctx.sampleRate / analyser.fftSize;
            db = -Infinity;
            for (let k = Math.max(1, Math.floor(settings.fMin / binHz)); k <= Math.min(spectrum.length - 1, Math.ceil(settings.fMax / binHz)); k++) {
                if (spectrum[k] > db) db = spectrum[k];
            }
        }
        if (db == null || !Number.isFinite(db)) { $('meterText').textContent = 'Listening…'; return; }
        const pct = Math.max(0, Math.min(100, (db + 100) / 80 * 100)); // -100..-20 dB
        $('meterBar').style.width = pct + '%';
        $('meterText').textContent = db.toFixed(1) + ' dB ' + label;
    }

    function recordClap() {
        if (!micOn || clapTimer) return;
        if (voice) stopAll();
        const binHz = ctx.sampleRate / analyser.fftSize;
        const k0 = Math.max(1, Math.floor(settings.fMin / binHz));
        const k1 = Math.min(spectrum.length - 1, Math.ceil(settings.fMax / binHz));
        const hold = new Float32Array(k1 - k0 + 1).fill(-Infinity);
        const tEnd = ctx.currentTime + 4;
        $('clap').disabled = true;
        $('clap').textContent = 'Clap now…';
        clapTimer = setInterval(() => {
            if (!micOn) return;
            analyser.getFloatFrequencyData(spectrum);
            for (let k = k0; k <= k1; k++) if (spectrum[k] > hold[k - k0]) hold[k - k0] = spectrum[k];
            if (ctx.currentTime >= tEnd) {
                clearInterval(clapTimer); clapTimer = null;
                curve = [];
                for (let k = k0; k <= k1; k++) if (Number.isFinite(hold[k - k0])) curve.push({ f: k * binHz, db: hold[k - k0] });
                curveKind = 'clap';
                $('clap').disabled = false;
                $('clap').textContent = 'Record a clap (4 s)';
                showPeaks(M.findPeaks(curve, 6, 14));
                drawChart();
            }
        }, 60);
    }

    // ---------- Results ----------
    function showPeaks(peaks) {
        const host = $('peaks');
        host.textContent = '';
        if (!peaks.length) {
            const p = document.createElement('p');
            p.className = 'hint';
            p.textContent = 'No clear peaks found. Try more volume, a corner position, or a longer sweep.';
            host.appendChild(p);
            return;
        }
        const table = document.createElement('table');
        const head = document.createElement('tr');
        ['Measured', 'Note', 'Nearest predicted', 'Miss'].forEach((h) => { const th = document.createElement('th'); th.textContent = h; head.appendChild(th); });
        table.appendChild(head);
        peaks.slice(0, 12).forEach((p) => {
            const near = M.nearestMode(modes, p.f);
            const tr = document.createElement('tr');
            const cells = [p.f.toFixed(1) + ' Hz', noteText(p.f),
                near ? near.mode.f.toFixed(1) + ' Hz ' + describe(near.mode) : '–',
                near ? (near.errorPct >= 0 ? '+' : '') + near.errorPct.toFixed(1) + ' %' : '–'];
            cells.forEach((c) => { const td = document.createElement('td'); td.textContent = c; tr.appendChild(td); });
            table.appendChild(tr);
        });
        host.appendChild(table);
    }

    function drawChart(cursorF) {
        const cv = $('chart');
        const g = cv.getContext('2d');
        const Wd = cv.width, Hd = cv.height;
        const padL = 70, padR = 16, padT = 44, padB = 44;
        g.clearRect(0, 0, Wd, Hd);
        g.fillStyle = '#0b0b0b';
        g.fillRect(0, 0, Wd, Hd);
        const f1 = settings.fMin, f2 = settings.fMax;
        if (!(f2 > f1) || !(f1 > 0)) return;
        const x = (f) => padL + (Wd - padL - padR) * Math.log(f / f1) / Math.log(f2 / f1);
        g.font = '22px system-ui, sans-serif';
        g.textBaseline = 'middle';
        // frequency grid
        g.strokeStyle = '#2c2c2c'; g.fillStyle = '#a8a8a8'; g.lineWidth = 1; g.textAlign = 'center';
        [20, 30, 40, 50, 60, 80, 100, 150, 200, 300, 400, 600, 800, 1000, 1500, 2000, 3000].forEach((f) => {
            if (f < f1 || f > f2) return;
            g.beginPath(); g.moveTo(x(f), padT); g.lineTo(x(f), Hd - padB); g.stroke();
            g.fillText(f + ' Hz', x(f), Hd - padB / 2);
        });
        // predicted modes (the ones listed under "Single tones")
        shown.forEach((m) => {
            const axial = m.type === 'axial';
            g.strokeStyle = axial ? '#d4af37' : '#6f5c1d';
            g.lineWidth = axial ? 3 : 1;
            g.beginPath(); g.moveTo(x(m.f), 6); g.lineTo(x(m.f), axial ? 34 : 20); g.stroke();
        });
        // measured curve
        if (curve.length > 1) {
            let lo = Infinity, hi = -Infinity;
            curve.forEach((p) => { if (p.db < lo) lo = p.db; if (p.db > hi) hi = p.db; });
            lo = Math.max(lo, hi - 60);
            if (hi - lo < 10) lo = hi - 10;
            const y = (db) => padT + (Hd - padT - padB) * (1 - (Math.max(db, lo) - lo) / (hi - lo));
            g.fillStyle = '#a8a8a8'; g.textAlign = 'right';
            g.fillText(hi.toFixed(0) + ' dB', padL - 8, padT + 4);
            g.fillText(lo.toFixed(0) + ' dB', padL - 8, Hd - padB - 4);
            g.strokeStyle = '#d4af37'; g.lineWidth = 3; g.lineJoin = 'round';
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
            g.strokeStyle = '#fff'; g.lineWidth = 2; g.setLineDash([8, 8]);
            g.beginPath(); g.moveTo(x(cf), padT); g.lineTo(x(cf), Hd - padB); g.stroke();
            g.setLineDash([]);
        }
        $('chartTitle').textContent = curveKind === 'clap' ? 'Measurement: clap spectrum' : curveKind === 'sweep' ? 'Measurement: sweep' : 'Measurement';
    }

    // ---------- Wiring ----------
    function num(id, key, lo, hi) {
        $(id).addEventListener('change', () => {
            const v = parseFloat($(id).value);
            if (Number.isFinite(v)) settings[key] = Math.min(hi, Math.max(lo, v));
            if (voice) stopAll();
            curve = []; curveKind = ''; $('peaks').textContent = '';
            save(); syncInputs(); recompute();
        });
    }
    num('dimL', 'L', 0.5, 100); num('dimW', 'W', 0.5, 100); num('dimH', 'H', 0.5, 100);
    num('temp', 'temp', -20, 50); num('fMin', 'fMin', 10, 2000); num('fMax', 'fMax', 20, 4000);

    $('room').addEventListener('change', () => {
        const prev = roomDims();
        settings.room = $('room').value;
        if (settings.room === 'custom' && !(settings.L > 0 && settings.W > 0 && settings.H > 0)) Object.assign(settings, prev);
        if (voice) stopAll();
        curve = []; curveKind = ''; $('peaks').textContent = '';
        save(); syncInputs(); recompute();
    });
    $('modeFilter').addEventListener('change', () => {
        settings.filter = $('modeFilter').value;
        if (voice && voice.kind === 'tone') stopAll();
        save(); recompute();
    });
    $('sweepDur').addEventListener('change', () => { settings.sweepDur = parseInt($('sweepDur').value, 10) || 60; save(); });
    $('volume').addEventListener('input', () => {
        settings.volume = parseFloat($('volume').value);
        if (voice && ctx && voice.kind === 'tone') voice.gain.gain.setTargetAtTime(settings.volume, ctx.currentTime, 0.03);
        save();
    });
    $('prev').addEventListener('click', () => playMode(activeIdx < 0 ? shown.length - 1 : activeIdx - 1));
    $('next').addEventListener('click', () => playMode(activeIdx + 1));
    $('stop').addEventListener('click', stopAll);
    $('sweep').addEventListener('click', toggleSweep);
    $('mic').addEventListener('click', toggleMic);
    $('clap').addEventListener('click', recordClap);

    setSessionType('playback');
    syncInputs();
    recompute();
    setButtons();
})();
