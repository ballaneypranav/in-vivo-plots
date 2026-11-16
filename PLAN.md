# In-vivo plots: plan

A static web app, hosted on GitHub Pages, that plots mouse study measurements (body weight, tumor size, survival) from a study workbook kept in the Obsidian vault next to the experiment note. The main use is on desktop, but it should also be optimized for an Android phone.

## Flow
1. A photo of the day's measurement sheet goes into the study's experiment note in Obsidian. Claude transcribes it into the study workbook (`<study> Data.xlsx`, see *Input format*), filling in each mouse's ID. Obsidian Sync brings the workbook to the phone (Sync → *Sync other file types* on).
2. The user opens the app, taps **Choose file** and picks the `.xlsx` from the vault folder (iOS: Files → On My iPhone → Obsidian; Android: the vault folder).
3. The app parses the workbook and draws the plots. It keeps the parsed data on the device, so the next visit shows the plots straight away; the user picks the file again only after new data.

## Constraints
- **No study data leaves the device.** The file is read in the browser; nothing is uploaded. The repo is public (free GitHub Pages) and holds **code only**. Real notes for testing go in `private/`, which is gitignored. A demo file in the repo must be synthetic and labelled so.
- **No build step.** Plain HTML, CSS and JavaScript that GitHub Pages serves as-is.
- **Phone first, desktop dashboard.** One column, readable at 375 px. From 1000 px the views fill the window as a dashboard. With 2 columns each measure's time charts share a row and its per-mouse bars run full width beneath them (weight, then tumor). From 1500 px there are 3 charts per row (charts turned off in the Plots menu, or with nothing to show, leave no gap: the rest of their row shares its width, `layoutViews`), with both chart rows fitting a 1080p or 864p screen (under 800 px tall, e.g. 1366×768, the rows are 380 px instead; up to 900 px tall subtitles keep to one line, else two); under them survival (one third) and the latest-values table (two thirds) share a row, and the heat map runs full width. Supported up to 3440×1440: chart text grows from 12 px to 15 px with the window width (`chartFont`, redrawn when a resize crosses a step) and from 2400 px the page text is larger. On a phone, and on short landscape screens (≤ 500 px tall), the header is compact (KPI tiles one line each) and a chart card's tools sit on their own row when it has a control besides them (Order, Show). Date axes label only as many sessions as fit without touching (newest kept), every session keeping its grid line; per-mouse bar labels stand upright when tilted ones would touch. In tables the Mouse column stays put while scrolling sideways. Light and dark themes, following the OS or a toggle.
- **Works offline** once loaded (service worker + web app manifest, installable to the home screen). The service worker goes to the network first (so a push shows on the next visit) and falls back to its cache offline or when the network takes over 3 s.
- `localStorage` access wrapped in `try/catch`; the app must work when storage is unavailable.

## Input format (the contract with the vault)
Example: `private/Mouse Study 001-2026-11 Data.xlsx`. Documented in the vault in `02 Notes/In-vivo Plots.md`; keep the two in step.

### Workbook (`.xlsx`)
A mouse is its **Mouse ID** (the aTune ID). Cage and tail mark are attributes of a measurement, not of the mouse: tail marks are renumbered when mice are rehoused.

**Measurements** sheet, one row per mouse per session, as written on the day's sheet plus the Mouse ID:

| Date | Cage | Tail mark | Mouse ID | Weight (g) | Tumor Length | Tumor Breadth | Notes |
|---|---|---|---|---|---|---|---|
| 2026-11-07 | 92 | 4 | 1234567 | 19.11 | 3.81 | 3.81 | |

**Mice** sheet (optional), one row per mouse:

| Mouse ID | Sex | Group | Status | End date | End reason | Notes | Treatment start |
|---|---|---|---|---|---|---|---|
| 1234567 | F | Vehicle | euthanized | 2026-11-12 | weight loss | | 2026-11-03 |

`Treatment start` (optional, also `Start date`) is the mouse's own start, for staggered enrollment (each mouse starts when its tumor reaches a size); blank means its group's start from the Groups sheet. The study workbook also has `Start used`, an Excel formula (own start, else the group's) that the Checklist and Plan sheets use; the app ignores it.

**Injections** sheet (optional), one row per mouse per dose:

| Mouse ID | Date | Drug | Dose | Volume (µL) | Route | Notes |
|---|---|---|---|---|---|---|
| 1234567 | 2026-11-09 | IVIG | 1.5g/kg | 300 | IP | |

Other columns (the study workbook also has `Group`, `Cage ID` and `Tail mark` there, filled by formulas) are ignored: a mouse's group comes from the Mice sheet. `Dose`, `Volume (µL)` and `Route` are optional free text.

**Groups** sheet (optional), one row per group; the app reads only `Group` and `Treatment start`, for studies where groups start treatment on different days:

| Group | Color | Mice | Drugs | Treatment start |
|---|---|---|---|---|
| Treated | Blue | 6 | Drug X | 2026-03-02 |

The study workbook's Groups sheet also has `Color`, `Mice` and `Drugs` (formulas) and helper columns to the right; they are ignored. The group name matches the Mice sheet's `Group` (case ignored). A mouse's own Treatment start (Mice sheet) wins over its group's.

The measurement cadence is two labelled cells on the Groups sheet (K1:L2 in the study workbook, Excel names `MeasureEvery` and `MeasureFrom`): `Measure every (days)` with a whole number, and `Measure from` with a date measurements fall on, each value in the next filled cell to the right. Mice are weighed and measured every that many days from that date, whatever their group; when a day is skipped or moved the user sets `Measure from` to the new measurement day. Without `Measure from`, days are counted from the latest session.

**Regimens** sheet (optional), one line per drug a group gets; the app reads it when it has `Group`, `Drug` and `Days`:

| Group | Drug | Dose | Volume (µL) | Route | Days |
|---|---|---|---|---|---|
| CCR8 | mAb | 1mg/mouse | 370 | IP | 0 |
| CCR8 | CCR8-DH | 10nmol/mouse | 150 | IV | 2, 4 |

`Days` are whole days from each mouse's treatment start to give the drug, separated by commas (0 = the start day); empty means the drug is not on a schedule. Commas only, so Excel reads the list the same way: a day k is due when `","&k&","` is in `","&SUBSTITUTE(Days," ","")&","`. In Excel the column is formatted as Text (as a number, `10,100` would become 10100). The study workbook's Regimens also fills Dose and Volume on Injections and has a helper `Drug list` to the right (ignored).

**Checklist** and **Plan** sheets (Excel only; the app ignores them, and their first row matches none of the sheets above): the Checklist lists alive mice by cage for the day's sheet, with its date in B1 (today by default), D1 saying whether it is a measurement day, Inj showing only the drugs due that day from each mouse's Start used and its group's Regimens Days (with volume), or `not started`, and Weight, L and B greyed on days without measurements. Plan is alive mice × 21 days from its B1 (today by default), the drugs due in each cell and M over measurement days. Both were added by `tools/add-schedule.ps1`, which also limits the **Injected Drugs** sheet's "missed <drug>" (a groupmate got it that day, this mouse did not) to mice started by that day, so mice not yet enrolled are not marked.

**Locations** sheet (optional; the app ignores it, Excel formulas use it), kept by hand: `Animal ID` in column A, then one column per date a placement takes effect, cells `Cage-Tail mark` as text (e.g. `20184-2`). Each date column is where every mouse is from that date on; on a move day the user copies the last column, dates it and edits the mice that moved; a mouse's cell is blank once it has ended. With it:
- Measurements' `Mouse ID` is an Excel calculated column: the newest Locations column dated on or before the row's date, matched on `Cage-Tail mark`; empty (and red) when nobody is there. So in the lab only cage and tail mark are written down.
- The Mice sheet's `Current cage` and `Current tail mark` are formulas (last filled Locations cell).
- Excel stores the formula results in the file, which is what the app reads, so a workbook edited by a tool that does not recalculate (not Excel) can carry stale IDs.
- Added to the study workbook by a one-off Excel script on 2026-11-07; `tools/build-workbook.ps1` does not make it yet.

Parsing rules (`parseWorkbook`, given `{ sheetName: rows }` from SheetJS so it runs in Node):
- The Measurements sheet is the one named `Measurements` whose header has `Date` and `Mouse ID`, else the first sheet with those; the Mice sheet likewise by `Mouse ID` and `Status`. Other sheets are ignored. The header is the first non-empty row; columns are matched by name (case and punctuation ignored, any order). Aliases: `Animal ID` = `Mouse ID`, `Cage ID` (or `Cage No.`) = `Cage`. Unknown columns, such as `Current cage` and `Current tail mark` on the Mice sheet, are ignored.
- `Date` / `End date`: an Excel date (serial number) or `YYYY-MM-DD` text. Empty measurement cells = not measured (`null`).
- The Injections sheet is the one named `Injections` (or `Dosing`, `Doses`) whose header has `Date`, `Mouse ID` and `Drug`, else the first other sheet with those three. A row with no date, mouse or drug is skipped silently (formulas fill the other columns down the table). Injection dates need not be measurement dates.
- The Groups sheet (`parseGroups`) is the one named `Groups` (or `Group`) whose header has `Group` and `Treatment start` (or `Start date`, `Start`), else the first other sheet with both; without both columns it is not read. Rows with neither are skipped silently. Returns `groups: [{ group, start }]`, `start` null when empty.
- The Mice sheet's `Treatment start` (or `Treatment start date`, `Start date`) gives each roster entry `start` (ISO or null).
- The Regimens sheet (`parseRegimens`) is the one named `Regimens` (or `Regimen`) whose header has `Group`, `Drug` and `Days`, else the first other sheet with those. Returns `regimens: [{ group, drug, dose, volume, route, days }]`, `days` sorted, unique whole numbers; rows with no group, drug or days are skipped silently.
- The cadence (`parseCadence`) is read from the sheet named `Groups` (or `Group`): the first cell whose text is exactly `Measure every (days)` (or `Measure every`) and `Measure from`, case and punctuation ignored, each with its value in the next filled cell to the right. Returns `cadence: { every, from }` or null.
- `Status` is `alive` (or empty), `euthanized`, `found dead` or `removed`; anything but alive, or an end date, means the mouse has ended. Without an end date, its last measurement is used. Rows after the end date are ignored.
- Warnings (shown with sheet and row): bad dates or numbers, rows without a Mouse ID, a mouse listed twice on one date, two mice in the same cage and tail mark on one date, one tumor side only, measured mice missing from the Mice sheet, rows after the end date; on Injections: bad dates, rows without a Mouse ID or drug, the same drug twice for a mouse on one date, injections after the mouse's end date, and mice neither measured nor on the Mice sheet; on Groups: a bad treatment start, a group listed twice, a start with no group, (once) the Mice sheet's groups that have no start and none of whose mice has its own, and a bad `Measure every` or `Measure from`; on Mice: a bad treatment start, or one after the mouse's end date; on Regimens: days with no group or drug, a day that is not a whole number (e.g. `1 3` without a comma), and a day beyond ±365 (a list Excel read as one number).
- When transcribing a sheet, write date, cage, tail mark and measurements; the Mouse ID formula fills itself from the Locations sheet. A red (empty) Mouse ID means a move missing from Locations: ask the user for it, never guess.

### Note (`.md`, older format, still read)
Example: `private/Mouse Study 001-2026-11.md`.

```markdown
---
projects:
  - "[[UAB]]"
---
Free text, ignored.

## 2026-11-05: weights and tumors

![[photo.jpg]]

| Cage No. | Mouse No. | Body Weight (g) | Tumor Length | Tumor Breadth |
|---:|---:|---:|---:|---:|
| 84 | 2 | 19.11 | 3.81 | 3.81 |
| 84 | 3 | 22.90 |  |  |
```

Parsing rules:
- Skip frontmatter. A line matching `^## (\d{4}-\d{2}-\d{2})` starts a session with that date; the text after the date is ignored.
- In each session, find the table whose header has the five columns. Match columns by name (case-insensitive, any order); ignore unknown columns; skip the `|---|` row.
- Trim cells. Empty = not measured (`null`), not zero. Handle CRLF line endings.
- A mouse is identified by `cage-mouse` (e.g. `84-2`); its tail mark is the mouse number. No groups, moves or end dates.
- Report rows that can't be parsed in a visible warnings list instead of failing silently.

## Derived values
- **Where a mouse is:** each point keeps the cage and tail mark of that day, and `moved` (the previous place) when either changed. The mouse's `cage` and `mouse` are where it is now (its latest row), so by-cage views put its whole history under its current cage.
- **Ended mice:** status, end date, study day of the end and reason from the Mice sheet. Points after the end are empty; the last point on or before it carries the end marker. In the latest-values table an ended mouse is flagged `ended`, not `missing`.
- **Survival:** Kaplan–Meier per group or cage. Found dead, or euthanized for any reason but "end of study", is an event; euthanized at end of study, removed, or alive at the last session is censored.
- **Weight % change:** from the mouse's first recorded weight.
- **Tumor volume:** `longer × shorter² / 2` using `max`/`min` of the two sides (length and breadth are sometimes swapped, e.g. 89-3 on 2026-11-05). Only when both sides are present.
- **Groups:** by the workbook's groups (Mice sheet, in the order they first appear there; `studyGrouping`), by current cage, or by the user's own groups. The groups panel assigns mice (not cages) to any number of named groups: tick mice (all / with a tumor in the latest session / tumor volume ≥ x / by hand), then move them into a group or spread them evenly (`distribute`: rank by latest tumor volume or body weight and send each run of k mice one to each of the k groups in random order, or shuffle). Stored on the device per note name (`in-vivo-plots:groups:<name>`) as `{ groups: [{ id, label }], assign: { mouseId: groupId } }`; not in the note, so the input format is unchanged. `applyGroups` turns the derived data into the same shape keyed by group (real cage kept in `realCage`), so every view works by group. **Copy for workbook** copies Mouse ID and group in the Mice sheet's order, so planned groups can go into the workbook and sync from there.
- **Doses:** each mouse keeps its injections; `dosesByKey` gathers them per group or cage and date (drug, dose, volume, route, which mice), with the number of mice in that group not yet ended (`eligible`; when some of them have a treatment start, only those started by that date, so mice not yet enrolled are not counted), so a dose given to only some of them can be told apart. Each item also has its own `eligible`: when the drug is on the schedule of some member, the mice planned it that day plus any that got it anyway, else the group's `eligible`.
- **Summary per group per date:** mean ± SEM and `n` over mice with a value. A mouse with a treatment start (its own or its group's) counts only from its baseline session (`inGroupFrom`: the earlier of the sessions holding the last weight and the last volume on or before the start, else the start), so with staggered enrollment mice not yet enrolled are left out of their group's means, and a group's line begins at its baseline; mice with no start count throughout. Individual lines keep every session.
- **Treatment start:** a mouse's `start` is its own Treatment start (Mice sheet, kept as `ownStart`), else its group's (Groups sheet); mice with neither have none (`hasStarts` says whether any mouse has one). Each point carries `tday` (days from the start, negative before it), `pctStart` (weight % change from the last weight on or before the start) and `rtvStart` (volume ÷ the last volume on or before the start; none when no tumor was measured by then). `rebase` swaps these into `pct` and `rtv` for the "Change from: treatment start" setting, leaving the loss flags on the first weight. With x = days from start, `summarizeByTreatDay` takes the mean per day from start, each mouse from its baseline session on as above (a cage can mix starts, so it can have a point per day of either), `survivalFromStart` runs Kaplan–Meier from each mouse's start (alive mice censored at the latest session; mice that ended before their start left out), and `dosesByTreatDay` places each mouse's doses by its own start (`eligible` counts only mice that had reached that day by the data's cutoff, so a mouse enrolled two days ago is not expected at day 10). With a cadence, `summarizeByTreatDay(members, metric, bin)` takes the means in steps of `bin` = `cadence.every` days, rounding up (bin 2: day 0 holds days −1 and 0, day 2 holds 1 and 2), so staggered starts measured on shared calendar days line up; each mouse counts once per step, with its value nearest the step's day (the later on a tie), and each point lists the days it holds (`tdays`). Individual lines keep exact days.
- **Schedule:** each mouse with a start and a group with Regimens Days gets `planned`: one dose per day per scheduled drug, `date` = start + day, up to its end date, each `given` (an Injections row with that drug that day, case ignored), `missed` (none, dated on or before `cutoff`, the later of the latest session and the latest injection) or `planned` (after the cutoff). The cutoff comes from the data, not the clock, so a remembered file does not grow missed doses and doses not typed in yet are not missed. `offSchedule` lists injections of a scheduled drug on a day not planned (`not-planned`), or given before the mouse has a start (`no-start`); unscheduled drugs are never off schedule. `derive(parsed, { today })` keeps the device's date for the views only. `measureDates(cadence, latestDate, from, to)` lists the measurement days in a span, and `upcomingWork` the measurement days and planned, not given doses per group or cage for the coming days. `hasSchedule` is true with Regimens Days or a cadence.

## Views
A toolbar above the charts scopes every view: group by the workbook's groups, current cage, or the user's groups (with a button that opens the groups panel), cages or groups shown, weight as % change or grams, tumor as volume or relative volume (÷ the mouse's first measured volume), linear or log tumor axis, error bars (SEM, SD, none), x axis as date, study day (days since the first session) or, when mice have a treatment start, days from each mouse's start (axis titled, ticks as plain numbers, or the cadence's steps; mice with no start left out and counted in the chart text), weight % change and relative volume from the first value or from the treatment start (only with starts; from the start, the −15% / −20% lines are left off and the latest-values table says the flags stay on the first weight; with starts the table also has **Start** and **Days treated** columns), a highlighted mouse, theme (one button stepping Auto → Light → Dark), a **Plots** menu (a checkbox per chart, views 1–7; the per-mouse bars, views 3 and 6, are off by default since they have no time axis), and an **Export** menu (slide of weight + tumor, dashboard image, all data CSV, print). Settings are saved on the device. Under 700 px wide or 500 px tall only Group by and the chips show; a **More settings** toggle unfolds the rest (not saved).

A jump bar under the toolbar sticks to the top of the screen while scrolling: Weight (view 1, or the first weight chart shown), Tumor (4, likewise), Survival (7), Latest values (8), All measurements (9), Coming up (12), Injections (11), each scrolling to that card, with the topic in view marked (`aria-current`; cards side by side share a row, and the one last picked wins). A topic whose card is absent is left out. It scrolls sideways on a phone and is hidden when printing. It sits outside `<header>` but above `#views`, so `--top` (measured to `#views`) includes it and the dashboard rows are that much shorter. Card ids and order are as before.

1. Body weight per cage over time, mean ± error; reference lines at −15% and −20% in % mode.
2. Individual body weights, one line per mouse; colored by group or cage, or by mouse with end labels when one is shown. ◆ marks a move (new cage or tail mark), ✕ the end; the tooltip gives the cage and tail mark that day, the move and any note.
3. Body weight per mouse at the latest session, bars sorted by value or by mouse.
4. Tumor volume per cage over time, mean ± error. On the tumor volume charts (4, 5, 6, volume only, not relative) the range 50–100 is shaded (`TUMOR_BAND`, said in the subtitle).
5. Individual tumor volumes, one line per mouse.
6. Tumor volume per mouse at the latest session.
7. Survival per group or cage (Kaplan–Meier, stepped), with at-risk counts in the tooltip.
8. Latest-values table per mouse: current cage · tail mark, weight, % change, tumor volume, relative volume, sortable. Flag loss ≥ 15% (warning) and ≥ 20% (alert), ended mice (status, date, study day, reason), and mice with data earlier but none in the latest session that have not ended (in the current data: 86-5 after 2026-10-28, 87-5 after 2026-10-31).
9. Heat map of every mouse × session for one measure, values printed in the cells; a bar on the cell where a mouse moved, hatching after its end.
10. Injections (when the workbook has them): every mouse × injection day, the drug in each cell tinted by group or cage, dose and volume in the tooltip; CSV is one row per dose.
11. Injection calendar (same condition, placed before view 10): month grids (Sunday first) from the first session or dose to the last, leaving out weeks wholly outside that span (`doseCalendar`, UTC date math, built on `dosesByKey`). Each day shows the date (or study day with x = study day), ● on session days, and a chip per group or cage and drug in the group's color: drug, group or cage, and mice given / mice in it, dashed when only some got it (as the hollow ▲ of the dose strip); the tooltip has dose, volume, route and mouse IDs. Follows the shown groups or cages; a highlighted mouse outlines its doses. Under 700 px the cells hold colored dots and a per-month agenda lists the doses (no hover on touch). With a schedule, doses planned and not given show as dotted chips (red with "n missed" when missed), the span reaches the last planned dose, and ○ marks measurement days after the latest session for two weeks past today. It is drawn when there are doses, planned doses or coming measurement days. CSV is one row per day × group or cage × drug × status (given, missed, planned).
12. Coming up (with a schedule, placed before view 11): the next 7 days from the device's date, each with "weigh and measure tumors" on measurement days and the doses due (group or cage, drug, dose, volume, route, mice with cage and tail mark); then doses planned since the latest data and not entered yet, missed doses and doses off schedule. Follows the shown groups or cages; mice not yet started are not listed. CSV is one row per mouse per dose (and one per measurement day). A KPI tile counts missed doses.

On the time charts (views 1, 2, 4, 5, 7), a dose strip between the plot and the x axis has one lane per shown group or cage that was dosed: ▲ in its color on each dose date, filled when every mouse in it got the dose, hollow when only some did. Hovering or tapping the strip shows the date and what each lane got. The x axis widens to take doses outside the measurement dates.

Tools: per-chart slide image, quick copy, CSV, full screen (with the settings that change that view under its title: Group by and the chips, then e.g. Tumor, Tumor axis, Error bars, X axis, Change from and Highlight, per `CARD_CONTROLS`); tables copy as TSV; whole-dashboard PNG, tidy CSV of all data, print.

**Slide images** (for PowerPoint, 16:9 slide 13.33 × 7.5 in). Each chart is drawn again off screen (`renderOffscreen`, through `chartRenderers`) at a fixed size in px at 96 per inch, whatever the window: *Under a title* 1184 × 528 (12.3 × 5.5 in), *Full slide* 1280 × 720, *Half* 576 × 528, or *Two charts*, the chart and its weight or tumor counterpart side by side (survival pairs with tumor) in 1184 × 528. Text is 20 px (≈ 15 pt on the slide), lines and markers 1.5× thicker, drawn at 2.5× (2960 × 1320 px for *Under a title*); the PNG carries a 240 dpi pHYs chunk so PowerPoint inserts the downloaded file at that size (a clipboard copy is re-encoded by the browser and may lose it, so a paste may need resizing). Background white (default), dark, or none (transparent, dark text); chart title and source line on the image off (default, the slide has its own title) or on. The slide button opens a dialog with these options (saved on the device) and a preview placed on a 16:9 slide; the copy button copies a slide image with the saved options straight away. The Export menu's weight + tumor slide opens the dialog at *Two charts* without changing the saved size. Chart plugins (error bars, reference lines, end labels, dose strip) size their text and lines from `Chart.defaults.font.size`, so they scale with the chart text.

## Tech
- Chart.js 4, pinned to an exact version, from cdnjs or vendored into `vendor/` (vendoring is better for offline use).
- SheetJS 0.20.3 (`vendor/xlsx.mini.min.js`, from cdn.sheetjs.com, not the outdated npm package), loaded on demand when a workbook is opened; cached by the service worker. Date cells are read as serial numbers (`cellDates: false`) to avoid time-zone shifts.
- Files: `index.html`, `style.css`, `app.js` (parse → derive → render, parsing kept pure so it can be tested), `manifest.webmanifest`, `sw.js`, `icons/`.
- File input: avoid a restrictive `accept` (iOS can grey out `.md` files); a file starting with `PK` is read as a workbook, anything else as a note.
- Remembered data: a note as its text, a workbook as its parse output (`in-vivo-plots:note` = `{ name, text | parsed, savedAt }`).
- `tools/note-to-workbook.js` + `tools/build-workbook.ps1` (Excel, Windows) build a formatted workbook from a note, or the synthetic demo.

## Hosting
- Public repo `<github-user>/in-vivo-plots`, Pages from the `main` branch root → `https://<github-user>.github.io/in-vivo-plots/`.
- Before every push: check that `private/` and any real data are not staged.

## Milestones
1. Parser + derived values, tested against `private/Mouse Study 001-2026-11.md` (120 rows, 4 dates).
2. The four views.
3. Remembered note, offline support, installable.
4. Synthetic demo note, README, publish to GitHub Pages (with the user's OK).
5. Study workbook: Mouse ID, cage moves, groups from the Mice sheet, ended mice, survival.

## Open questions for the user
- Tumor size units (mm?).
- Stop drawing a group's mean once few of its mice remain (survivor bias), or show it to the end? Currently shown to the end, with n in the tooltip.
- GitHub account and repo name.
- Any tumor-volume endpoint to flag?
