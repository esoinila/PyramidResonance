# PyramidResonance

A simple web application that generates and plays the calculated resonant frequencies of the Great Pyramid's King's Chamber using pure sine waves via the Web Audio API. This project is inspired by theories suggesting the chamber was designed with acoustic properties in mind, potentially for energy amplification or harmonic resonance with Earth's natural frequencies.

## Description

This app allows users to play a combination of resonant frequencies derived from the dimensions of the King's Chamber in the Great Pyramid of Giza. The frequencies are based on standard acoustic calculations for a rectangular enclosure, using measurements from W.M. Flinders Petrie and assuming a speed of sound of approximately 1126 ft/s (adjusted for typical pyramid conditions). These ideas draw from Christopher Dunn's work in *The Giza Power Plant: Technologies of Ancient Egypt*, where he proposes the pyramid functioned as an advanced energy device involving acoustic resonance.

The app plays all frequencies simultaneously as sine waves at low volume to avoid distortion. Low frequencies (e.g., below 20 Hz) may be felt as vibrations rather than heard, depending on your audio setup.

Note: Some theories link these resonances to Earth's Schumann resonances (fundamental ~7.83 Hz, octaves like ~15.66 Hz), suggesting harmonic alignment for power generation or other purposes.

## Frequencies

The app calculates and plays resonant frequencies for the known chambers of the main Giza pyramids.

### Khufu (Great Pyramid - King's Chamber)
16.39, 29.32, 32.79, 33.6, 36.66, 43.99, 46.37, 46.94, 49.18, 54.86, 57.26, 58.65, 59.11, 60.9, 65.57, 65.98, 67.19, 67.59, 69.16, 71.83, 73.31, 73.68, 74.76, 76.54, 78.96, 81.96, 83.26, 87.05, 87.97, 88.28 Hz

### Khafre (Burial Chamber)
12.11, 24.22, 25.02, 27.8, 34.12, 34.82, 36.21, 36.32, 41.84, 42.31, 44.01, 44.11, 48.43, 48.75, 49.84, 50.04, 51.49, 54.51, 55.6, 55.76, 59.24, 60.54, 60.57, 61.77, 61.84, 64.31, 65.23, 65.51, 68.24, 69.31, 69.49, 69.64, 70.63, 72.41, 72.69, 73.69, 73.86, 75.07, 76.04, 76.61, 77.31, 77.55, 78.54, 78.88, 81.26, 82.46, 83.34, 83.39, 83.68, 84.63, 85.49, 85.64, 85.94, 87.34, 88.02, 89.33, 90.1, 91.22, 92.09, 94.59, 95.63, 96.44, 97.5 Hz

### Menkaure (Burial Chamber)
25.74, 48.96, 51.47, 55.31, 64.96, 69.87, 71.04, 77.21, 81.34, 82.88, 85.32, 91.42, 96.26, 97.91 Hz

## Calculation Code

The frequencies are derived using the formula for resonant frequencies in a rectangular room:

$$
f_{n_x, n_y, n_z} = \frac{v}{2} \sqrt{ \left( \frac{n_x}{L} \right)^2 + \left( \frac{n_y}{W} \right)^2 + \left( \frac{n_z}{H} \right)^2 }
$$

Where:
- \( v \) = speed of sound (~1126 ft/s)
- \( L, W, H \) = dimensions of the chamber
- \( n_x, n_y, n_z \) = mode integers (starting from 0, excluding all-zero)

You can find the Python script used for these calculations in this repository: [`calculate_resonance.py`](calculate_resonance.py).

```python
import math

def calculate_resonant_frequencies(L, W, H, v=1126, max_mode=5, max_freq=100):
    frequencies = []
    for nx in range(0, max_mode+1):
        for ny in range(0, max_mode+1):
            for nz in range(0, max_mode+1):
                if nx == ny == nz == 0:
                    continue
                f = (v / 2) * math.sqrt((nx / L)**2 + (ny / W)**2 + (nz / H)**2)
                if f <= max_freq:
                    frequencies.append(round(f, 2))
    frequencies.sort()
    return list(set(frequencies))
```

## Usage

1. Open `index.html` in a modern web browser (e.g., Chrome, Firefox).
2. Click "Play Resonance" to start all frequencies.
3. Click "Stop" to halt playback.

For mobile use, bookmark the page or host it on a server (e.g., Azure App Service) for easy access during travel. Test on headphones or speakers—adjust gain in `app.js` if clipping occurs.

No installation required; it's pure HTML/JavaScript.

## Sources and Inspiration

- **Christopher Dunn's Theories**: From *The Giza Power Plant* (1998), proposing the pyramid as an acoustic energy device. See [official site](https://gizapower.com/) and [book on Amazon](https://www.amazon.com/Giza-Power-Plant-Technologies-Ancient/dp/1879181738).
- **Acoustic Analysis**: Discussions on pyramid acoustics, including resonances around 121 Hz and lower harmonics. See [this Substack article](https://somercanales.substack.com/p/the-acoustics-of-the-great-pyramid) for a breakdown.
- **Petrie's Measurements**: Exact dimensions from W.M. Flinders Petrie's *The Pyramids and Temples of Gizeh* (1883). Full text available [here (PDF)](https://gizamedia.rc.fas.harvard.edu/images/MFA-images/Giza/GizaImage/full/library/petrie_gizeh.pdf). Key averages: Length 412.35 inches, Width 206.26 inches, Height 230.39 inches.
- **Schumann Resonance Connection**: Pyramid resonances may align with Earth's electromagnetic resonances. Fundamental Schumann ~7.83 Hz; octaves include ~15.66 Hz (close to the chamber's fundamental ~16 Hz). See [Wikipedia on Schumann resonances](https://en.wikipedia.org/wiki/Schumann_resonances).

This project is for educational purposes. 

## License

MIT License. Feel free to modify and share.
