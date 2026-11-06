# In-vivo plots

Static GitHub Pages app that plots mouse study data from an Obsidian experiment note. **Read `PLAN.md` first**; it is the spec.

- Never commit study data. Real notes live in `private/` (gitignored); demo data must be synthetic.
- No build step: plain HTML/CSS/JS served as-is.
- The input format is a contract with the user's Obsidian vault (`02 Notes/In-vivo Plots.md` there). If it changes, tell the user so the vault note is updated too.
- Ask before pushing to GitHub.
