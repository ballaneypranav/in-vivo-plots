# In-vivo plots: plan

A static web app, hosted on GitHub Pages, that plots mouse study measurements (body weight, tumor size, survival) from a study workbook kept in the Obsidian vault next to the experiment note. The main use is on desktop, but it should also be optimized for an Android phone.

## Flow
1. A photo of the day's measurement sheet goes into the study's experiment note in Obsidian. Claude transcribes it into the study workbook (`<study> Data.xlsx`, see *Input format*), filling in each mouse's ID. Obsidian Sync brings the workbook to the phone (Sync → *Sync other file types* on).
2. The user opens the app, taps **Choose file** and picks the `.xlsx` from the vault folder (iOS: Files → On My iPhone → Obsidian; Android: the vault folder).
3. The app parses the workbook and draws the plots. It keeps the parsed data on the device, so the next visit shows the plots straight away; the user picks the file again only after new data.

## Constraints
- **No study data leaves the device.** The file is read in the browser; nothing is uploaded. The repo is public (free GitHub Pages) and holds **code only**. Real notes for testing go in `private/`, which is gitignored. A demo file in the repo must be synthetic and labelled so.
- **No build step.** Plain HTML, CSS and JavaScript that GitHub Pages serves as-is.
- **Phone first, desktop dashboard.** One column, readable at 375 px. From 1000 px the views fill the window as a dashboard (2 columns; 3 charts per row from 1500 px), with both chart rows fitting a 1080p or 864p screen. Light and dark themes, following the OS or a toggle.
- **Works offline** once loaded (service worker + web app manifest, installable to the home screen).
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

| Mouse ID | Sex | Group | Status | End date | End reason | Notes |
|---|---|---|---|---|---|---|
| 1234567 | F | Vehicle | euthanized | 2026-11-12 | weight loss | |

Parsing rules (`parseWorkbook`, given `{ sheetName: rows }` from SheetJS so it runs in Node):
- The Measurements sheet is the one named `Measurements` whose header has `Date` and `Mouse ID`, else the first sheet with those; the Mice sheet likewise by `Mouse ID` and `Status`. Other sheets are ignored. The header is the first non-empty row; columns are matched by name (case and punctuation ignored, any order). Aliases: `Animal ID` = `Mouse ID`, `Cage ID` (or `Cage No.`) = `Cage`. Unknown columns, such as `Cage ID` and `Tail mark` on the Mice sheet, are ignored.
- `Date` / `End date`: an Excel date (serial number) or `YYYY-MM-DD` text. Empty measurement cells = not measured (`null`).
- `Status` is `alive` (or empty), `euthanized`, `found dead` or `removed`; anything but alive, or an end date, means the mouse has ended. Without an end date, its last measurement is used. Rows after the end date are ignored.
- Warnings (shown with sheet and row): bad dates or numbers, rows without a Mouse ID, a mouse listed twice on one date, two mice in the same cage and tail mark on one date, one tumor side only, measured mice missing from the Mice sheet, rows after the end date.
- When transcribing a sheet, match each (cage, tail mark) to the previous session to find the Mouse ID; a pair that is new (after a move) needs the mapping from the user.

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
- **Summary per group per date:** mean ± SEM and `n` over mice with a value.

## Views
A toolbar above the charts scopes every view: group by the workbook's groups, current cage, or the user's groups (with a button that opens the groups panel), cages or groups shown, weight as % change or grams, tumor as volume or relative volume (÷ the mouse's first measured volume), linear or log tumor axis, error bars (SEM, SD, none), x axis as date or study day (days since the first session), a highlighted mouse, theme. Settings are saved on the device.

1. Body weight per cage over time, mean ± error; reference lines at −15% and −20% in % mode.
2. Individual body weights, one line per mouse; colored by group or cage, or by mouse with end labels when one is shown. ◆ marks a move (new cage or tail mark), ✕ the end; the tooltip gives the cage and tail mark that day, the move and any note.
3. Body weight per mouse at the latest session, bars sorted by value or by mouse.
4. Tumor volume per cage over time, mean ± error.
5. Individual tumor volumes, one line per mouse.
6. Tumor volume per mouse at the latest session.
7. Survival per group or cage (Kaplan–Meier, stepped), with at-risk counts in the tooltip.
8. Latest-values table per mouse: current cage · tail mark, weight, % change, tumor volume, relative volume, sortable. Flag loss ≥ 15% (warning) and ≥ 20% (alert), ended mice (status, date, study day, reason), and mice with data earlier but none in the latest session that have not ended (in the current data: 86-5 after 2026-10-28, 87-5 after 2026-10-31).
9. Heat map of every mouse × session for one measure, values printed in the cells; a bar on the cell where a mouse moved, hatching after its end.

Tools: per-chart PNG (3×, with title and source line), copy image, CSV, full screen; tables copy as TSV; whole-dashboard PNG, tidy CSV of all data, print.

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
