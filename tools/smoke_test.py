"""Browser smoke test: serves the app locally and drives it in headless Chromium.

    uv venv .venv && uv pip install --python .venv playwright
    [CHROMIUM=/path/to/chrome] .venv/bin/python tools/smoke_test.py [path/to/note.md]

Checks the demo note on a phone-sized and two desktop-sized windows, then (if given) a real note picked
through the file input. Checks the DOM, the Chart.js instances and the layout geometry; it takes no
screenshots. Nothing leaves the machine: the server binds to 127.0.0.1.
"""
import functools
import os
import http.server
import socketserver
import sys
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
failures = []


def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond:
        failures.append(msg)


def serve():
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    handler = functools.partial(Quiet, directory=str(ROOT))
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f"http://127.0.0.1:{httpd.server_address[1]}/"


STATE_JS = """() => ({
  charts: Object.values(Chart.instances).map(c => ({
    id: c.canvas.closest('section').id, datasets: c.data.datasets.length,
    colors: c.data.datasets.map(d => d.borderColor || d.backgroundColor), w: c.width, h: c.height,
    plotH: c.chartArea.bottom - c.chartArea.top, yTitle: c.options.scales.y.title.text })),
  sections: [...document.querySelectorAll('#views > section')].map(s => s.id),
  rows: document.querySelectorAll('#table tbody tr').length,
  flagged: [...document.querySelectorAll('#table tbody tr')].filter(r => r.className).map(r => r.querySelector('th').textContent + ':' + r.className),
  warnings: document.getElementById('warnings').hidden ? 0 : document.querySelectorAll('#warnings li').length,
  status: document.getElementById('status').textContent,
  overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
})"""

LAYOUT_JS = """() => {
  const r = id => document.getElementById(id).getBoundingClientRect();
  const ids = ['weight-group', 'weight-mice', 'weight-latest', 'tumor-group', 'tumor-mice', 'tumor-latest', 'table', 'grid'];
  return {
    cols: getComputedStyle(document.getElementById('views')).gridTemplateColumns.split(' ').length,
    rects: Object.fromEntries(ids.map(id => [id, (({ top, bottom, left, right }) => ({ top, bottom, left, right }))(r(id))])),
    vh: innerHeight,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
}"""

SECTIONS = ["weight-group", "weight-mice", "weight-latest", "tumor-group", "tumor-mice", "tumor-latest", "table", "grid"]
CHARTS = SECTIONS[:6]


def chart(page, id_, expr):
    """Evaluate `expr` with `c` bound to the Chart.js instance in section #id_."""
    return page.evaluate(f"() => {{ const c = Chart.getChart(document.querySelector('#{id_} canvas')); return {expr}; }}")


def phone(browser, url):
    ctx = browser.new_context(viewport={"width": 375, "height": 800}, color_scheme="light")
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: m.type == "error" and errors.append(m.text))
    page.goto(url)
    check("Choose your experiment note" in page.text_content("#status"), "empty state shows the prompt")
    check(page.is_hidden("#toolbar"), "no toolbar before a note is loaded")

    print("demo note, phone")
    page.click("#demo")
    page.wait_for_selector("#table")
    s = page.evaluate(STATE_JS)
    check(s["sections"] == SECTIONS, f"eight views {s['sections']}")
    check([c["id"] for c in s["charts"]] == CHARTS, f"six charts {[c['id'] for c in s['charts']]}")
    check(all(c["w"] > 0 and c["h"] > 0 for c in s["charts"]), "charts have size")
    check(all(c["plotH"] >= 150 for c in s["charts"]), f"plot areas >= 150px tall at 375px {[c['plotH'] for c in s['charts']]}")
    by = {c["id"]: c for c in s["charts"]}
    check(by["weight-group"]["datasets"] == 3 and by["weight-mice"]["datasets"] == 12, "cage and mouse datasets")
    check(by["tumor-mice"]["datasets"] == 12, "individual tumor chart has a line per mouse")
    check(s["rows"] == 12, f"12 table rows ({s['rows']})")
    check(sorted(s["flagged"]) == ["2-3:critical", "3-2:warning", "3-4:missing"], f"flags {s['flagged']}")
    check(s["warnings"] == 1, f"one parse warning shown ({s['warnings']})")
    check(s["overflow"] <= 0, f"no horizontal scroll at 375px (overflow {s['overflow']})")
    check(page.locator("#grid tbody tr").count() == 12, "heat map has a row per mouse")
    check(page.is_visible("#kpis") and "Day 14" in page.text_content("#kpis"), "headline numbers show the study day")
    light_colors = by["weight-group"]["colors"]

    # Weight in grams vs % change
    check(by["weight-mice"]["yTitle"].startswith("Change"), "individual weights default to % change")
    page.click("[data-pref=weight][data-value=weight]")
    check(chart(page, "weight-mice", "c.options.scales.y.title.text") == "Body weight (g)", "toggle shows individual weights in grams")
    check(chart(page, "weight-group", "c.options.plugins.refLines.lines.length") == 0, "no −15/−20% lines in grams")

    # Tumor: relative, log axis
    page.click("[data-pref=tumor][data-value=rtv]")
    page.click("[data-pref=scale][data-value=log]")
    check(chart(page, "tumor-mice", "c.options.scales.y.type") == "logarithmic", "log tumor axis")
    check(chart(page, "tumor-mice", "c.options.scales.y.title.text").startswith("Tumor volume (×"), "relative tumor volume")

    # X axis as study day
    page.click("[data-pref=x][data-value=day]")
    check(chart(page, "weight-group", "c.scales.x.max") < 20, "x axis in study days")

    # Cage filter: double-click shows one cage only
    page.dblclick("[data-cage='2']")
    n = chart(page, "weight-mice", "c.data.datasets.length")
    check(n == 4, f"cage filter shows 4 mice ({n})")
    check(chart(page, "weight-mice", "c.data.datasets.every(d => d.endLabel)"), "one cage: lines labelled at their ends")
    check(page.locator("#table tbody tr").count() == 4, "table follows the cage filter")
    check(chart(page, "weight-group", "c.data.datasets.filter(d => !d.hidden).length") == 1, "cage chart follows the filter")

    # Highlight a mouse from the table
    page.click("#table tbody tr[data-mouse='2-3']")
    check(page.evaluate("() => state.focus") == "2-3", "clicking a row highlights the mouse")
    check(page.input_value("#focus-mouse") == "2-3", "highlight select follows")

    page.reload()
    page.wait_for_selector("#table")
    s = page.evaluate(STATE_JS)
    check("Synthetic demo" in s["status"], "note remembered across reload")
    check(page.get_attribute("[data-cage='2']", "aria-pressed") == "true"
          and page.get_attribute("[data-cage='1']", "aria-pressed") == "false", "cage filter remembered")
    check(page.get_attribute("[data-pref=weight][data-value=weight]", "aria-pressed") == "true", "settings remembered")
    page.click("[data-cage-all]")
    check(page.locator("#table tbody tr").count() == 12, "All shows every cage again")
    page.click("[data-pref=weight][data-value=pct]")

    page.emulate_media(color_scheme="dark")
    page.wait_for_timeout(100)
    dark_colors = page.evaluate(STATE_JS)["charts"][0]["colors"]
    check(dark_colors != light_colors, f"charts redraw for dark theme {dark_colors}")
    page.click("[data-pref=theme][data-value=light]")
    check(page.evaluate(STATE_JS)["charts"][0]["colors"] == light_colors, "Light theme wins over a dark OS")
    page.click("[data-pref=theme][data-value=auto]")

    # Offline: service worker serves the shell
    page.evaluate("() => navigator.serviceWorker.ready")
    page.reload()  # let the worker control the page
    page.wait_for_selector("#table")
    ctx.set_offline(True)
    page.reload()
    page.wait_for_selector("#table")
    check(page.evaluate(STATE_JS)["rows"] == 12, "works offline after first visit")
    ctx.set_offline(False)

    page.click("#forget")
    check(page.evaluate(STATE_JS)["sections"] == [], "forget clears the plots")
    page.reload()
    check(page.evaluate(STATE_JS)["sections"] == [], "forgotten note stays forgotten")

    page.set_input_files("#note-file", files=[{"name": "junk.md", "mimeType": "text/plain", "buffer": b"no sessions"}])
    page.wait_for_timeout(200)
    check("no measurement sessions" in page.text_content("#status"), "file without sessions gives a visible message")

    check(not errors, f"no page errors {errors}")
    ctx.close()


def desktop(browser, url, w, h, cols, note):
    print(f"desktop {w}x{h}" + (f", {Path(note).name}" if note else ", demo note"))
    ctx = browser.new_context(viewport={"width": w, "height": h}, accept_downloads=True,
                              permissions=["clipboard-read", "clipboard-write"])
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: m.type == "error" and errors.append(m.text))
    page.goto(url)
    if note:
        page.set_input_files("#note-file", note)
    else:
        page.click("#demo")
    page.wait_for_selector("#table")
    L = page.evaluate(LAYOUT_JS)
    r = L["rects"]
    check(L["cols"] == cols, f"{cols} grid columns ({L['cols']})")
    check(L["overflow"] <= 0, f"no horizontal scroll (overflow {L['overflow']})")
    if cols == 6:
        check(abs(r["weight-group"]["top"] - r["weight-latest"]["top"]) < 1, "three charts in the weight row")
        check(r["tumor-group"]["top"] > r["weight-group"]["bottom"], "tumor row below the weight row")
    else:
        check(abs(r["weight-group"]["top"] - r["weight-mice"]["top"]) < 1, "two charts per row")
    check(cols == 2 or r["tumor-mice"]["bottom"] <= L["vh"] + 1, f"both chart rows fit on screen (bottom {r['tumor-mice']['bottom']:.0f} / {L['vh']})")
    plots = [round(c["plotH"]) for c in page.evaluate(STATE_JS)["charts"]]
    check(min(plots) >= 150, f"plot areas >= 150px {plots}")

    if cols == 6:
        info = page.evaluate("async () => { const b = await canvasBlob(chartFigure('weight-mice')); return [b.type, b.size]; }")
        check(info[0] == "image/png" and info[1] > 10000, f"chart PNG {info}")
        info = page.evaluate("async () => { const c = dashboardFigure(); const b = await canvasBlob(c); return [b.type, b.size, c.width, c.height]; }")
        check(info[0] == "image/png" and info[2] > info[3], f"dashboard PNG {info}")
        info = page.evaluate("""() => { const c = Chart.getChart(document.querySelector('#weight-mice canvas'));
          const before = c.canvas.width; const f = chartFigure('weight-mice', 3);
          return [before, c.canvas.width, c.width, f.width]; }""")
        check(info[0] == info[1], f"chart pixel ratio restored after export {info}")
        check(info[3] == round((info[2] + 32) * 3), f"figure drawn at 3x {info}")
        with page.expect_download() as dl:
            page.click("#weight-group [data-tool=png]")
        check(dl.value.suggested_filename.endswith(".png"), f"PNG download {dl.value.suggested_filename}")
        with page.expect_download() as dl:
            page.click("[data-export=csv]")
        lines = Path(dl.value.path()).read_text().strip().split("\n")
        check(lines[0].startswith("mouse,cage,date,study_day,weight_g"), "data CSV header")
        expect = page.evaluate("() => state.derived.mice.length * state.derived.dates.length")
        check(len(lines) - 1 == expect, f"data CSV has a row per mouse per session ({len(lines) - 1})")
        page.click("#tumor-mice [data-tool=expand]")
        big = page.evaluate("() => document.querySelector('#tumor-mice').getBoundingClientRect().height")
        check(big > L["vh"] * 0.9, f"full screen card ({big:.0f}px)")
        page.keyboard.press("Escape")
        check(page.evaluate("() => !document.querySelector('.card.expanded')"), "Esc closes full screen")
        page.select_option("#grid select", "volume")
        check("Tumor volume" in page.text_content("#grid .sub"), "heat map metric select")
        page.select_option("#grid select", "pct")
        # Clipboard: table as TSV, chart as PNG
        page.click("#table [data-tool=tsv]")
        page.wait_for_timeout(100)
        check(page.evaluate("() => navigator.clipboard.readText()").startswith("mouse\tcage"), "table copies as TSV")
        page.click("#tumor-group [data-tool=copy]")
        page.wait_for_timeout(300)
        types = page.evaluate("async () => (await navigator.clipboard.read()).flatMap(i => i.types)")
        check("image/png" in types, f"chart copies as an image {types}")
        # Print layout
        page.emulate_media(media="print")
        page.evaluate("() => window.dispatchEvent(new Event('beforeprint'))")
        s = page.evaluate(STATE_JS)
        check(page.is_hidden("#toolbar") and s["sections"] == SECTIONS, "print: toolbar hidden, every view present")
        check(all(c["h"] > 0 and c["plotH"] > 100 for c in s["charts"]), f"print: charts drawn {[round(c['plotH']) for c in s['charts']]}")
        page.emulate_media(media="screen")

    if note:
        s = page.evaluate(STATE_JS)
        check(s["warnings"] == 0, f"no parse warnings ({s['warnings']})")
        check(s["rows"] == 30, f"30 table rows ({s['rows']})")
        check(s["charts"][0]["datasets"] == 6, "six cages")
        print("  flagged:", s["flagged"])
        print("  status:", s["status"])
    check(not errors, f"no page errors {errors}")
    ctx.close()


def no_storage(browser, url):
    print("storage blocked")
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    ctx.add_init_script("Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } });")
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(url)
    page.click("#demo")
    page.wait_for_selector("#table")
    check(page.evaluate(STATE_JS)["rows"] == 12, "plots without storage")
    check("not remembered" in page.text_content("#status"), "says the note is not remembered")
    page.click("[data-pref=weight][data-value=weight]")
    check(chart(page, "weight-mice", "c.options.scales.y.title.text") == "Body weight (g)", "toggles work without storage")
    check(not errors, f"no page errors {errors}")
    ctx.close()


def main(note):
    httpd, url = serve()
    with sync_playwright() as p:
        # CHROMIUM=/path/to/chrome uses an existing browser instead of the one Playwright expects.
        browser = p.chromium.launch(executable_path=os.environ.get("CHROMIUM") or None)
        phone(browser, url)
        desktop(browser, url, 1920, 1080, 6, None)
        desktop(browser, url, 1536, 864, 6, None)
        desktop(browser, url, 1280, 800, 2, None)
        if note:
            desktop(browser, url, 1920, 1080, 6, note)
            desktop(browser, url, 1536, 864, 6, note)
        no_storage(browser, url)
        browser.close()
    httpd.shutdown()
    print("FAILED: %d" % len(failures) if failures else "all checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else None))
