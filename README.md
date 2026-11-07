# In-vivo plots

Plots body weight and tumor volume from a mouse study note (Markdown) chosen on your device. The file is read in the browser and never uploaded.

## Use

1. Open the app and tap **Choose note**, then pick the study's `.md` file from the vault folder.
2. The app draws a dashboard. On a desktop screen it fills the window: the weight row and the tumor row each show the per-cage mean, one line per mouse, and one bar per mouse at the latest session; below them are the latest-values table and a heat map of every measurement. On a phone the same views stack in one column.
   - body weight as % change (lines at −15% and −20%) or grams
   - tumor volume (longer × shorter² / 2) or relative to each mouse's first measured volume, on a linear or log axis
   - a latest-values table that flags weight loss ≥ 15% / ≥ 20% and mice with no data in the latest session; click a column to sort
3. The toolbar above the charts sets what every view shows: which cages (click a chip to hide or show a cage, double-click to show only that one), weight and tumor units, error bars (SEM, SD or none), x axis as date or study day, a highlighted mouse (also set by clicking a line, bar or table row), and the theme. The settings are remembered on the device.
4. **Groups** (**Make groups** in the toolbar): tick mice (all, those with a tumor in the latest session, those with tumor volume ≥ a value, or one by one), add as many groups as you need and name each one (a treatment arm or a new cage), then put the ticked mice in a group, or spread them evenly across all groups balanced by tumor volume or body weight (click again to re-roll), or at random. Each group's n and mean ± SEM tumor volume, weight and weight change at the latest session are shown so you can check the groups are balanced. **Group by: My groups** then draws every chart and table by group instead of by cage; **Cage** switches back. The groups are kept on this device for this note (by file name), not written into the note; **Copy table**, **Copy for note** (Markdown) and **CSV** take them out. The Data export gains a `group` column.
5. Tools: each chart can be downloaded as a PNG (3× resolution, with its title and the note name), copied to the clipboard, downloaded as CSV, or opened full screen (Esc closes it). The tables copy as tab-separated text for Excel or Prism. **Export** saves all six charts as one PNG, every measurement and derived value as one CSV, or prints (save as PDF from the print dialog). Switch the theme to Light before exporting for slides with a white background.
6. The note text stays in this browser's storage, so the plots are there next time. Choose the file again after new data, or tap **Forget note**.

**Load demo** shows synthetic data (`demo/synthetic-demo.md`). After the first visit the app works offline and can be installed to the home screen.

Lines the app can't read are listed under the header, with line numbers.

## Note format

Each session is a `## YYYY-MM-DD` heading followed by a table with the columns `Cage No.`, `Mouse No.`, `Body Weight (g)`, `Tumor Length` and `Tumor Breadth`, in any order. An empty cell means "not measured". See `PLAN.md` → *Input format*; the same contract is documented in the Obsidian vault (`02 Notes/In-vivo Plots.md`).

## Develop

No build step. Serve the folder and open it:

```sh
python3 -m http.server   # http://localhost:8000
node --test test.js      # parser and derived values (synthetic data only)
uv venv .venv && uv pip install --python .venv playwright
.venv/bin/python tools/smoke_test.py [note.md]   # headless-browser check; set CHROMIUM=/path/to/chrome to reuse a browser
```

- `vendor/chart.umd.min.js` is Chart.js 4.4.1, vendored for offline use.
- `sw.js` caches the app shell; bump `CACHE` when the file list changes.
- `.nojekyll` makes GitHub Pages serve files as-is (otherwise Jekyll turns `demo/*.md` into HTML, which breaks **Load demo** and the service worker install).
- Icons: `uv run --no-project --with pillow tools/make-icons.py`.
- Real study notes go in `private/` (gitignored), never in the repo.
