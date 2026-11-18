"""Browser smoke test for the whole app. Needs Playwright and Chrome:

    python3 test/smoke.py

The page's sound output is looped through a simulated room (one resonance at
117.3 Hz) into a fake microphone, so a sweep and a "clap" can be measured
without any hardware. Exits non-zero on the first failed check.
"""
import asyncio, functools, http.server, os, sys, threading
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
F0 = 117.3

INIT = r"""
(() => {
  const RealAC = window.AudioContext;
  window.__osc = { created: 0, live: new Set() };
  window.__wl = { requested: 0, released: 0 };
  class AC extends RealAC { constructor(...a) { super(...a); window.__ctx = this; window.__makeLoop(%F0%, 40); } }
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
    const direct = c.createGain(); direct.gain.value = 0.05;
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f0; bp.Q.value = Q;
    const out = c.createMediaStreamDestination();
    realConnect.call(input, direct); realConnect.call(direct, out);
    realConnect.call(input, bp); realConnect.call(bp, out);
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

def serve():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
    handler.log_message = lambda *a, **k: None
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv

LIVE = "window.__osc.live.size"
PEAKS = "[...document.querySelectorAll('#peaks tr')].filter(r => r.querySelector('td')).map(r => [...r.children].map(c => c.textContent))"

async def new_page(browser, url, pre=''):
    ctx = await browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, service_workers='block')
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
        await page.click('#stop'); await page.wait_for_timeout(500)
        check(await page.evaluate(LIVE) == 0, 'Stop silences everything')
        await page.click('#next'); await page.wait_for_timeout(300)
        fourth = await page.evaluate("nowFreq.textContent")
        check(float(fourth.split()[0]) > float(third.split()[0]), 'the stepper carries on after Stop', third + ' -> ' + fourth)
        check(await page.evaluate("document.querySelectorAll('#modeList [aria-current]').length") == 1, 'one list row is marked current')
        await page.click('#stop'); await page.wait_for_timeout(300)
        wl = await page.evaluate("window.__wl")
        check(wl['requested'] == wl['released'] and wl['requested'] > 0, 'screen wake lock is released', wl)

        # ---- volume reaches the sweep
        await page.click('#sweep'); await page.wait_for_timeout(600)
        check(await page.evaluate(LIVE) == 1, 'the sweep starts one oscillator', await page.evaluate("nowFreq.textContent"))
        f_a = float((await page.evaluate("nowFreq.textContent")).split()[0])
        await page.wait_for_timeout(1500)
        f_b = float((await page.evaluate("nowFreq.textContent")).split()[0])
        check(f_b > f_a, 'the sweep frequency rises', '%s -> %s' % (f_a, f_b))
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
        page, errors = await new_page(browser, url)
        await page.select_option('#speaker', 'direct')
        await page.select_option('#sweepDur', '30')
        await page.fill('#fMin', '90'); await page.dispatch_event('#fMin', 'change')
        await page.fill('#fMax', '150'); await page.dispatch_event('#fMax', 'change')
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
        check(best is not None and abs(best - F0) / F0 < 0.01, 'the sweep finds the %.1f Hz resonance within 1 %%' % F0, rows)
        check(any('height ×4' in ' '.join(r) for r in rows), 'and names the fourth height mode')
        check(await page.evaluate(LIVE) == 0, 'no oscillator is left after the sweep')

        # clap while a tone plays must not be measured
        await page.fill('#fMin', '60'); await page.dispatch_event('#fMin', 'change')
        await page.fill('#fMax', '250'); await page.dispatch_event('#fMax', 'change')
        await page.click('#next'); await page.click('#next'); await page.wait_for_timeout(1500)   # 81.9 Hz, away from the resonance
        await page.click('#clap'); await page.wait_for_timeout(300)
        check(await page.evaluate(LIVE) == 0, 'starting a clap recording stops the tone')
        check(await page.evaluate("next.disabled && sweep.disabled"), 'and locks the other controls while it runs')
        waited = 0
        while waited < 10000:                    # wait for the "clap now" phase, then clap
            await page.wait_for_timeout(100); waited += 100
            if 'now' in (await page.evaluate("clap.textContent")).lower(): break
        check(waited >= 2000, 'it waits for the old tone to die away first', '%d ms' % waited)
        await page.wait_for_timeout(300)
        await page.evaluate("window.__clap()")
        await page.wait_for_timeout(6000)
        rows = await page.evaluate(PEAKS)
        got = [float(r[0].split()[0]) for r in rows] if rows else []
        best = min(got, key=lambda f: abs(f - F0)) if got else None
        check(best is not None and abs(best - F0) / F0 < 0.02, 'the clap finds the resonance within 2 %', rows)
        check(not any(abs(f - 81.9) < 1.5 for f in got), 'and does not report the tone that was playing before', got)
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
        await page.screenshot(path=os.environ.get('SHOT', '/tmp/smoke.png'), full_page=True)
        await browser.close()
    srv.shutdown()
    print('\n%d failed' % len(failures) if failures else '\nall checks passed')
    sys.exit(1 if failures else 0)

asyncio.run(main())
