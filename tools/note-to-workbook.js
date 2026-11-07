// Turn an experiment note (Markdown) into the rows of a study workbook, as JSON for build-workbook.ps1.
//   node tools/note-to-workbook.js "note.md" > rows.json    one-off migration; Mouse ID = cage-mouse (a placeholder)
//   node tools/note-to-workbook.js --demo > rows.json       the synthetic demo, with groups, cage moves and ended mice
// Output: { about?, mice: [{ id, sex, group, status, endDate, endReason, notes }],
//           measurements: [{ date, cage, mark, id, weight, length, breadth, notes }] }
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { parseNote } = require('../app.js');

const asNumber = s => (/^\d+$/.test(s) ? Number(s) : s);

function fromNote(text) {
  const p = parseNote(text);
  for (const w of p.warnings) process.stderr.write(`line ${w.line}: ${w.message}\n`);
  const measurements = p.sessions.flatMap(s => s.rows.map(r => ({
    date: s.date, cage: asNumber(r.cage), mark: asNumber(r.mouse), id: `${r.cage}-${r.mouse}`,
    weight: r.weight, length: r.length, breadth: r.breadth, notes: null,
  })));
  const ids = [...new Set(measurements.map(m => m.id))];
  const mice = ids.map(id => ({ id, sex: null, group: null, status: 'alive', endDate: null, endReason: null, notes: null }));
  return { mice, measurements };
}

// Synthetic demo: the demo note's 12 mice get IDs, are split into two groups on 2026-01-12 and rehoused,
// so cage 12 holds both groups; 2-3 is euthanized for weight loss and 3-4 is found dead between sessions.
function demo() {
  const text = fs.readFileSync(path.join(__dirname, '..', 'demo', 'synthetic-demo.md'), 'utf8');
  const { measurements } = fromNote(text);
  const old = ['1-1', '1-2', '1-3', '1-4', '2-1', '2-2', '2-3', '2-4', '3-1', '3-2', '3-3', '3-4'];
  const idOf = Object.fromEntries(old.map((o, k) => [o, `D${101 + k}`]));
  const vehicle = ['1-1', '1-3', '2-1', '2-3', '3-1', '3-3'];
  const after = { // from the split on 2026-01-12: old cage-mouse -> [cage, tail mark]
    '1-1': [11, 1], '1-3': [11, 2], '2-1': [11, 3], '2-3': [11, 4],
    '3-1': [12, 1], '3-3': [12, 2], '1-2': [12, 3], '1-4': [12, 4],
    '2-2': [13, 1], '2-4': [13, 2], '3-2': [13, 3], '3-4': [13, 4],
  };
  const ends = {
    '2-3': { status: 'euthanized', endDate: '2026-01-19', endReason: 'weight loss', notes: 'Lost > 20%.' },
    '3-4': { status: 'found dead', endDate: '2026-01-14', endReason: 'other', notes: null },
  };
  const rows = [];
  for (const m of measurements) {
    const o = m.id;
    if (ends[o] && m.date > ends[o].endDate) continue;
    const [cage, mark] = m.date >= '2026-01-12' ? after[o] : [m.cage, m.mark];
    rows.push({ ...m, id: idOf[o], cage, mark, notes: m.date === '2026-01-12' ? 'Split into groups' : null });
  }
  const mice = old.map(o => ({
    id: idOf[o], sex: 'F', group: vehicle.includes(o) ? 'Vehicle' : 'Treated',
    status: 'alive', endDate: null, endReason: null, notes: null, ...ends[o],
  }));
  return { about: 'SYNTHETIC DEMO DATA. Every number is invented to show the app; none comes from a real study.', mice, measurements: rows };
}

const arg = process.argv[2];
if (!arg) { process.stderr.write('usage: note-to-workbook.js note.md | --demo\n'); process.exit(2); }
const out = arg === '--demo' ? demo() : fromNote(fs.readFileSync(arg, 'utf8'));
process.stdout.write(JSON.stringify(out, null, 1));
