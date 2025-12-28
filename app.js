// Register Service Worker for offline support
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then(reg => console.log('Service Worker registered', reg))
            .catch(err => console.log('Service Worker registration failed', err));
    });
}

let audioCtx;
let oscillators = [];
let masterGain;
// Frequencies based on Christopher Dunn's research (Earth Harmonic / F# chord)
const frequencies = [16.39, 29.32, 32.79, 33.6, 36.66, 43.99, 46.37, 46.94, 49.18, 54.86, 57.26, 58.65, 59.11, 60.9, 65.57, 65.98, 67.19, 67.59, 69.16, 71.83, 73.31, 73.68, 74.76, 76.54, 78.96, 81.96, 83.26, 87.05, 87.97, 88.28];

const playBtn = document.getElementById('play');
const stopBtn = document.getElementById('stop');

playBtn.addEventListener('click', async () => {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }

    if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
    }

    // Create master gain to control overall volume and prevent clipping
    masterGain = audioCtx.createGain();
    masterGain.connect(audioCtx.destination);
    masterGain.gain.setValueAtTime(0, audioCtx.currentTime);
    masterGain.gain.linearRampToValueAtTime(1.0, audioCtx.currentTime + 2); // 2 second fade in

    // Create a compressor to handle the summing of many oscillators
    const compressor = audioCtx.createDynamicsCompressor();
    compressor.threshold.setValueAtTime(-24, audioCtx.currentTime);
    compressor.knee.setValueAtTime(30, audioCtx.currentTime);
    compressor.ratio.setValueAtTime(12, audioCtx.currentTime);
    compressor.attack.setValueAtTime(0.003, audioCtx.currentTime);
    compressor.release.setValueAtTime(0.25, audioCtx.currentTime);

    // Connect master gain to compressor, then compressor to destination
    masterGain.disconnect();
    masterGain.connect(compressor);
    compressor.connect(audioCtx.destination);

    frequencies.forEach(freq => {
        let osc = audioCtx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq;

        let oscGain = audioCtx.createGain();
        // Lower individual gain significantly because we have 30 oscillators
        oscGain.gain.value = 0.05;

        osc.connect(oscGain);
        oscGain.connect(masterGain);

        osc.start();
        oscillators.push({ osc, gain: oscGain });
    });

    playBtn.disabled = true;
    stopBtn.disabled = false;
});

stopBtn.addEventListener('click', () => {
    if (masterGain) {
        // Fade out to prevent popping
        const fadeOutTime = 2;
        masterGain.gain.customRampToValueAtTime(masterGain.gain.value, audioCtx.currentTime); // Anchor
        masterGain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + fadeOutTime);

        setTimeout(() => {
            oscillators.forEach(o => {
                o.osc.stop();
                o.osc.disconnect();
                o.gain.disconnect();
            });
            oscillators = [];
            if (audioCtx) {
                audioCtx.close().then(() => {
                    audioCtx = null;
                });
            }
        }, fadeOutTime * 1000);
    }

    playBtn.disabled = false;
    stopBtn.disabled = true;
});

// Polyfill for customRampToValueAtTime if needed in older browsers, 
// though generally standard methods work. Logic handled in click handler.
AudioParam.prototype.customRampToValueAtTime = function (value, time) {
    this.setValueAtTime(value, time); // Simple anchor for now
};