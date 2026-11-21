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
def use_tabs(page):
    """The page has tabs. Before acting on a control, go to its tab the way a person would: by tapping the tab button."""
    async def go(selector):
        await page.evaluate("""(sel) => { const el = document.querySelector(sel); const panel = el && el.closest('.tab');
            if (panel && panel.hidden) document.getElementById('tabBtn-' + panel.id.slice(4)).click(); }""", selector)
    def wrap(name):
        real = getattr(page, name)
        async def call(selector, *a, **k):
            await go(selector)
            return await real(selector, *a, **k)
        setattr(page, name, call)
    for name in ('click', 'fill', 'select_option', 'uncheck', 'check', 'dispatch_event'):
        wrap(name)

def ctx_of(page):
    return page.context

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
  for (const f of d.files) {
    const o = { name: f.name, type: f.type, size: f.size, text: f.type === 'application/json' ? await f.text() : null };
    if (f.type === 'audio/wav') {
      const v = new DataView(await f.arrayBuffer());
      const x = new Float32Array((v.byteLength - 58) / 4); for (let i = 0; i < x.length; i++) x[i] = v.getFloat32(58 + i * 4, true);
      let peak = 0; x.forEach((s) => { if (Math.abs(s) > peak) peak = Math.abs(s); });
      const at = x.findIndex((s) => Math.abs(s) > peak / 4);   // the first clap (the test claps twice)
      const rms = (a, b) => { let q = 0; for (let i = a; i < b; i++) q += x[i] * x[i]; return Math.sqrt(q / Math.max(1, b - a)); };
      o.wav = { format: v.getUint16(20, true), channels: v.getUint16(22, true), rate: v.getUint32(24, true), samples: x.length, peak, at,
        before: rms(0, Math.max(1, at - 2400)), after: rms(at, Math.min(x.length, at + 4800)) };
    }
    files.push(o);
  }
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
    use_tabs(page)
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
        # ---- tabs: one page, four sections
        vis = "[...document.querySelectorAll('.tab')].filter(t => !t.hidden).map(t => t.id).join()"
        await page.fill('#fMin', '60'); await page.dispatch_event('#fMin', 'change')
        for t in ('measure', 'play', 'saved', 'setup'):
            await page.click('#tabBtn-' + t)
            check(await page.evaluate(vis) == 'tab-' + t and await page.evaluate("document.querySelector('[role=tab][aria-selected=true]').id") == 'tabBtn-' + t, 'tab %s shows only its own section' % t, await page.evaluate(vis))
        check(await page.evaluate("[...document.querySelectorAll('main .card')].every(c => c.id === 'updateNote' || c.closest('.tab'))"), 'every card belongs to a tab')
        await page.click('#tabBtn-play'); await page.click('#next'); await page.wait_for_timeout(500)
        check(await page.evaluate("stop.offsetParent !== null && nowCard.closest('.tab').id") == 'tab-play', 'volume and Stop are on the Play tab')
        await page.click('#tabBtn-saved'); await page.wait_for_timeout(600)
        check(await page.evaluate(LIVE) == 1 and await page.evaluate("!dotPlay.hidden && dotMeasure.hidden"), 'a tone keeps playing on another tab, and the Play tab is marked')
        await page.click('#tabBtn-measure')
        check(await page.evaluate("stop.offsetParent !== null && !stop.disabled && nowCard.closest('.tab').id") == 'tab-measure', 'volume and Stop follow to the Measure tab')
        check(await page.evaluate("chart.width") > 300 * 0.9 and await page.evaluate("chart.clientWidth") > 200, 'the chart is drawn at its real size when its tab opens', await page.evaluate("chart.width + ' / ' + chart.clientWidth"))
        await page.click('#stop'); await page.wait_for_timeout(700)
        check(await page.evaluate(LIVE) == 0 and await page.evaluate("dotPlay.hidden"), 'Stop works from there and the mark goes away')
        await page.click('#tabBtn-setup')
        await page.reload()
        check(await page.evaluate(vis) == 'tab-setup', 'the last tab is remembered after a restart', await page.evaluate(vis))
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
        check(await page.evaluate("!keepAudioRow.hidden && keepAudio.checked && /^[34]\\.\\d s, [01]\\.\\d MB$/.test(keepAudioSize.textContent)"), 'and offers to keep its sound', await page.evaluate("keepAudioSize.textContent"))
        await page.evaluate(SHARE_MOCK)
        await page.fill('#saveNote', 'Test room, niche 3')
        check(await page.evaluate("PyramidUpdate.busy() === true"), 'an unsaved measurement holds back the automatic reload into a new version')
        await page.click('#saveBtn')
        await page.wait_for_function("document.querySelectorAll('#savedList .rec').length === 1", timeout=5000)
        check(await page.evaluate("saveBtn.disabled && saveBtn.textContent === 'Saved'"), 'the same measurement cannot be saved twice')
        await page.wait_for_function("document.querySelector('#savedList [data-role=location]').textContent.includes('-13.50981')", timeout=20000)
        loc = await page.evaluate("document.querySelector('#savedList [data-role=location]').textContent")
        check('-71.98171' in loc and '±7 m' in loc and 'improving' not in loc, 'the location is stored with its accuracy', loc)
        check((await page.evaluate("document.querySelector('#savedList .rec a').href")).startswith('https://maps.google.com/?q=-13.509812,-71.981712'), 'with a map link')
        check('Test room, niche 3' in await page.evaluate("document.querySelector('#savedList .rec b').textContent"), 'the note is shown')
        check('sound' in await page.evaluate("document.querySelector('#savedList .rec').textContent"), 'the list says the sound was kept')

        # a second measurement, then look at the first again
        await page.click('#mic'); await page.wait_for_timeout(900)
        await page.click('#clap')
        waited = 0
        while waited < 12000:
            await page.wait_for_timeout(100); waited += 100
            if 'now' in (await page.evaluate("clap.textContent")).lower(): break
        await page.evaluate("window.__clap()"); await page.wait_for_timeout(5200)
        check(await page.evaluate("!saveBox.hidden && !saveBtn.disabled"), 'a new measurement can be saved again')
        await page.uncheck('#keepAudio')
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
        check(len(shares) == 1 and len(names) == 4 and names[0].endswith('-test-room-niche-3.json') and names[1].endswith('-chart.png') and names[2].endswith('-photo.jpg')
              and names[3].endswith('-sound.wav'), 'sending one measurement gives data, chart, photo and sound', names)
        wav = shares[0]['files'][3].get('wav') if len(names) == 4 else None
        rate = await page.evaluate("window.__ctx.sampleRate")
        check(bool(wav) and wav['format'] == 3 and wav['channels'] == 1 and wav['rate'] == rate and 3.5 * rate < wav['samples'] <= 4.3 * rate
              and shares[0]['files'][3]['size'] == 58 + 4 * wav['samples'], 'the sound is about 4 s of mono float WAV at the microphone rate', wav)
        check(bool(wav) and wav['peak'] > 0.01 and wav['at'] > 0.1 * rate and wav['after'] > 20 * wav['before'], 'and it holds the clap: quiet before, loud at the clap', wav)
        data = json.loads(shares[0]['files'][0]['text']) if shares else {}
        check(data.get('schema') == 'pyramid-resonance-measurement/1' and len(data.get('curve', [])) > 50 and abs(data['location']['lat'] + 13.509812) < 1e-6
              and data['location']['accuracyM'] == 7 and data['note'] == 'Test room, niche 3' and data['photo']['width'] == 1600 and data['kind'] == 'clap' and data['audio']['samples'] == (wav or {}).get('samples') and data['audio']['format'] == 'float32'
              and any(abs(p['f'] - F0) < 3 for p in data['peaks']), 'the data file holds the spectrum, peaks, place and note', {k: data.get(k) for k in ('time', 'location', 'peaks')})
        check('Location: -13.50981' in shares[0]['text'] and 'maps.google.com' in shares[0]['text'], 'and the message text names the place')
        check(shares[0]['files'][1]['size'] > 3000 and shares[0]['files'][2]['size'] > 3000, 'chart and photo files are not empty')
        await page.click('#shareAll'); await page.wait_for_timeout(500)
        shares = await page.evaluate("window.__shares")
        everything = json.loads(shares[-1]['files'][0]['text'])
        check(len(shares) == 2 and everything['count'] == 2 and everything['measurements'][0]['note'] == 'Test room, niche 3', '"send all" gives one file with both, oldest first')
        check(everything['measurements'][1]['audio'] is None, 'a measurement saved with "Keep the sound" unticked has none')
        await page.click('#savedList .rec:first-child [data-role=share]'); await page.wait_for_timeout(500)
        shares = await page.evaluate("window.__shares")
        check([f['name'].rsplit('.', 1)[1] for f in shares[-1]['files']] == ['json', 'png'], 'and sends no sound file', [f['name'] for f in shares[-1]['files']])

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
        await page.click('#tabBtn-saved')
        await page.click('#savedList .rec:first-child [data-role=show]'); await page.wait_for_timeout(300)
        shown = await page.evaluate("document.getElementById('tab-measure').hidden ? 'hidden' : peaks.textContent")
        check('saved measurement' in shown, '"Show" on a saved measurement opens it on the Measure tab', shown[-90:])
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
        use_tabs(page)
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto(url2)
        await page.evaluate("navigator.serviceWorker.ready")
        await page.wait_for_function("navigator.serviceWorker.controller !== null", timeout=10000)
        v1 = await page.evaluate("build.textContent")
        check(re.search(r'published \d+\.\d+\.\d{4} \d\d:\d\d', await page.evaluate("released.textContent")) is not None, 'the page shows when its version was published', await page.evaluate("released.textContent"))
        await page.click('#checkUpdate')
        await page.wait_for_function("updateMsg.textContent.includes('newest version')", timeout=10000)
        check(True, '"Check for update" says when the app is up to date')
        await ctx.set_offline(True)
        await page.click('#checkUpdate')
        await page.wait_for_function("updateMsg.textContent.includes('Could not check')", timeout=12000)
        check(await page.evaluate("!checkUpdate.disabled"), 'and says so when there is no connection')
        await page.reload()
        check(await page.evaluate("modeList.children.length") > 10 and await page.evaluate("build.textContent") == v1, 'the app opens with no network after one visit', v1)
        seen = []
        for t in ('play', 'saved', 'setup', 'measure'):
            await page.click('#tabBtn-' + t)
            seen.append(await page.evaluate("[...document.querySelectorAll('.tab')].filter(t => !t.hidden).map(t => t.id).join()"))
        check(seen == ['tab-play', 'tab-saved', 'tab-setup', 'tab-measure'], 'all four tabs open with no network', seen)
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
        bump('sw.js', r"const RELEASED = '[^']+'", "const RELEASED = '2027-03-10T12:00:00Z'")
        bump('app.js', r"const RELEASED = '[^']+'", "const RELEASED = '2027-03-10T12:00:00Z'")
        os.rename(os.path.join(site, 'modes.js'), os.path.join(site, 'modes.js.away'))
        await ctx.set_offline(False)
        async def build_is(text, timeout=15000):
            try:
                await page.wait_for_function("document.getElementById('build') && document.getElementById('build').textContent === %r" % text, timeout=timeout)
                return True
            except Exception:
                return False
        async def caches_settle(expected):
            for _ in range(40):
                names = await page.evaluate("caches.keys().then(k => k.join())")
                if names == expected: return names
                await page.wait_for_timeout(250)
            return names
        await page.click('#checkUpdate')
        try:
            await page.wait_for_function("updateMsg.textContent.includes('could not be installed yet')", timeout=15000); said = True
        except Exception:
            said = False
        check(said, '"Check for update" finds the new version and says when its download fails', await page.evaluate("updateMsg.textContent"))
        check('Version 9.9.9, published' in await page.evaluate("updateMsg.textContent"), 'and names the version and its publication time')
        names = await caches_settle('pyramid-res-' + v1.split()[1])
        check(names == 'pyramid-res-' + v1.split()[1], 'the failed update left no second cache behind', names)
        await page.reload()
        check(await page.evaluate("build.textContent") == v1 and await page.evaluate("modeList.children.length") > 10, 'a half-downloaded update leaves the old version running', await page.evaluate("build.textContent"))

        # the server hands out the new sw.js before the new app.js: the install must refuse
        os.rename(os.path.join(site, 'modes.js.away'), os.path.join(site, 'modes.js'))
        new_app = open(os.path.join(site, 'app.js')).read()
        open(os.path.join(site, 'app.js'), 'w').write(open(os.path.join(ROOT, 'app.js')).read())
        later = os.path.getmtime(os.path.join(site, 'app.js')) + 30; os.utime(os.path.join(site, 'app.js'), (later, later))
        fate = await page.evaluate("""navigator.serviceWorker.getRegistration().then(r => r.update().then(() => new Promise((done) => {
            const w = r.installing || r.waiting;
            if (!w) return done('no new worker');
            const look = () => { if (w.state === 'redundant' || w.state === 'activated') done(w.state); };
            w.addEventListener('statechange', look); look(); setTimeout(() => done('timeout in state ' + w.state), 10000);
        })))""")
        names = await caches_settle('pyramid-res-' + v1.split()[1])
        check(fate == 'redundant' and names == 'pyramid-res-' + v1.split()[1], 'a new sw.js with the old app.js is not installed', fate + ' ' + names)
        open(os.path.join(site, 'app.js'), 'w').write(new_app)
        later += 30; os.utime(os.path.join(site, 'app.js'), (later, later))

        # now the update can complete: one tap, and an idle page reloads itself into it
        await page.click('#checkUpdate')
        check(await build_is('Version 9.9.9'), 'after "Check for update" a complete update loads by itself when nothing is playing', await page.evaluate("build.textContent"))
        await page.click('#checkUpdate')
        await page.wait_for_function("updateMsg.textContent.includes('newest version')", timeout=10000)

        # a release whose app.js does not even start must still be replaceable by the next one
        def publish(version, app_text):
            src = re.sub(r"const BUILD = '[^']+'", "const BUILD = '%s'" % version, app_text, count=1)
            for name, text in (('app.js', src), ('sw.js', re.sub(r"const VERSION = '[^']+'", "const VERSION = '%s'" % version, open(os.path.join(site, 'sw.js')).read(), count=1))):
                path = os.path.join(site, name); stamp = os.path.getmtime(path) + 60
                open(path, 'w').write(text); os.utime(path, (stamp, stamp))
        good_app = open(os.path.join(site, 'app.js')).read()
        await page.wait_for_timeout(16000)     # past the pause that guards against reload loops
        publish('9.9.10', good_app.replace("'use strict';", "'use strict'; const broken = /(/;", 1))
        await page.evaluate("navigator.serviceWorker.getRegistration().then(r => r.update()).catch(() => 0)")
        dead = False
        for _ in range(60):                    # the page reloads while we look, so ask again after a failed look
            try:
                if await page.evaluate("document.readyState === 'complete' && document.getElementById('build').textContent === ''"): dead = True; break
            except Exception:
                pass
            await page.wait_for_timeout(250)
        check(dead, '(test setup) the broken release took over and its page does not start', await page.evaluate("build.textContent"))
        await page.wait_for_timeout(16000)
        # ... and so must one that parses but stops with an error while starting
        publish('9.9.11', good_app.replace("const updater = window.PyramidUpdate || null;", "const updater = window.PyramidUpdate || null; if (updater) { updater.busy = () => neverDeclared; throw new Error('boom at start'); }", 1))
        await page.reload()
        dead = False
        for _ in range(80):
            try:
                if await page.evaluate("document.readyState === 'complete' && document.getElementById('build').textContent === '' && caches.keys().then(k => k.join() === 'pyramid-res-9.9.11')"): dead = True; break
            except Exception:
                pass
            await page.wait_for_timeout(250)
        check(dead, 'a release that does not parse is replaced by the next one after one reopening (here: by one that stops while starting)')
        await page.wait_for_timeout(16000)
        publish('9.9.12', good_app)
        await page.reload()                    # what opening the app again does: the browser itself looks for a new sw.js
        check(await build_is('Version 9.9.12', 20000), 'a release that stops while starting is replaced by the next one after one reopening', await page.evaluate("build.textContent"))
        errors[:] = [e for e in errors if 'regular expression' not in e and 'Invalid' not in e and 'boom at start' not in e]
        await ctx.set_offline(True)
        await page.reload()
        check(await page.evaluate("build.textContent") == 'Version 9.9.12' and await page.evaluate("modeList.children.length") > 10, 'and the new version then works offline')
        check(not errors, 'no page errors (offline and update)', errors)
        srv2.shutdown(); shutil.rmtree(site, ignore_errors=True)
        await browser.close()
    srv.shutdown()
    print('\n%d failed' % len(failures) if failures else '\nall checks passed')
    sys.exit(1 if failures else 0)

asyncio.run(main())
