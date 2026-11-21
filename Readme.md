# PyramidResonance

A small web app for finding the notes a stone room rings at. It predicts the room modes of a rectangular chamber, plays them one at a time or as a slow sweep, and can listen with the phone's microphone to show which frequencies the room actually amplifies.

Presets cover the King's Chamber of the Great Pyramid and the burial chambers of Khafre and Menkaure. Any other room works too: enter its length, width and height.

The idea comes from Christopher Dunn's *The Giza Power Plant*, which proposes that the King's Chamber was built with acoustic resonance in mind. The app takes no side on that; it only measures.

## Using it

1. Open `index.html` over https (GitHub Pages works) and add it to the home screen. After the first load it works offline.
2. Pick the chamber, or choose "Custom room" and type the size in metres.
3. Put the speaker in a corner. Stand in another corner.
4. **Single tones:** step through the list. A resonance is a tone that is clearly louder than its neighbours.
5. **Sweep:** glides from "From Hz" to "To Hz". With the microphone on, the level is plotted and the peaks are listed next to the nearest predicted mode.
6. **Clap:** with the microphone on, press "Record a clap" and clap once. No speaker needed.

No speaker at all? Hum a slow slide in pitch. The room answers when you cross a mode. In the King's Chamber the fourth height mode sits near 117 Hz (A♯2).

### What a small speaker can do

Version 1 played thirty frequencies between 16 and 88 Hz at once. Small Bluetooth speakers produce almost nothing below about 60 Hz, so most of that list was silent, and thirty tones together hide a resonance. Version 2 defaults to 60–250 Hz and plays one tone at a time.

### Microphone notes

- The microphone needs https and your permission. Nothing is uploaded. The sound is analysed on the phone and discarded, with one exception: the 4 seconds of a clap are kept if you save that measurement with "Keep the sound" ticked.
- Sweep readings are shifted back by the analyser window and the speaker delay. Set "Sound comes from" to Bluetooth or Phone/cable so the right delay is used; a Bluetooth speaker's exact delay is unknown, so sweep peaks are good to a fraction of a percent, not better. The clap has no such error.
- Not yet tested on a real iPhone: whether the tone stays on a Bluetooth speaker while the microphone is on.
- On iPhones, turning the microphone on can make the tone quieter or move it to the earpiece. If that happens, turn the microphone off and judge by ear, or use the clap test.
- The measured curve includes the speaker's and the microphone's own frequency response. Peaks are judged against the local trend for that reason.

### Saving measurements
After a clap or a measured sweep, "Save this measurement" stores the spectrum on the phone with the time, an optional note and the location (the best fix of the first 15 seconds, with its accuracy). Each saved measurement can be shown again, given a photo, sent, or deleted.

- **Photo**: taken or picked through the phone's own chooser and kept inside the app at 1600 px. A web page cannot write to the photo gallery; the photo travels with the measurement when it is sent.
- **Sound**: a saved clap keeps its raw sound unless "Keep the sound" is unticked: the 4 seconds of the "Clap now" window, mono, exactly as the microphone gave it (32-bit float WAV at the phone's sample rate, about 0.8 MB). The on-screen spectrum only covers "From Hz" to "To Hz"; the sound file holds everything, for analysis later on a computer. Sweeps do not keep their sound.
- **Send**: opens the share sheet with up to four files: the data (`.json`), the chart (`.png`), the photo (`.jpg`) and the sound (`.wav`). Mail, Files, AirDrop or any other app can take them. "Send all as one file" gives one `.json` with every measurement, without photos or sound.
- **Data format**: `schema: pyramid-resonance-measurement/1`, with `time` (UTC) and `tzOffsetMin`, `location` (`lat`, `lon`, `accuracyM`, `altitudeM`), `fMin`/`fMax`, `peaks` and `curve` as `[Hz, dB]` pairs. The dB values are relative, not calibrated. `audio` is `null`, or describes the sound file sent beside it (`sampleRate`, `samples`, `durationS`, `format: float32`).
- The location needs "Precise Location" allowed for the page. Without it the measurement is still saved.

### Versions and updates
The page shows its version at the bottom. The app keeps a complete copy of itself on the phone and runs from that copy, so it opens with no signal. When the phone is online and a newer version exists, the whole new set is downloaded together and the page reloads itself (or shows a "Load the new version" button if something is playing). A release needs the same new number in `BUILD` in `app.js` and `VERSION` in `sw.js`; a test checks that they match.

### Reading the peak table
A measured peak is shown as matching a listed mode only if it is within 1.5 %. Under the table the app says how often a random frequency would match by chance; with a crowded list that is often, so one match proves little. Trust peaks that return when the measurement is repeated, and several peaks that fit together.

## The model

Rigid-walled rectangular room:

$$
f_{n_x, n_y, n_z} = \frac{c}{2} \sqrt{ \left( \frac{n_x}{L} \right)^2 + \left( \frac{n_y}{W} \right)^2 + \left( \frac{n_z}{H} \right)^2 }
$$

- `c` is the speed of sound, `331.3 * sqrt(1 + T/273.15)` m/s. At 20 °C that is 343.2 m/s (1126 ft/s).
- Axial modes (one non-zero index) are the strongest, tangential next, oblique weakest.
- Real chambers have doorways, shafts, a granite box and visitors. Expect measured peaks within a few percent of the prediction.
- Khafre's chamber has a gabled ceiling and Menkaure's a vaulted one, so their height modes are rough.

King's Chamber dimensions are Petrie's 1883 means: 412.35 × 206.26 × 230.39 inches (10.474 × 5.239 × 5.852 m).

Axial modes of the King's Chamber, 60–250 Hz at 20 °C:

| Direction | Frequencies (Hz) |
|---|---|
| Length | 65.5, 81.9, 98.3, 114.7, 131.1, 147.5, 163.8, 180.2, 196.6, 213.0, 229.4, 245.8 |
| Width | 65.5, 98.3, 131.0, 163.8, 196.5, 229.3 |
| Height | 88.0, 117.3, 146.6, 176.0, 205.3, 234.6 |

## Files

- `index.html`, `app.js`: the interface, audio and measurement
- `modes.js`: the maths, shared by the browser and the tests
- `records.js`: the saved-measurement format, shared by the browser and the tests
- `sw.js`, `manifest.json`, `icon.svg`: offline support and home-screen install
- `calculate_resonance.py`: the same calculation in Python, for checking by hand
- `test/modes.test.js`: unit tests, run with `node --test test/*.js`
- `test/smoke.py`: browser test of the whole app with a simulated room and microphone, run with `python3 test/smoke.py` (needs Playwright and Chrome)

## Sources

- Christopher Dunn, *The Giza Power Plant* (1998), [gizapower.com](https://gizapower.com/)
- W. M. Flinders Petrie, *The Pyramids and Temples of Gizeh* (1883), [PDF](https://gizamedia.rc.fas.harvard.edu/images/MFA-images/Giza/GizaImage/full/library/petrie_gizeh.pdf)
- [The acoustics of the Great Pyramid](https://somercanales.substack.com/p/the-acoustics-of-the-great-pyramid), a discussion of reported resonances near 121 Hz

## License

MIT License. Feel free to modify and share.
