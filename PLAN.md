# In-vivo plots: plan

A static web app, hosted on GitHub Pages, that plots mouse study measurements (body weight, tumor size) from an Obsidian experiment note. The main use is on desktop, but it should also be optimized for an Android phone.

## Flow
1. On the phone, a photo of the day's measurement sheet goes into the study's experiment note in Obsidian. Claude transcribes it into a table (see *Input format*). Obsidian Sync brings the note to the phone.
2. The user opens the app, taps **Choose note** and picks the `.md` file from the vault folder (iOS: Files → On My iPhone → Obsidian; Android: the vault folder).
3. The app parses the note and draws the plots. It keeps the note text on the device, so the next visit shows the plots straight away; the user picks the file again only after new data.

## Constraints
- **No study data leaves the device.** The file is read with `FileReader`; nothing is uploaded. The repo is public (free GitHub Pages) and holds **code only**. Real notes for testing go in `private/`, which is gitignored. A demo file in the repo must be synthetic and labelled so.
- **No build step.** Plain HTML, CSS and JavaScript that GitHub Pages serves as-is.
- **Phone first, desktop dashboard.** One column, readable at 375 px. From 1000 px the views fill the window as a dashboard (2 columns; 3 charts per row from 1500 px), with both chart rows fitting a 1080p or 864p screen. Light and dark themes, following the OS or a toggle.
- **Works offline** once loaded (service worker + web app manifest, installable to the home screen).
- `localStorage` access wrapped in `try/catch`; the app must work when storage is unavailable.

## Input format (the contract with the vault)
Example: `private/Mouse Study 001-2026-11.md`. Documented in the vault in `02 Notes/In-vivo Plots.md`; keep the two in step.

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
- A mouse is identified by `cage-mouse` (e.g. `84-2`).
- Report rows that can't be parsed in a visible warnings list instead of failing silently.

## Derived values
- **Weight % change:** from the mouse's first recorded weight.
- **Tumor volume:** `longer × shorter² / 2` using `max`/`min` of the two sides (length and breadth are sometimes swapped, e.g. 89-3 on 2026-11-05). Only when both sides are present.
- **Groups:** by cage, or by the user's own groups. The groups panel assigns mice (not cages) to any number of named groups: tick mice (all / with a tumor in the latest session / tumor volume ≥ x / by hand), then move them into a group or spread them evenly (`distribute`: rank by latest tumor volume or body weight and send each run of k mice one to each of the k groups in random order, or shuffle). Stored on the device per note name (`in-vivo-plots:groups:<name>`) as `{ groups: [{ id, label }], assign: { mouseId: groupId } }`; not in the note, so the input format is unchanged. `applyGroups` turns the derived data into the same shape keyed by group (real cage kept in `realCage`), so every view works by group. Possible later: read the groups from the note so they sync across devices.
- **Summary per group per date:** mean ± SEM and `n` over mice with a value.

## Views
A toolbar above the charts scopes every view: group by cage or by the user's groups (with a button that opens the groups panel), cages or groups shown, weight as % change or grams, tumor as volume or relative volume (÷ the mouse's first measured volume), linear or log tumor axis, error bars (SEM, SD, none), x axis as date or study day (days since the first session), a highlighted mouse, theme. Settings are saved on the device.

1. Body weight per cage over time, mean ± error; reference lines at −15% and −20% in % mode.
2. Individual body weights, one line per mouse; colored by cage, or by mouse with end labels when one cage is shown.
3. Body weight per mouse at the latest session, bars sorted by value or by mouse.
4. Tumor volume per cage over time, mean ± error.
5. Individual tumor volumes, one line per mouse.
6. Tumor volume per mouse at the latest session.
7. Latest-values table per mouse: weight, % change, tumor volume, relative volume, sortable. Flag loss ≥ 15% (warning) and ≥ 20% (alert), and mice with data earlier but none in the latest session (in the current data: 86-5 after 2026-10-28, 87-5 after 2026-10-31).
8. Heat map of every mouse × session for one measure, values printed in the cells.

Tools: per-chart PNG (3×, with title and source line), copy image, CSV, full screen; tables copy as TSV; whole-dashboard PNG, tidy CSV of all data, print.

## Tech
- Chart.js 4, pinned to an exact version, from cdnjs or vendored into `vendor/` (vendoring is better for offline use).
- Files: `index.html`, `style.css`, `app.js` (parse → derive → render, parsing kept pure so it can be tested), `manifest.webmanifest`, `sw.js`, `icons/`.
- File input: avoid a restrictive `accept` (iOS can grey out `.md` files); validate after reading instead.

## Hosting
- Public repo `<github-user>/in-vivo-plots`, Pages from the `main` branch root → `https://<github-user>.github.io/in-vivo-plots/`.
- Before every push: check that `private/` and any real data are not staged.

## Milestones
1. Parser + derived values, tested against `private/Mouse Study 001-2026-11.md` (120 rows, 4 dates).
2. The four views.
3. Remembered note, offline support, installable.
4. Synthetic demo note, README, publish to GitHub Pages (with the user's OK).

## Open questions for the user
- What each cage is (treatment groups, controls)?
- Tumor size units (mm?).
- GitHub account and repo name.
- Any tumor-volume endpoint to flag?
