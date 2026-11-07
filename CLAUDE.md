# In-vivo plots

Static GitHub Pages app that plots mouse study data from a study workbook (`.xlsx`) kept in the user's Obsidian vault, or an older experiment note (`.md`). **Read `PLAN.md` first**; it is the spec.

- Never commit study data. Real files live in `private/` (gitignored); demo data must be synthetic.
- No build step: plain HTML/CSS/JS served as-is.
- The input format is a contract with the user's Obsidian vault (`02 Notes/In-vivo Plots.md` there). If it changes, tell the user so the vault note is updated too.
- Transcribing a measurement sheet into the workbook: write cage and tail mark as on the sheet, and fill Mouse ID by matching (cage, tail mark) to the previous session. If a pair is new (a move), ask the user for the mapping; never guess an ID.
- Ask before pushing to GitHub.
