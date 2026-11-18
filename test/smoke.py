"""Browser smoke test for the whole app. Needs Playwright and Chrome:

    python3 test/smoke.py

The page's sound output is looped through a simulated room (one resonance at
117.3 Hz, behind a 0.2 s "Bluetooth" delay) into a fake microphone, so a sweep
and a "clap" can be measured without any hardware. It also checks the offline
cache and the update path. Exits non-zero if any check fails.
"""
import asyncio, functools, http.server, os, re, shutil, sys, tempfile, threading
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
F0 = 117.3

INIT = r"""
(() => {
  const RealAC = window.AudioContext;
  window.__osc = { created: 0, live: new Set() };
  window.__wl = { requested: 0, released: 0 };
  class AC extends RealAC {
    constructor(...a) { super(...a); window.__ctx = this; window.__makeLoop(%F0%, 15); }
    get outputLatency() { return 0; }   // the only delay is the one the loop adds
    get baseLatency() { return 0; }
  }
  window.AudioContext = AC;
  const realCreate = RealAC.prototype.createOscillator;
  RealAC.prototype.createOscillator = function () {
    const o = realCreate.call(this); window.__osc.created++; window.__osc.live.add(o);
    o.addEventListener('ended', () => window.__osc.live.delete(o)); return o;
  };
  const realConnect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...r) {
    if (window.__ctx && dest === window.__ctx.destination && window.__loop) realConnect.call(this, window.__loop.input);
    return realConnect.call(this, dest, ...r);
  };
  window.__makeLoop = (f0, Q) => {
    const c = window.__ctx;
    const input = c.createGain();
    const meter = c.createAnalyser(); meter.fftSize = 2048; realConnect.call(input, meter);
    window.__level = () => { const d = new Float32Array(2048); meter.getFloatTimeDomainData(d); let s = 0; for (const v of d) s += v * v; return Math.sqrt(s / d.length); };
    const lag = c.createDelay(1); lag.delayTime.value = window.__LOOP_DELAY || 0;
    realConnect.call(input, lag);
    const direct = c.createGain(); direct.gain.value = 0.05;
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f0; bp.Q.value = Q;
    const out = c.createMediaStreamDestination();
    realConnect.call(lag, direct); realConnect.call(direct, out);
    realConnect.call(lag, bp); realConnect.call(bp, out);
    const nb = c.createBuffer(1, c.sampleRate * 2, c.sampleRate); const d = nb.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 1e-4;
    const ns = c.createBufferSource(); ns.buffer = nb; ns.loop = true; realConnect.call(ns, out); ns.start();
    window.__loop = { input, out };
  };
  // a "clap": a short noise burst fed into the simulated room
  window.__clap = () => {
    const c = window.__ctx;
    const b = c.createBuffer(1, c.sampleRate * 0.02, c.sampleRate); const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const s = c.createBufferSource(); s.buffer = b; realConnect.call(s, window.__loop.input); s.start();
  };
  window.__gumCalls = 0; window.__tracks = [];
  navigator.mediaDevices.getUserMedia = async () => {
    window.__gumCalls++;
    await new Promise((r) => setTimeout(r, 300));
    if (!window.__ctx) throw new Error('no audio context before microphone');
    const s = window.__loop.out.stream.clone(); s.getTracks().forEach((t) => window.__tracks.push(t)); return s;
  };
  Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: async () => {
    window.__wl.requested++; await new Promise((r) => setTimeout(r, 5));
    return { release() { window.__wl.released++; return Promise.resolve(); }, addEventListener() {} };
  } } });
})();
""".replace('%F0%', str(F0))

failures = []
def check(ok, what, detail=''):
    print(('ok   ' if ok else 'FAIL ') + what + (('  ' + str(detail)) if detail != '' else ''))
    if not ok: failures.append(what)

def serve(root=ROOT):
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a, **k): pass
        def handle(self):
            try: super().handle()
            except (BrokenPipeError, ConnectionResetError): pass
    handler = functools.partial(Quiet, directory=root)
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv

LIVE = "window.__osc.live.size"
PEAKS = "[...document.querySelectorAll('#peaks tr')].filter(r => r.querySelector('td')).map(r => [...r.children].map(c => c.textContent))"

SHARE_MOCK = r"""
window.__shares = [];
navigator.canShare = (d) => !!(d && d.files && d.files.length);
navigator.share = async (d) => {
  if (window.__SHARE_REFUSE_ONCE) { window.__SHARE_REFUSE_ONCE = false; const e = new Error('no gesture'); e.name = 'NotAllowedError'; throw e; }
  const files = [];
  for (const f of d.files) files.push({ name: f.name, type: f.type, size: f.size, text: f.type === 'application/json' ? await f.text() : null });
  window.__shares.push({ title: d.title, text: d.text, files });
};
0;
"""

async def new_page(browser, url, pre='', geo='grant'):
    ctx = await browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, service_workers='block',
        permissions=['geolocation'] if geo == 'grant' else [], geolocation={'latitude': -13.509812345, 'longitude': -71.981712345, 'accuracy': 7})
    page = await ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    await page.add_init_script(pre + INIT)
    await page.goto(url)
    return page, errors

async def main():
    srv = serve()
    url = 'http://127.0.0.1:%d/index.html' % srv.server_address[1]
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('CHROME', '/usr/bin/google-chrome'), headless=True,
            args=['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'])

        # ---- tones and the stepper
        page, errors = await new_page(browser, url)
        n = await page.evaluate("modeList.children.length")
        check(n > 10, 'axial modes are listed', n)
        await page.click('#next'); await page.wait_for_timeout(400)
        first = await page.evaluate("nowFreq.textContent")
        check(await page.evaluate(LIVE) == 1, 'Next plays exactly one tone', first)
        await page.click('#next'); await page.click('#next'); await page.wait_for_timeout(500)
        check(await page.evaluate(LIVE) == 1, 'still one tone after fast stepping')
        third = await page.evaluate("nowFreq.textContent")
        rows = await page.evaluate("[...modeList.children].map(b => b.firstChild.textContent)")
        check(len(set(rows)) == len(rows), 'no two list rows show the same frequency', rows[:4])
        check(third == rows[2], 'three taps reach the third row', third)
        await page.click('#stop'); await page.wait_for_timeout(500)
        check(await page.evaluate(LIVE) == 0, 'Stop silences everything')
        await page.click('#next'); await page.wait_for_timeout(300)
        fourth = await page.evaluate("nowFreq.textContent")
        check(float(fourth.split()[0]) > float(third.split()[0]), 'the stepper carries on after Stop', third + ' -> ' + fourth)
        check(await page.evaluate("document.querySelectorAll('#modeList [aria-current]').length") == 1, 'one list row is marked current')
        await page.click('#stop'); await page.wait_for_timeout(300)
        wl = await page.evaluate("window.__wl")
        check(wl['requested'] == wl['released'] and wl['requested'] > 0, 'screen wake lock is released', wl)

        # ---- three taps in one go, before the first has finished starting
        await page.evaluate("next.click(); next.click(); next.click()"); await page.wait_for_timeout(500)
        check(await page.evaluate("nowFreq.textContent") == rows[6 % len(rows)], 'taps faster than the audio start still step on', await page.evaluate("nowFreq.textContent"))
        await page.click('#stop'); await page.wait_for_timeout(300)

        # ---- audio interrupted while a tone plays
        await page.click('#next'); await page.wait_for_timeout(300)
        await page.evaluate("window.__ctx.suspend()"); await page.wait_for_timeout(400)
        check(await page.evaluate("document.getElementById('stop').disabled && audioWarn.textContent !== ''"), 'an interruption stops the tone and says so', await page.evaluate("audioWarn.textContent"))
        await page.click('#next'); await page.wait_for_timeout(400)
        check(await page.evaluate("window.__ctx.state") == 'running' and await page.evaluate(LIVE) == 1, 'the next tap resumes audio')
        await page.click('#stop'); await page.wait_for_timeout(300)

        # ---- sweep, and the volume slider during it
        await page.click('#sweep'); await page.wait_for_timeout(600)
        check(await page.evaluate(LIVE) == 1, 'the sweep starts one oscillator', await page.evaluate("nowFreq.textContent"))
        f_a = float((await page.evaluate("nowFreq.textContent")).split()[0])
        await page.wait_for_timeout(1500)
        f_b = float((await page.evaluate("nowFreq.textContent")).split()[0])
        check(f_b > f_a, 'the sweep frequency rises', '%s -> %s' % (f_a, f_b))
        loud = await page.evaluate("window.__level()")
        await page.evaluate("volume.value = 0.1; volume.dispatchEvent(new Event('input', {bubbles: true}))"); await page.wait_for_timeout(400)
        quiet = await page.evaluate("window.__level()")
        check(loud > 0.1 and quiet < loud * 0.4, 'the volume slider changes a running sweep', '%.3f -> %.3f' % (loud, quiet))
        await page.click('#stop'); await page.wait_for_timeout(400)
        check(await page.evaluate(LIVE) == 0, 'Stop ends the sweep')

        # ---- wide range does not freeze or stick
        await page.select_option('#modeFilter', 'all')
        await page.fill('#fMax', '4000'); await page.dispatch_event('#fMax', 'change'); await page.wait_for_timeout(200)
        check(await page.evaluate("modeList.children.length") <= 401, 'the list stays bounded for a wide range',
              await page.evaluate("roomWarn.textContent + ' / ' + roomNote.textContent"))
        await page.fill('#fMin', '300'); await page.fill('#fMax', '250'); await page.dispatch_event('#fMax', 'change')
        check(await page.evaluate("roomWarn.textContent.includes('must be higher') && next.disabled && modeList.children.length === 0"),
              'a reversed range warns and empties the list', await page.evaluate("roomWarn.textContent"))
        await page.click('#sweep'); await page.wait_for_timeout(300)
        check(await page.evaluate(LIVE) == 0 and await page.evaluate("audioWarn.textContent !== ''"), 'and a sweep refuses to start', await page.evaluate("audioWarn.textContent"))
        check(not errors, 'no page errors (tones)', errors)
        await page.close()

        # ---- garbage in storage
        bad = '{"volume":7,"fMin":-5,"fMax":99999,"sweepDur":0,"room":"atlantis","L":-1,"temp":900,"speaker":"moon"}'
        page, errors = await new_page(browser, url, "localStorage.setItem('pyramid-res-v2', %r);" % bad)
        st = await page.evaluate("({room: room.value, vol: Number(volume.value), dur: sweepDur.value, sp: speaker.value, lo: Number(fMin.value), hi: Number(fMax.value), n: modeList.children.length})")
        check(st['room'] == 'khufu' and st['vol'] <= 1 and st['dur'] in ('30', '60', '120') and st['sp'] in ('bt', 'direct') and st['lo'] < st['hi'], 'bad stored settings are repaired', st)
        check(not errors, 'no page errors (bad storage)', errors)
        await page.close()

        # ---- microphone, sweep measurement, clap
        page, errors = await new_page(browser, url, 'window.__LOOP_DELAY = 0.2;')
        await page.select_option('#speaker', 'bt')
        await page.select_option('#sweepDur', '30')
        check('Version' in await page.evaluate("build.textContent"), 'the page shows its version', await page.evaluate("build.textContent"))

        # microphone turned on in the middle of a sweep must not start a half curve
        await page.click('#sweep'); await page.wait_for_timeout(800)
        await page.click('#mic'); await page.wait_for_timeout(2500)
        check(await page.evaluate("chart.dataset.points") == '0' and await page.evaluate("document.getElementById('stop').disabled") is False, 'microphone on mid-sweep records nothing', await page.evaluate("chart.dataset.points"))
        await page.click('#stop'); await page.wait_for_timeout(300)
        await page.click('#mic'); await page.wait_for_timeout(300)
        check(await page.evaluate("window.__tracks.every(t => t.readyState === 'ended')"), 'microphone off ends the stream')

        await page.click('#mic'); await page.click('#mic', force=True)   # double tap
        await page.wait_for_timeout(1200)
        tracks = await page.evaluate("window.__tracks.filter(t => t.readyState === 'live').length")
        check(tracks <= 1, 'a double tap leaves at most one live microphone stream', tracks)
        if tracks == 0:
            await page.click('#mic'); await page.wait_for_timeout(1000)
        check(await page.evaluate("meterText.textContent") != 'Microphone off', 'the level meter runs', await page.evaluate("meterText.textContent"))
        await page.click('#sweep')
        await page.wait_for_timeout(31500)
        rows = await page.evaluate(PEAKS)
        got = [float(r[0].split()[0]) for r in rows] if rows else []
        best = min(got, key=lambda f: abs(f - F0)) if got else None
        # 5.6 Hz/s here: dropping the delay correction would shift the peak by 1.4 %, flipping it by 2.8 %
        check(best is not None and abs(best - F0) / F0 < 0.012, 'the sweep finds the %.1f Hz resonance within 1.2 %% through a 0.2 s delay' % F0, rows)
        check(any('height ×4' in ' '.join(r) for r in rows), 'and names the fourth height mode')
        check(await page.evaluate(LIVE) == 0, 'no oscillator is left after the sweep')

        # clap while a tone plays must not be measured
        # clap with a reversed range: refused, nothing sticks
        await page.fill('#fMin', '300'); await page.dispatch_event('#fMin', 'change')
        await page.click('#clap'); await page.wait_for_timeout(300)
        check(await page.evaluate("micWarn.textContent !== '' && !sweep.disabled && !clap.disabled"), 'a clap with a reversed range is refused and locks nothing', await page.evaluate("micWarn.textContent"))
        await page.fill('#fMin', '60'); await page.dispatch_event('#fMin', 'change')

        # audio paused while idle: the meter must say so, and a clap must wake it, not measure a frozen frame
        await page.evaluate("window.__ctx.suspend()"); await page.wait_for_timeout(400)
        check('paused' in await page.evaluate("meterText.textContent"), 'the meter says when audio is paused', await page.evaluate("meterText.textContent"))

        await page.evaluate("window.__ctx.resume()"); await page.wait_for_timeout(200)
        await page.click('#next'); await page.click('#next'); await page.wait_for_timeout(1500)
        old = float((await page.evaluate("nowFreq.textContent")).split()[0])
        check(abs(old - F0) > 20, 'the tone before the clap is away from the resonance', old)
        await page.evaluate("window.__ctx.suspend()"); await page.wait_for_timeout(300)
        await page.click('#clap'); await page.wait_for_timeout(300)
        check(await page.evaluate("window.__ctx.state") == 'running', 'a clap tap resumes paused audio')
        check(await page.evaluate(LIVE) == 0, 'starting a clap recording stops the tone')
        check(await page.evaluate("next.disabled && sweep.disabled"), 'and locks the other controls while it runs')
        waited = 0
        while waited < 10000:                    # wait for the "clap now" phase, then clap
            await page.wait_for_timeout(100); waited += 100
            if 'now' in (await page.evaluate("clap.textContent")).lower(): break
        check(waited >= 1500, 'it waits for the old tone to die away first', '%d ms' % waited)
        await page.wait_for_timeout(300)
        await page.evaluate("window.__clap()")
        await page.wait_for_timeout(1200)
        await page.evaluate("window.__clap()")     # twice: one 20 ms burst can be lost to an audio glitch on a busy machine
        await page.wait_for_timeout(4800)
        rows = await page.evaluate(PEAKS)
        got = [float(r[0].split()[0]) for r in rows] if rows else []
        best = min(got, key=lambda f: abs(f - F0)) if got else None
        check(best is not None and abs(best - F0) / F0 < 0.02, 'the clap finds the resonance within 2 %', rows)
        check(not any(abs(f - old) < 2 for f in got), 'and does not report the %.1f Hz tone that was playing before' % old, got)
        check(await page.evaluate("chartTitle.textContent.includes('clap')"), 'the chart says it shows a clap')

        # leaving the page stops sound
        await page.click('#next'); await page.wait_for_timeout(300)
        await page.evaluate("Object.defineProperty(document, 'hidden', {configurable: true, get: () => true}); Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => 'hidden'}); document.dispatchEvent(new Event('visibilitychange'))")
        await page.wait_for_timeout(500)
        check(await page.evaluate(LIVE) == 0, 'hiding the page stops the tone')
        await page.click('#mic', force=True); await page.wait_for_timeout(300)
        wl = await page.evaluate("window.__wl")
        check(wl['requested'] == wl['released'], 'wake lock balanced at the end', wl)
        check(await page.evaluate("window.__tracks.every(t => t.readyState === 'ended')"), 'the microphone is released when turned off')
        check(not errors, 'no page errors (microphone)', errors)

        # ---- saving the measurement, with location, photo and sending
        import json, base64
        check(await page.evaluate("!saveBox.hidden && !saveBtn.disabled"), 'a finished clap can be saved')
        await page.evaluate(SHARE_MOCK)
        await page.fill('#saveNote', 'Test room, niche 3')
        await page.click('#saveBtn')
        await page.wait_for_function("document.querySelectorAll('#savedList .rec').length === 1", timeout=5000)
        check(await page.evaluate("saveBtn.disabled && saveBtn.textContent === 'Saved'"), 'the same measurement cannot be saved twice')
        await page.wait_for_function("document.querySelector('#savedList [data-role=location]').textContent.includes('-13.50981')", timeout=20000)
        loc = await page.evaluate("document.querySelector('#savedList [data-role=location]').textContent")
        check('-71.98171' in loc and '±7 m' in loc and 'improving' not in loc, 'the location is stored with its accuracy', loc)
        check((await page.evaluate("document.querySelector('#savedList .rec a').href")).startswith('https://maps.google.com/?q=-13.509812,-71.981712'), 'with a map link')
        check('Test room, niche 3' in await page.evaluate("document.querySelector('#savedList .rec b').textContent"), 'the note is shown')

        # a second measurement, then look at the first again
        await page.click('#mic'); await page.wait_for_timeout(900)
        await page.click('#clap')
        waited = 0
        while waited < 12000:
            await page.wait_for_timeout(100); waited += 100
            if 'now' in (await page.evaluate("clap.textContent")).lower(): break
        await page.evaluate("window.__clap()"); await page.wait_for_timeout(5200)
        check(await page.evaluate("!saveBox.hidden && !saveBtn.disabled"), 'a new measurement can be saved again')
        await page.click('#saveBtn')
        await page.wait_for_function("document.querySelectorAll('#savedList .rec').length === 2", timeout=5000)
        check(await page.evaluate("!shareAll.hidden"), 'two saved measurements offer "send all"')
        await page.click('#savedList .rec:last-child [data-role=show]'); await page.wait_for_timeout(300)
        check(await page.evaluate("chartTitle.textContent.startsWith('Saved: ') && chartTitle.textContent.includes('niche 3') && saveBox.hidden"), 'a saved measurement can be shown again', await page.evaluate("chartTitle.textContent"))
        check('117' in await page.evaluate("peaks.textContent"), 'with its peaks')
        await page.click('#next'); await page.wait_for_timeout(300)
        check(await page.evaluate("chartTitle.textContent.includes('clap spectrum') && !saveBox.hidden"), 'playing a tone returns to the live measurement')
        await page.click('#stop', force=True); await page.wait_for_timeout(200)

        # photo
        png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')
        big = await page.evaluate("""(async () => { const c = document.createElement('canvas'); c.width = 3200; c.height = 2400; const g = c.getContext('2d'); g.fillStyle = '#964'; g.fillRect(0, 0, 3200, 2400);
            const b = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.8)); const a = new Uint8Array(await b.arrayBuffer()); let s = ''; for (const v of a) s += String.fromCharCode(v); return btoa(s); })()""")
        async with page.expect_file_chooser() as fc:
            await page.click('#savedList .rec:last-child [data-role=photo]')
        await (await fc.value).set_files({'name': 'IMG_0001.jpg', 'mimeType': 'image/jpeg', 'buffer': base64.b64decode(big)})
        await page.wait_for_function("document.querySelector('#savedList .rec:last-child img') && document.querySelector('#savedList .rec:last-child img').naturalWidth > 0", timeout=8000)
        check(await page.evaluate("document.querySelector('#savedList .rec:last-child img').naturalWidth") == 1600, 'a photo is attached, reduced to 1600 px')
        async with page.expect_file_chooser() as fc:
            await page.click('#savedList .rec:first-child [data-role=photo]')
        await (await fc.value).set_files({'name': 'notes.txt', 'mimeType': 'text/plain', 'buffer': b'not a picture'})
        await page.wait_for_function("savedMsg.textContent.includes('could not be added')", timeout=5000)
        check(await page.evaluate("document.querySelectorAll('#savedList img').length") == 1, 'a file that is not a picture is refused with a message', await page.evaluate("savedMsg.textContent"))

        # sending: refused once (no tap), then sent on the second tap
        await page.evaluate("window.__SHARE_REFUSE_ONCE = true")
        await page.click('#savedList .rec:last-child [data-role=share]')
        await page.wait_for_function("document.querySelector('#savedList .rec:last-child [data-role=share]').textContent === 'Tap to send'", timeout=5000)
        await page.click('#savedList .rec:last-child [data-role=share]'); await page.wait_for_timeout(500)
        shares = await page.evaluate("window.__shares")
        names = [f['name'] for f in shares[0]['files']] if shares else []
        check(len(shares) == 1 and len(names) == 3 and names[0].endswith('-test-room-niche-3.json') and names[1].endswith('-chart.png') and names[2].endswith('-photo.jpg'), 'sending one measurement gives data, chart and photo', names)
        data = json.loads(shares[0]['files'][0]['text']) if shares else {}
        check(data.get('schema') == 'pyramid-resonance-measurement/1' and len(data.get('curve', [])) > 50 and abs(data['location']['lat'] + 13.509812) < 1e-6
              and data['location']['accuracyM'] == 7 and data['note'] == 'Test room, niche 3' and data['photo']['width'] == 1600 and data['kind'] == 'clap'
              and any(abs(p['f'] - F0) < 3 for p in data['peaks']), 'the data file holds the spectrum, peaks, place and note', {k: data.get(k) for k in ('time', 'location', 'peaks')})
        check('Location: -13.50981' in shares[0]['text'] and 'maps.google.com' in shares[0]['text'], 'and the message text names the place')
        check(shares[0]['files'][1]['size'] > 3000 and shares[0]['files'][2]['size'] > 3000, 'chart and photo files are not empty')
        await page.click('#shareAll'); await page.wait_for_timeout(500)
        shares = await page.evaluate("window.__shares")
        everything = json.loads(shares[-1]['files'][0]['text'])
        check(len(shares) == 2 and everything['count'] == 2 and everything['measurements'][0]['note'] == 'Test room, niche 3', '"send all" gives one file with both, oldest first')

        # still there after closing and reopening the app
        await page.reload()
        await page.wait_for_function("document.querySelectorAll('#savedList .rec').length === 2", timeout=5000)
        await page.wait_for_function("document.querySelector('#savedList .rec:last-child img') && document.querySelector('#savedList .rec:last-child img').naturalWidth === 1600", timeout=5000)
        check(True, 'saved measurements and the photo survive a restart')
        check('improving' not in await page.evaluate("savedList.textContent") and 'Getting location' not in await page.evaluate("savedList.textContent"), 'no location search is left hanging')

        # delete needs two taps
        await page.click('#savedList .rec:first-child [data-role=delete]'); await page.wait_for_timeout(200)
        check(await page.evaluate("document.querySelectorAll('#savedList .rec').length") == 2, 'one tap on Delete does not delete')
        await page.click('#savedList .rec:first-child [data-role=delete]')
        await page.wait_for_function("document.querySelectorAll('#savedList .rec').length === 1", timeout=5000)
        await page.reload()
        await page.wait_for_function("document.querySelectorAll('#savedList .rec').length === 1", timeout=5000)
        check('niche 3' in await page.evaluate("savedList.textContent"), 'the second tap deletes that one for good')
        check(not errors, 'no page errors (saving)', errors)
        await page.screenshot(path=os.environ.get('SHOT', '/tmp/smoke.png'), full_page=True)
        await page.close()

        # ---- location refused: the measurement is still saved
        page, errors = await new_page(browser, url, geo='deny')
        await page.click('#mic'); await page.wait_for_timeout(900)
        await page.click('#clap')
        waited = 0
        while waited < 12000:
            await page.wait_for_timeout(100); waited += 100
            if 'now' in (await page.evaluate("clap.textContent")).lower(): break
        await page.evaluate("window.__clap()"); await page.wait_for_timeout(5200)
        await page.click('#saveBtn')
        await page.wait_for_function("document.querySelectorAll('#savedList .rec').length === 1", timeout=5000)
        await page.wait_for_function("document.querySelector('#savedList [data-role=location]').textContent.includes('not allowed')", timeout=20000)
        check(True, 'with location refused the measurement is saved and says why it has no place')
        check(not errors, 'no page errors (no location)', errors)
        await page.close()

        # ---- offline cache and updates, with the real service worker, on a copy of the site
        site = tempfile.mkdtemp(prefix='pyramid-site-')
        for name in os.listdir(ROOT):
            if os.path.isfile(os.path.join(ROOT, name)): shutil.copy(os.path.join(ROOT, name), site)
        srv2 = serve(site)
        url2 = 'http://127.0.0.1:%d/index.html' % srv2.server_address[1]
        ctx = await browser.new_context(viewport={'width': 390, 'height': 844})
        page = await ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto(url2)
        await page.evaluate("navigator.serviceWorker.ready")
        await page.wait_for_function("navigator.serviceWorker.controller !== null", timeout=10000)
        v1 = await page.evaluate("build.textContent")
        await ctx.set_offline(True)
        await page.reload()
        check(await page.evaluate("modeList.children.length") > 10 and await page.evaluate("build.textContent") == v1, 'the app opens with no network after one visit', v1)
        await page.goto(url2.replace('index.html', ''))
        check(await page.evaluate("modeList.children.length") > 10, 'also from the bare address')

        # release a new version, but let one file fail to download: the old version must stay whole
        def bump(name, pattern, text):
            path = os.path.join(site, name); src = open(path).read()
            assert re.search(pattern, src), pattern
            open(path, 'w').write(re.sub(pattern, text, src, count=1))
            # the test server answers "not modified" by whole seconds: make the change visible
            later = os.path.getmtime(path) + 10; os.utime(path, (later, later))
        bump('app.js', r"const BUILD = '[^']+'", "const BUILD = '9.9.9'")
        bump('sw.js', r"const VERSION = '[^']+'", "const VERSION = '9.9.9'")
        os.rename(os.path.join(site, 'modes.js'), os.path.join(site, 'modes.js.away'))
        await ctx.set_offline(False)
        await page.evaluate("navigator.serviceWorker.getRegistration().then(r => r.update()).catch(() => 0)")
        await page.wait_for_timeout(1500)
        await page.reload()
        check(await page.evaluate("caches.keys().then(k => k.join())") == 'pyramid-res-' + v1.split()[1], 'the failed update left no second cache behind', await page.evaluate("caches.keys().then(k => k.join())"))
        check(await page.evaluate("build.textContent") == v1 and await page.evaluate("modeList.children.length") > 10, 'a half-downloaded update leaves the old version running', await page.evaluate("build.textContent"))
        os.rename(os.path.join(site, 'modes.js.away'), os.path.join(site, 'modes.js'))
        # now the update can complete: an idle page reloads itself into it
        ok = False
        for _ in range(10):
            try:
                await page.evaluate("navigator.serviceWorker.getRegistration().then(r => r.update()).catch(() => 0)")
                await page.wait_for_function("document.getElementById('build') && document.getElementById('build').textContent === 'Version 9.9.9'", timeout=2000)
                ok = True
                break
            except Exception:
                pass
        check(ok, 'a complete update loads by itself when nothing is playing', await page.evaluate("build.textContent"))
        await ctx.set_offline(True)
        await page.reload()
        check(await page.evaluate("build.textContent") == 'Version 9.9.9' and await page.evaluate("modeList.children.length") > 10, 'and the new version then works offline')
        check(not errors, 'no page errors (offline and update)', errors)
        srv2.shutdown(); shutil.rmtree(site, ignore_errors=True)
        await browser.close()
    srv.shutdown()
    print('\n%d failed' % len(failures) if failures else '\nall checks passed')
    sys.exit(1 if failures else 0)

asyncio.run(main())
