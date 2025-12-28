# PyramidResonance

A simple web application that generates and plays the calculated resonant frequencies of the Great Pyramid's King's Chamber using pure sine waves via the Web Audio API. This project is inspired by theories suggesting the chamber was designed with acoustic properties in mind, potentially for energy amplification or harmonic resonance with Earth's natural frequencies.

## Description

This app allows users to play a combination of resonant frequencies derived from the dimensions of the King's Chamber in the Great Pyramid of Giza. The frequencies are based on standard acoustic calculations for a rectangular enclosure, using measurements from W.M. Flinders Petrie and assuming a speed of sound of approximately 1126 ft/s (adjusted for typical pyramid conditions). These ideas draw from Christopher Dunn's work in *The Giza Power Plant: Technologies of Ancient Egypt*, where he proposes the pyramid functioned as an advanced energy device involving acoustic resonance.

The app plays all frequencies simultaneously as sine waves at low volume to avoid distortion. Low frequencies (e.g., below 20 Hz) may be felt as vibrations rather than heard, depending on your audio setup.

Note: Some theories link these resonances to Earth's Schumann resonances (fundamental ~7.83 Hz, octaves like ~15.66 Hz), suggesting harmonic alignment for power generation or other purposes.

## Frequencies

The following resonant frequencies (in Hz) are used in the app, calculated for modes up to a certain order to stay within the audible/infrasound range:

- 16.39, 29.32, 32.79, 33.6, 36.66, 43.99, 46.37, 46.94, 49.18, 54.86, 57.26, 58.65, 59.11, 60.9, 65.57, 65.98, 67.19, 67.59, 69.16, 71.83, 73.31, 73.68, 74.76, 76.54, 78.96, 81.96, 83.26, 87.05, 87.97, 88.28

These are derived using the formula for resonant frequencies in a rectangular room:

\[ f_{n_x, n_y, n_z} = \frac{v}{2} \sqrt{ \left( \frac{n_x}{L} \right)^2 + \left( \frac{n_y}{W} \right)^2 + \left( \frac{n_z}{H} \right)^2 } \]

Where:
- \( v \) = speed of sound (~1126 ft/s)
- \( L \) = length (~34.36 ft)
- \( W \) = width (~17.19 ft)
- \( H \) = height (~19.20 ft)
- \( n_x, n_y, n_z \) = mode integers (starting from 1, excluding all-zero)

Dimensions are averages from Petrie's surveys (e.g., length 412.35 inches, converted to feet).

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

This project is for educational and experimental purposes—test it in the pyramid if you get the chance!

## License

MIT License. Feel free to modify and share.