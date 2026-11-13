"""Browser smoke test: serves the app locally and drives it in headless Chromium.

    [CHROMIUM=/path/to/chrome] uv run --no-project --with playwright==1.64.1 python tools/smoke_test.py [path/to/note.md]

Checks the demo workbook (demo/synthetic-demo.xlsx) on a phone-sized and three desktop-sized windows,
including the sticky jump bar and the phone's "More settings" fold, then (if given) a real note picked
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
  const ids = ['weight-group', 'weight-mice', 'weight-latest', 'tumor-group', 'tumor-mice', 'tumor-latest', 'survival', 'table', 'grid'];
  return {
    cols: getComputedStyle(document.getElementById('views')).gridTemplateColumns.split(' ').length,
    rects: Object.fromEntries(ids.map(id => [id, (({ top, bottom, left, right }) => ({ top, bottom, left, right }))(r(id))])),
    vh: innerHeight,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
}"""

# The demo workbook has no Injections sheet, so no injection calendar or table (and no Injections link).
SECTIONS = ["weight-group", "weight-mice", "weight-latest", "tumor-group", "tumor-mice", "tumor-latest", "survival", "table", "grid"]
CHARTS = SECTIONS[:7]
JUMP_LINKS = [["weight-group", "Weight"], ["tumor-group", "Tumor"], ["survival", "Survival"],
              ["table", "Latest values"], ["grid", "All measurements"]]

JUMP_JS = """id => {
  const nav = document.getElementById('jump').getBoundingClientRect();
  const card = document.getElementById(id).getBoundingClientRect();
  return { navTop: nav.top, navBottom: nav.bottom, cardTop: card.top, scrollY,
           capped: scrollY >= document.documentElement.scrollHeight - innerHeight - 1,
           current: [...document.querySelectorAll('#jump [aria-current]')].map(a => a.dataset.jump + ':' + a.getAttribute('aria-current')) };
}"""

# Resolves once the page has stopped scrolling (a jump scrolls smoothly) for a few frames.
SETTLE_JS = """async () => {
  let last = -1, same = 0;
  for (let i = 0; i < 600 && same < 6; i++) {
    await new Promise(r => requestAnimationFrame(r));
    if (scrollY === last) same++; else { same = 0; last = scrollY; }
  }
}"""


def chart(page, id_, expr):
    """Evaluate `expr` with `c` bound to the Chart.js instance in section #id_."""
    return page.evaluate(f"() => {{ const c = Chart.getChart(document.querySelector('#{id_} canvas')); return {expr}; }}")


def jump_bar(page):
    """The sticky jump bar: one link per topic present, a click lands that card under the bar and marks it."""
    links = page.evaluate("() => [...document.querySelectorAll('#jump [data-jump]')].map(a => [a.dataset.jump, a.textContent])")
    check(page.is_visible("#jump") and links == JUMP_LINKS, f"jump bar links {links}")
    check(page.locator("#dose-calendar, #doses").count() == 0 and "Injections" not in [t for _, t in links],
          "no injection cards in the demo, so no Injections link")
    j = page.evaluate(JUMP_JS, "weight-group")
    check(j["current"] == ["weight-group:location"], f"Weight marked at the top of the page {j['current']}")
    for id_, text in links:
        page.click(f"#jump [data-jump='{id_}']")
        page.evaluate(SETTLE_JS)
        j = page.evaluate(JUMP_JS, id_)
        lands = j["cardTop"] >= j["navBottom"] - 1 and (j["capped"] or j["cardTop"] <= j["navBottom"] + 24)
        check(lands, f"{text}: card lands below the bar (bar bottom {j['navBottom']:.0f}, card top {j['cardTop']:.0f}"
              + (", page end" if j["capped"] else "") + ")")
        check(abs(j["navTop"]) <= 1, f"{text}: bar stuck to the top ({j['navTop']:.0f})")
        check(j["current"] == [f"{id_}:location"], f"{text}: marked as current {j['current']}")
    page.evaluate("() => scrollTo(0, 0)")
    page.evaluate(SETTLE_JS)
    page.wait_for_function("() => document.querySelector('#jump [aria-current]')?.dataset.jump === 'weight-group'", timeout=2000)
    check(page.evaluate(JUMP_JS, "weight-group")["current"] == ["weight-group:location"], "scrolling back up marks Weight again")


def more_settings(page, open_):
    """Fold or unfold the phone toolbar's less-used settings."""
    if (page.get_attribute("[data-more-settings]", "aria-expanded") == "true") != open_:
        page.click("[data-more-settings]")


def phone(browser, url):
    ctx = browser.new_context(viewport={"width": 375, "height": 800}, color_scheme="light")
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: m.type == "error" and errors.append(m.text))
    page.goto(url)
    check("Choose your study workbook" in page.text_content("#status"), "empty state shows the prompt")
    check(page.is_hidden("#toolbar"), "no toolbar before a file is loaded")
    check(page.is_hidden("#jump"), "no jump bar before a file is loaded")

    print("demo workbook, phone")
    page.click("#demo")
    page.wait_for_selector("#table")
    s = page.evaluate(STATE_JS)
    check(s["sections"] == SECTIONS, f"nine views {s['sections']}")
    check([c["id"] for c in s["charts"]] == CHARTS, f"seven charts {[c['id'] for c in s['charts']]}")
    check(all(c["w"] > 0 and c["h"] > 0 for c in s["charts"]), "charts have size")
    check(all(c["plotH"] >= 150 for c in s["charts"]), f"plot areas >= 150px tall at 375px {[c['plotH'] for c in s['charts']]}")
    by = {c["id"]: c for c in s["charts"]}
    check(by["weight-group"]["datasets"] == 2 and by["weight-mice"]["datasets"] == 12, "group and mouse datasets")
    check(by["tumor-mice"]["datasets"] == 12, "individual tumor chart has a line per mouse")
    check(by["survival"]["datasets"] == 2, "a survival curve per group")
    check(s["rows"] == 12, f"12 table rows ({s['rows']})")
    check(sorted(s["flagged"]) == ["D107:critical", "D110:warning", "D112:ended"], f"flags {s['flagged']}")
    check(s["warnings"] == 0, f"no parse warnings ({s['warnings']})")
    check(s["overflow"] <= 0, f"no horizontal scroll at 375px (overflow {s['overflow']})")
    check(page.locator("#grid tbody tr").count() == 12, "heat map has a row per mouse")
    check(page.is_visible("#kpis") and "Day 14" in page.text_content("#kpis"), "headline numbers show the study day")
    light_colors = by["weight-group"]["colors"]
    jump_bar(page)
    check(page.evaluate(STATE_JS)["overflow"] <= 0, "jump bar scrolls sideways itself, not the page")

    # Phone: only Group by and the chips show until "More settings" unfolds the rest.
    check(page.is_visible("[data-more-settings]") and page.get_attribute("[data-more-settings]", "aria-expanded") == "false",
          "More settings toggle shown, folded")
    check(page.is_visible("[data-pref=by]") and page.is_visible("[data-cage='Vehicle']"), "Group by and the chips show folded")
    folded = ["[data-pref=weight]", "[data-pref=tumor]", "[data-pref=scale]", "[data-pref=error]", "[data-pref=x]",
              "#focus-mouse", "[data-pref=theme]", "[data-export]"]
    check(all(page.locator(sel).first.is_hidden() for sel in folded), "the other settings are hidden folded")
    page.click("[data-more-settings]")
    check(all(page.locator(sel).first.is_visible() for sel in folded), "More settings unfolds them")
    check(page.get_attribute("[data-more-settings]", "aria-expanded") == "true"
          and page.text_content("[data-more-settings]") == "Fewer settings", "toggle says Fewer settings, expanded")
    check(page.evaluate(STATE_JS)["overflow"] <= 0, "no horizontal scroll unfolded")
    page.click("[data-more-settings]")
    check(page.locator("[data-pref=weight]").first.is_hidden(), "Fewer settings folds them again")
    page.click("[data-more-settings]")

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

    # Group filter: double-click shows one group only
    page.dblclick("[data-cage='Treated']")
    n = chart(page, "weight-mice", "c.data.datasets.length")
    check(n == 6, f"group filter shows 6 mice ({n})")
    check(chart(page, "weight-mice", "c.data.datasets.every(d => d.endLabel)"), "one group: lines labelled at their ends")
    check(page.locator("#table tbody tr").count() == 6, "table follows the group filter")
    check(chart(page, "weight-group", "c.data.datasets.filter(d => !d.hidden).length") == 1, "group chart follows the filter")

    # Highlight a mouse from the table
    page.click("#table tbody tr[data-mouse='D110']")
    check(page.evaluate("() => state.focus") == "D110", "clicking a row highlights the mouse")
    check(page.input_value("#focus-mouse") == "D110", "highlight select follows")

    page.reload()
    page.wait_for_selector("#table")
    s = page.evaluate(STATE_JS)
    check("Synthetic demo" in s["status"], "file remembered across reload")
    check(page.get_attribute("[data-cage='Treated']", "aria-pressed") == "true"
          and page.get_attribute("[data-cage='Vehicle']", "aria-pressed") == "false", "group filter remembered")
    check(page.get_attribute("[data-pref=weight][data-value=weight]", "aria-pressed") == "true", "settings remembered")
    check(page.get_attribute("[data-more-settings]", "aria-expanded") == "false"
          and page.locator("[data-pref=weight]").first.is_hidden(), "More settings not remembered: folded after reload")
    page.click("[data-cage-all]")
    check(page.locator("#table tbody tr").count() == 12, "All shows every group again")
    more_settings(page, True)
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
    check(page.is_hidden("#jump"), "forget hides the jump bar")
    page.reload()
    check(page.evaluate(STATE_JS)["sections"] == [], "forgotten note stays forgotten")

    page.set_input_files("#note-file", files=[{"name": "junk.md", "mimeType": "text/plain", "buffer": b"no sessions"}])
    page.wait_for_timeout(200)
    check("no measurement sessions" in page.text_content("#status"), "file without sessions gives a visible message")

    check(not errors, f"no page errors {errors}")
    ctx.close()


def desktop(browser, url, w, h, cols, note):
    print(f"desktop {w}x{h}" + (f", {Path(note).name}" if note else ", demo workbook"))
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
    check(page.is_hidden("[data-more-settings]") and page.is_visible("[data-pref=weight]"),
          "no More settings toggle on desktop: every setting shows")
    if not note:
        jump_bar(page)

    if cols == 6:
        info = page.evaluate("async () => { const b = await canvasBlob(chartFigure('weight-mice')); return [b.type, b.size]; }")
        check(info[0] == "image/png" and info[1] > 10000, f"chart PNG {info}")
        info = page.evaluate("""async () => { const c = dashboardFigure(); const b = await canvasBlob(c); const f = chartFigure('weight-mice', 2);
          return [b.type, b.size, c.width, c.height, f.width, f.height]; }""")
        # Seven charts, three per row: three columns by three rows of chart figures.
        check(info[0] == "image/png" and info[1] > 10000 and info[2] >= 3 * info[4] and info[3] >= 3 * info[5], f"dashboard PNG {info}")
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
        check(lines[0].startswith("mouse,current_cage,current_tail_mark,group,status,end_date,end_reason,date,study_day,cage,tail_mark,weight_g"),
              f"data CSV header {lines[0][:60]}")
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
        types = []
        for _ in range(30):  # the figure is drawn and encoded before it reaches the clipboard
            page.wait_for_timeout(100)
            types = page.evaluate("async () => (await navigator.clipboard.read()).flatMap(i => i.types)")
            if "image/png" in types:
                break
        check("image/png" in types, f"chart copies as an image {types}")
        # Print layout
        page.emulate_media(media="print")
        page.evaluate("() => window.dispatchEvent(new Event('beforeprint'))")
        s = page.evaluate(STATE_JS)
        check(page.is_hidden("#toolbar") and page.is_hidden("#jump") and s["sections"] == SECTIONS,
              "print: toolbar and jump bar hidden, every view present")
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
    check("not remembered" in page.text_content("#status"), "says the file is not remembered")
    page.click("[data-pref=weight][data-value=weight]")
    check(chart(page, "weight-mice", "c.options.scales.y.title.text") == "Body weight (g)", "toggles work without storage")
    check(not errors, f"no page errors {errors}")
    ctx.close()


def groups(browser, url, w, h):
    """The groups panel on the demo: make groups, tick mice, spread them, rename, then the charts by group."""
    print(f"groups panel {w}x{h}")
    ctx = browser.new_context(viewport={"width": w, "height": h})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("dialog", lambda d: d.accept())
    page.goto(url)
    page.click("#demo")
    page.wait_for_selector("#weight-group canvas")
    page.click("[data-groups-open]")
    check(page.locator("#group-panel").is_visible(), "panel opens")
    for _ in range(3):
        page.click('[data-gp="add"]')
    check(page.locator("[data-label]").count() == 3, "three groups added")
    page.click('[data-pick="tumor"]')
    ticked = page.evaluate("[...state.selected]")
    with_tumor = page.evaluate("state.base.latest.filter(r => r.volume > 0 && !r.flags.includes('ended')).map(r => r.id)")
    check(sorted(ticked) == sorted(with_tumor) and len(ticked) > 0, f"'With a tumor' ticks {len(ticked)} mice, skipping ended ones")
    page.click('[data-spread="volume"]')
    assign = page.evaluate("state.grouping.assign")
    sizes = sorted([list(assign.values()).count(g) for g in ("g1", "g2", "g3")])
    check(set(assign) == set(ticked) and sizes[-1] - sizes[0] <= 1, f"spread puts every ticked mouse in a group, sizes {sizes}")
    overflow = page.evaluate("(e => e.scrollWidth - e.clientWidth)(document.querySelector('#group-panel'))")
    check(overflow <= 0, f"panel has no sideways scroll ({overflow}px)")
    # A checkbox click ticks the mouse without highlighting it.
    first = page.locator("[data-sel]").first
    mid = first.get_attribute("data-sel")
    was = first.is_checked()
    first.click()
    check(page.evaluate(f"state.selected.has({mid!r})") != was and page.evaluate("state.focus") is None, "checkbox toggles the tick only")
    label = page.locator('[data-label="g1"]')
    label.fill("Low dose")
    label.press("Enter")
    check(page.evaluate("state.grouping.groups[0].label") == "Low dose", "group renamed")
    check(page.locator('[data-move="g1"] .lbl').inner_text() == "Low dose", "rename shows on the move buttons")
    page.locator('[data-label="g2"]').fill("Drug A")
    page.keyboard.press("Escape")  # no Enter: the name must still reach the charts
    check(page.locator("#group-panel").is_hidden(), "Escape closes the panel")
    check(chart(page, "weight-group", "c.data.datasets[1].label") == "Drug A", "a name typed then Escape shows in the charts")
    check(chart(page, "weight-group", "c.data.datasets[0].label") == "Low dose", "charts are by group, with the label")
    check("by group" in page.inner_text("#weight-group h2"), "titles say by group")
    check(page.locator("[data-cage]").all_inner_texts()[0] == "Low dose", "toolbar chips show the groups")
    rows = page.evaluate("state.views.table.rows()")
    check(rows[0][:3] == ["mouse", "cage", "group"], f"table CSV has cage and group {rows[0][:3]}")
    page.click('[data-pref="by"][data-value="cage"]')
    check(chart(page, "weight-group", "c.data.datasets[0].label") == "Cage 11", "back to by cage")
    page.click('[data-pref="by"][data-value="mine"]')
    check(chart(page, "weight-group", "c.data.datasets[0].label") == "Low dose", "back to my groups")
    page.reload()
    page.wait_for_selector("#weight-group canvas")
    labels = chart(page, "weight-group", "c.data.datasets.map(d => d.label)")
    check(labels[:2] == ["Low dose", "Drug A"], f"groups remembered after reload {labels}")
    check("group" in page.evaluate("allDataRows()[0]"), "data export has a group column")
    page.click("[data-groups-open]")
    page.click('[data-del="g3"]')
    check(page.locator("[data-label]").count() == 2, "group deleted")
    check(page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth") <= 0, "no sideways page scroll")
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
        groups(browser, url, 1440, 900)
        groups(browser, url, 375, 800)
        browser.close()
    httpd.shutdown()
    print("FAILED: %d" % len(failures) if failures else "all checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else None))
