# In-vivo plots

Static GitHub Pages app that plots mouse study data from a study workbook (`.xlsx`) kept in the user's Obsidian vault, or an older experiment note (`.md`). **Read `PLAN.md` first**; it is the spec.

- Never commit study data. Real files live in `private/` (gitignored); demo data must be synthetic.
- No build step: plain HTML/CSS/JS served as-is.
- The input format is a contract with the user's Obsidian vault (`02 Notes/In-vivo Plots.md` there). If it changes, tell the user so the vault note is updated too.
- Transcribing a measurement sheet into the workbook: write date, cage and tail mark as on the sheet; Animal ID is a formula that looks the mouse up on the Locations sheet (see `PLAN.md`). If it comes out empty (a move not yet on Locations), ask the user for the mapping; never guess an ID or type over the formula. Edit the workbook through Excel so formulas are recalculated and their results saved.
- Ask before pushing to GitHub.
