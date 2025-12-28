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

const frequencySets = {
    khufu: [16.39, 29.32, 32.79, 33.6, 36.66, 43.99, 46.37, 46.94, 49.18, 54.86, 57.26, 58.65, 59.11, 60.9, 65.57, 65.98, 67.19, 67.59, 69.16, 71.83, 73.31, 73.68, 74.76, 76.54, 78.96, 81.96, 83.26, 87.05, 87.97, 88.28],
    khafre: [12.11, 24.22, 25.02, 27.8, 34.12, 34.82, 36.21, 36.32, 41.84, 42.31, 44.01, 44.11, 48.43, 48.75, 49.84, 50.04, 51.49, 54.51, 55.6, 55.76, 59.24, 60.54, 60.57, 61.77, 61.84, 64.31, 65.23, 65.51, 68.24, 69.31, 69.49, 69.64, 70.63, 72.41, 72.69, 73.69, 73.86, 75.07, 76.04, 76.61, 77.31, 77.55, 78.54, 78.88, 81.26, 82.46, 83.34, 83.39, 83.68, 84.63, 85.49, 85.64, 85.94, 87.34, 88.02, 89.33, 90.1, 91.22, 92.09, 94.59, 95.63, 96.44, 97.5],
    menkaure: [25.74, 48.96, 51.47, 55.31, 64.96, 69.87, 71.04, 77.21, 81.34, 82.88, 85.32, 91.42, 96.26, 97.91]
};

const playBtn = document.getElementById('play');
const stopBtn = document.getElementById('stop');
const pyramidSelect = document.getElementById('pyramid-select');

// Stop audio when changing pyramids if currently playing
pyramidSelect.addEventListener('change', () => {
    if (stopBtn.disabled === false) { // If currently playing
        stopAudio();
    }
});

playBtn.addEventListener('click', async () => {
    const selectedPyramid = pyramidSelect.value;
    const currentFrequencies = frequencySets[selectedPyramid];

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

    currentFrequencies.forEach(freq => {
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

stopBtn.addEventListener('click', stopAudio);

function stopAudio() {
    if (masterGain) {
        // Fade out to prevent popping
        const fadeOutTime = 2;
        try {
            masterGain.gain.customRampToValueAtTime(masterGain.gain.value, audioCtx.currentTime); // Anchor
            masterGain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + fadeOutTime);
        } catch (e) {
            console.error("Error setting gain ramp", e);
        }

        setTimeout(() => {
            oscillators.forEach(o => {
                try {
                    o.osc.stop();
                    o.osc.disconnect();
                    o.gain.disconnect();
                } catch (e) { /* ignore */ }
            });
            oscillators = [];
            // Keep context open for faster restart, or close if you prefer strict cleanup
            // For stability on mobile, keeping it suspended or just stopping oscs is often safer, 
            // but original requirement drove closing. Let's keep it consistent.
            if (audioCtx) {
                audioCtx.close().then(() => {
                    audioCtx = null;
                });
            }
        }, fadeOutTime * 1000);
    }

    playBtn.disabled = false;
    stopBtn.disabled = true;
}

// Polyfill for customRampToValueAtTime if needed in older browsers, 
// though generally standard methods work. Logic handled in click handler.
AudioParam.prototype.customRampToValueAtTime = function (value, time) {
    this.setValueAtTime(value, time); // Simple anchor for now
};