# In-vivo plots

Plots body weight, tumor volume and survival from a mouse study workbook (`.xlsx`) or an older study note (Markdown) chosen on your device. The file is read in the browser and never uploaded.

## Use

1. Open the app and tap **Choose file**, then pick the study's `.xlsx` workbook (or `.md` note) from the vault folder.
2. The app draws a dashboard. On a desktop screen it fills the window: the weight row and the tumor row each show the mean per group or cage, one line per mouse, and one bar per mouse at the latest session; below them are the survival curve, the latest-values table and a heat map of every measurement, then the injection calendar and table. On a narrower desktop window (under 1500 px) each row's bar chart runs full width under its two line charts, so weight comes first and tumor below it. On a phone the same views stack in one column. A bar under the toolbar (**Weight · Tumor · Survival · Latest values · All measurements · Injections**) stays at the top of the screen as you scroll: tap a topic to jump to it; the topic in view is highlighted.
   - body weight as % change (lines at −15% and −20%) or grams
   - tumor volume (longer × shorter² / 2) or relative to each mouse's first measured volume, on a linear or log axis
   - injections (from the workbook's Injections sheet) as a strip of ▲ under the weight, tumor and survival charts, one row per group or cage; hover or tap it to see the drug, dose and volume and how many mice got it. A hollow ▲ means only some mice in that group or cage were dosed. An **Injection calendar** shows the same doses as month grids (one chip per group or cage and drug, with how many of its mice were dosed; dashed means only some; ● marks measurement days), and an Injections table lists every mouse's drug on each injection day
   - on the individual lines, ◆ marks where a mouse moved cage (or got a new tail mark) and ✕ where it was euthanized, found dead or removed; the tooltip gives the cage and tail mark on that day
   - survival (Kaplan–Meier) per group or cage
   - a latest-values table with each mouse's current cage and tail mark, flagging weight loss ≥ 15% / ≥ 20%, mice that have ended (with date, study day and reason) and mice with no data in the latest session; click a column to sort
3. The toolbar above the charts sets what every view shows: **Group by** (the workbook's groups, each mouse's current cage, or your own groups), which groups or cages (click a chip to hide or show one, double-click to show only that one), weight and tumor units, error bars (SEM, SD or none), x axis as date or study day, a highlighted mouse (also set by clicking a line, bar or table row), and the theme. The settings are remembered on the device. On a phone only Group by and the group or cage chips show; tap **More settings** for the rest.
   - **Group** uses the Group column of the workbook's Mice sheet. A group can span cages and a cage can hold several groups.
   - **Cage** puts each mouse under the cage it is in now, with its whole history, so a cage's mean is the mean of its current mice.
4. **Make groups** opens a panel for planning groups on this device: tick mice (all, those with a tumor in the latest session, those with tumor volume ≥ a value, or one by one; mice that have ended are skipped), add and name groups, then put the ticked mice in a group, or spread them evenly across all groups balanced by tumor volume or body weight (click again to re-roll), or at random. Each group's n and mean ± SEM tumor volume, weight and weight change at the latest session are shown so you can check the groups are balanced. **Group by: My groups** draws every view by these groups. They are kept on this device for this file (by file name); **Copy for workbook** copies Mouse ID and group in the Mice sheet's order to put them in the workbook, and **Copy table**, **Copy for note** (Markdown) and **CSV** take them out too.
5. Tools: each chart can be downloaded as a PNG (3× resolution, with its title and the file name), copied to the clipboard, downloaded as CSV, or opened full screen (Esc closes it). The tables copy as tab-separated text for Excel or Prism. **Export** saves all seven charts as one PNG, every measurement and derived value as one CSV (with the cage and tail mark on each date), or prints (save as PDF from the print dialog). Switch the theme to Light before exporting for slides with a white background.
6. The file's data stays in this browser's storage, so the plots are there next time. Choose the file again after new data, or tap **Forget file**.

**Load demo** shows synthetic data (`demo/synthetic-demo.xlsx`). After the first visit the app works offline and can be installed to the home screen.

Rows the app can't read are listed under the header, with the sheet and row (workbook) or line number (note).

## Workbook format

- **Measurements**: `Date`, `Cage`, `Tail mark`, `Mouse ID`, `Weight (g)`, `Tumor Length`, `Tumor Breadth`, `Notes`, one row per mouse per session. Cage and tail mark are where the mouse was that day.
- **Mice**: `Mouse ID`, `Sex`, `Group`, `Status` (`alive`, `euthanized`, `found dead`, `removed`), `End date`, `End reason`, `Notes`, one row per mouse.
- **Injections** (optional): `Mouse ID`, `Date`, `Drug`, `Dose`, `Volume (µL)`, `Route`, `Notes`, one row per mouse per dose. Only Mouse ID, Date and Drug are required; other columns (such as `Group` or `Cage ID`) are ignored.
- **Locations** (optional, used by Excel, not read by the app): `Animal ID`, then one column per date mice were placed or moved, each cell `Cage-Tail mark` (e.g. `20184-2`), meaning where the mouse is from that date on. Fill it in by hand on move days (copy the last column, date it, change the mice that moved). The Measurements `Mouse ID` column is then a formula that finds the mouse from date, cage and tail mark, so in the lab you only write down cage and tail mark; a red, empty ID means nobody is at that place on Locations.

Columns are matched by name, in any order. `Animal ID` is read as `Mouse ID` and `Cage ID` as `Cage`; other columns (such as `Current cage` or `Current tail mark` on the Mice sheet) are ignored. An empty cell means "not measured". See `PLAN.md` → *Input format*; the same contract is documented in the Obsidian vault (`02 Notes/In-vivo Plots.md`). The older note format (one `## YYYY-MM-DD` heading and table per session) is still read.

## Develop

No build step. Serve the folder and open it:

```sh
python3 -m http.server   # http://localhost:8000
node --test test.js      # parsers and derived values (synthetic data only)
node --test private/private.test.js   # the real study, if you have it
uv run --no-project --with playwright==1.64.1 python tools/smoke_test.py [note.md]   # headless-browser check; set CHROMIUM=/path/to/chrome to reuse a browser
```

On Windows without Node, VS Code's own Node works: `ELECTRON_RUN_AS_NODE=1 "<VS Code>/Code.exe" --test test.js`.

- `vendor/chart.umd.min.js` is Chart.js 4.4.1 and `vendor/xlsx.mini.min.js` is SheetJS 0.20.3 (from cdn.sheetjs.com), vendored for offline use. SheetJS is loaded only when a workbook is opened.
- `sw.js` caches the app shell; bump `CACHE` when the file list changes.
- `.nojekyll` makes GitHub Pages serve files as-is (otherwise Jekyll turns `demo/*.md` into HTML).
- Workbooks: `node tools/note-to-workbook.js note.md > rows.json` (or `--demo`), then `powershell -File tools/build-workbook.ps1 -Json rows.json -Out "C:\full\path.xlsx"` builds the formatted workbook with Excel (Windows only): tables, dropdowns for Status, End reason and Mouse ID, frozen header row.
- Icons: `uv run --no-project --with pillow tools/make-icons.py`.
- Real study files go in `private/` (gitignored), never in the repo.
