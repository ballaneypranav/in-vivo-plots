// Tests for the pure part of app.js. Run: node --test
// Only synthetic data here. Checks against the real note live in private/ (gitignored).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  parseNote, parseWorkbook, readWorkbookSheets, derive, summarize, tumorVolume, cleanGrouping, applyGroups, distribute, groupLabel,
  studyGrouping, survival, dosesByKey, doseCalendar, UNGROUPED, rebase, summarizeByTreatDay, survivalFromStart, dosesByTreatDay,
  measureDates, upcomingWork, splitByDrug, gridTemplate, CHART_IDS, HIDDEN_VIEWS,
} = require('./app.js');

const demo = fs.readFileSync(path.join(__dirname, 'demo', 'synthetic-demo.md'), 'utf8');
const HEADER = '| Cage No. | Mouse No. | Body Weight (g) | Tumor Length | Tumor Breadth |\n|---:|---:|---:|---:|---:|';
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !≈ ${b}`);

test('demo note: sessions, rows and the one bad cell', () => {
  const p = parseNote(demo);
  assert.deepEqual(p.sessions.map(s => s.date), ['2026-01-05', '2026-01-08', '2026-01-12', '2026-01-15', '2026-01-19']);
  assert.equal(p.sessions.reduce((n, s) => n + s.rows.length, 0), 60);
  assert.equal(p.warnings.length, 1);
  assert.match(p.warnings[0].message, /1-4, weight "n\/a"/);
  const r = p.sessions[4].rows.find(x => x.cage === '1' && x.mouse === '4');
  assert.deepEqual(r, { cage: '1', mouse: '4', weight: null, length: 6.8, breadth: 5.9 });
});

test('demo note: derived values and flags', () => {
  const d = derive(parseNote(demo));
  assert.deepEqual(d.cages, ['1', '2', '3']);
  const byId = Object.fromEntries(d.latest.map(r => [r.id, r]));
  close(byId['2-3'].pct, ((17.6 - 22.5) / 22.5) * 100);
  assert.deepEqual(byId['2-3'].flags, ['loss-alert']);
  assert.deepEqual(byId['3-2'].flags, ['loss-warning']);
  assert.deepEqual(byId['3-4'].flags, ['missing']);
  assert.equal(byId['3-4'].lastSeen, '2026-01-12');
  assert.deepEqual(byId['1-2'].flags, [], 'a gap before the latest session is not "missing"');
  assert.deepEqual(byId['1-4'].flags, [], 'unreadable latest weight: no % change, but tumor seen');
  close(byId['2-1'].volume, (4.1 * 3.6 * 3.6) / 2); // sides swapped in the note
  const flagged = d.latest.filter(r => r.flags.length).map(r => r.id).sort();
  assert.deepEqual(flagged, ['2-3', '3-2', '3-4']);
});

test('demo note: per-cage mean ± SEM skips missing values', () => {
  const d = derive(parseNote(demo));
  const cage1 = d.groups.find(g => g.cage === '1');
  const jan12 = cage1.weight[2];
  assert.equal(jan12.n, 3); // 1-2 not weighed
  close(jan12.mean, (21.7 + 21.0 + 23.4) / 3);
  assert.equal(cage1.volume[0].n, 0);
  assert.equal(cage1.volume[0].mean, null);
});

test('demo note: study day and relative tumor volume', () => {
  const d = derive(parseNote(demo));
  assert.deepEqual(d.days, [0, 3, 7, 10, 14]);
  assert.deepEqual(d.mice[0].points.map(p => p.day), d.days);
  for (const m of d.mice) {
    const first = m.points.find(p => p.volume !== null);
    for (const p of m.points) {
      if (p.volume === null) assert.equal(p.rtv, null);
      else close(p.rtv, p.volume / first.volume);
    }
    if (first) close(first.rtv, 1);
  }
  const byId = Object.fromEntries(d.latest.map(r => [r.id, r]));
  const m21 = d.mice.find(m => m.id === '2-1');
  close(byId['2-1'].rtv, m21.points[4].volume / m21.firstVolume);
  const cage1 = d.groups.find(g => g.cage === '1');
  assert.equal(cage1.rtv.length, 5);
  assert.equal(cage1.rtv[0].n, 0);
});

test('summarize: SEM is sample SD / sqrt(n); none for n < 2', () => {
  const s = summarize([2, 4, 4, 4, 5, 5, 7, 9]);
  close(s.mean, 5);
  close(s.sem, Math.sqrt(32 / 7) / Math.sqrt(8));
  assert.deepEqual(summarize([3]), { mean: 3, sem: null, n: 1 });
  assert.deepEqual(summarize([null, undefined]), { mean: null, sem: null, n: 0 });
});

test('tumorVolume uses longer × shorter² / 2 and needs both sides', () => {
  close(tumorVolume(5, 4), 40);
  close(tumorVolume(4, 5), 40);
  assert.equal(tumorVolume(4, null), null);
});

test('columns are matched by name in any order; unknown columns ignored; CRLF ok', () => {
  const note = [
    '---', 'a: 1', '---', '## 2026-02-01 anything here',
    '| Tumor Breadth | Notes | body weight (g) | MOUSE NO. | Cage No | Tumor Length |',
    '|---|---|---|---|---|---|',
    '| 2 | ok | 20.5 | 7 | 12 | 3 |',
  ].join('\r\n');
  const p = parseNote(note);
  assert.deepEqual(p.warnings, []);
  assert.deepEqual(p.sessions[0].rows, [{ cage: '12', mouse: '7', weight: 20.5, length: 3, breadth: 2 }]);
});

test('blank rows are silent; bad rows are reported with line numbers', () => {
  const note = [
    '## 2026-02-01', HEADER,
    '| 1 | 1 |  |  |  |',      // measured nothing: fine
    '|  |  |  |  |  |',        // blank template row: fine
    '|  | 2 | 20 |  |  |',     // no cage
    '| 1 | 1 | 21 |  |  |',    // duplicate
    '| 1 | 3 | 20,5 | 3 |  |', // comma decimal, one tumor side
  ].join('\n');
  const p = parseNote(note);
  assert.equal(p.sessions[0].rows.length, 2);
  assert.deepEqual(p.warnings.map(w => w.line), [6, 7, 8, 8]);
  assert.match(p.warnings[0].message, /row skipped/);
  assert.match(p.warnings[1].message, /listed twice/);
  assert.match(p.warnings[2].message, /"20,5" is not a number/);
  assert.match(p.warnings[3].message, /only one tumor side/);
});

test('session headings, other tables, out-of-order dates', () => {
  const note = [
    'Intro table, ignored (no session yet):', HEADER, '| 9 | 9 | 99 |  |  |',
    '## 2026-03-05', '| a | b |', '|---|---|', '| 1 | 2 |', '', HEADER, '| 1 | 1 | 20 |  |  |',
    '## 2026-03-01', HEADER, '| 1 | 1 | 19 |  |  |',
    '## 2026-02-30', HEADER, '| 1 | 1 | 18 |  |  |',
    '## 2026-03-09 no table here',
    '## Discussion', HEADER, '| 5 | 5 | 50 |  |  |',
  ].join('\n');
  const p = parseNote(note);
  assert.deepEqual(p.sessions.map(s => s.date), ['2026-03-01', '2026-03-05', '2026-03-09']);
  assert.deepEqual(p.sessions.map(s => s.rows.length), [1, 1, 0]);
  assert.equal(p.warnings.length, 2);
  assert.match(p.warnings[0].message, /not a real date/);
  assert.match(p.warnings[1].message, /2026-03-09 has no table/);
  const d = derive(p);
  close(d.mice[0].points[1].pct, ((20 - 19) / 19) * 100);
});

test('weight % change starts from the first recorded weight, not the first session', () => {
  const note = ['## 2026-04-01', HEADER, '| 1 | 1 |  |  |  |', '## 2026-04-02', HEADER, '| 1 | 1 | 20 |  |  |',
    '## 2026-04-03', HEADER, '| 1 | 1 | 15 |  |  |'].join('\n');
  const d = derive(parseNote(note));
  assert.deepEqual(d.mice[0].points.map(p => p.pct), [null, 0, -25]);
  assert.deepEqual(d.latest[0].flags, ['loss-alert']);
});

test('empty or unrelated text gives no sessions and no crash', () => {
  for (const text of ['', 'just some words', null, '---\nunclosed: frontmatter']) {
    const p = parseNote(text);
    assert.deepEqual(p.sessions, []);
    const d = derive(p);
    assert.deepEqual(d.mice, []);
    assert.equal(d.latestDate, null);
  }
});

// Deterministic stand-in for Math.random.
const seeded = seed => () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

test('cleanGrouping drops malformed groups and assignments', () => {
  const g = cleanGrouping({
    groups: [{ id: 'g1', label: 'Vehicle' }, { id: 'g1', label: 'dup' }, { id: UNGROUPED }, { id: 'g2' }, null, 'x'],
    assign: { '1-1': 'g1', '1-2': 'g9', '9-9': 'g2' },
  });
  assert.deepEqual(g.groups, [{ id: 'g1', label: 'Vehicle' }, { id: 'g2', label: '' }]);
  assert.deepEqual(g.assign, { '1-1': 'g1', '9-9': 'g2' }, 'unknown mice are kept, unknown groups dropped');
  assert.deepEqual(cleanGrouping(null), { groups: [], assign: {} });
  assert.equal(groupLabel(g, 'g2'), 'Group 2', 'a blank label falls back to its position');
});

test('applyGroups re-keys the derived data by group', () => {
  const d = derive(parseNote(demo));
  const grouping = cleanGrouping({
    groups: [{ id: 'b', label: 'Drug' }, { id: 'a', label: 'Vehicle' }],
    assign: { '1-1': 'a', '2-1': 'a', '3-1': 'b', '1-2': 'b', 'gone-1': 'a' },
  });
  const g = applyGroups(d, grouping);
  assert.equal(g.unit, 'group');
  assert.deepEqual(g.cages, ['b', 'a', UNGROUPED], 'user order, then the mice in no group');
  assert.deepEqual(g.labels, { b: 'Drug', a: 'Vehicle', [UNGROUPED]: 'Not grouped' });
  assert.deepEqual(g.mice.slice(0, 4).map(m => `${m.id}:${m.cage}:${m.realCage}`), ['1-2:b:1', '3-1:b:3', '1-1:a:1', '2-1:a:2']);
  assert.equal(g.mice.length, d.mice.length);
  assert.deepEqual(g.latest.map(r => r.id), g.mice.map(m => m.id));
  const veh = g.groups.find(x => x.cage === 'a');
  assert.deepEqual(veh.mice, ['1-1', '2-1']);
  close(veh.weight[0].mean, (21.0 + 24.2) / 2);
  assert.equal(d.unit, 'cage');
  assert.equal(d.mice[0].cage, '1', 'the by-cage data is not changed');
});

test('distribute: every mouse placed, sizes within one, balanced by rank', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, volume: i === 19 ? null : (i + 1) * 10, weight: 20 }));
  const ids = ['g1', 'g2', 'g3'];
  for (const by of ['volume', 'weight', 'random']) {
    const out = distribute(rows, ids, by, seeded(7));
    assert.equal(Object.keys(out).length, 20);
    const sizes = ids.map(g => Object.values(out).filter(x => x === g).length).sort();
    assert.deepEqual(sizes, [6, 7, 7], by);
  }
  // By volume: the three largest tumors go to three different groups, and so on down the ranking.
  const out = distribute(rows, ids, 'volume', seeded(3));
  for (let top = 18; top >= 3; top -= 3) {
    const block = [top, top - 1, top - 2].map(i => out[`m${i}`]);
    assert.equal(new Set(block).size, 3, `block ending m${top - 2}`);
  }
  assert.deepEqual(distribute(rows, [], 'volume'), {});
});

/* ------------------------------------------------------------- workbook */

const XLSX = require('./vendor/xlsx.mini.min.js');
const MEAS_HEAD = ['Date', 'Cage', 'Tail mark', 'Mouse ID', 'Weight (g)', 'Tumor Length', 'Tumor Breadth', 'Notes'];
const MICE_HEAD = ['Mouse ID', 'Sex', 'Group', 'Status', 'End date', 'End reason', 'Notes'];
const serial = iso => (Date.parse(iso) - Date.UTC(1899, 11, 30)) / 86400000; // Excel date number

test('workbook: rows, Excel dates, text dates, moves and the Mice sheet', () => {
  const sheets = {
    Measurements: [
      MEAS_HEAD,
      [serial('2026-03-01'), 5, 1, 'A1', 20, null, null, null],
      [serial('2026-03-01'), 5, 2, 'A2', 21, 3, 2, null],
      [],
      ['2026-03-04', 9, 3, 'A1', 19.5, null, null, 'moved'],
      ['2026-03-04', '5', '2', 'A2', '20.5', '4', '3', null],
    ],
    Mice: [MICE_HEAD, ['A1', 'F', 'Drug', 'alive'], ['A2', 'F', 'Vehicle', 'euthanized', serial('2026-03-04'), 'tumor volume']],
  };
  const p = parseWorkbook(sheets);
  assert.deepEqual(p.warnings, []);
  assert.deepEqual(p.sessions.map(s => s.date), ['2026-03-01', '2026-03-04']);
  assert.deepEqual(p.sessions[1].rows[0], { id: 'A1', cage: '9', mark: '3', weight: 19.5, length: null, breadth: null, note: 'moved' });
  assert.deepEqual(p.sessions[1].rows[1], { id: 'A2', cage: '5', mark: '2', weight: 20.5, length: 4, breadth: 3 });
  assert.equal(p.mice[1].endDate, '2026-03-04');

  const d = derive(p);
  const a1 = d.mice.find(m => m.id === 'A1');
  assert.equal(a1.cage, '9', 'current cage');
  assert.equal(a1.mouse, '3', 'current tail mark');
  assert.deepEqual(a1.points.map(x => x.cage), ['5', '9']);
  assert.deepEqual(a1.points[1].moved, { cage: '5', mark: '1' });
  assert.equal(a1.points[0].moved, undefined);
  assert.deepEqual(d.cages, ['5', '9']);
  const a2 = d.latest.find(r => r.id === 'A2');
  assert.deepEqual(a2.flags, ['ended']);
  assert.equal(a2.endDay, 3);
  assert.equal(d.mice.find(m => m.id === 'A2').points[1].end, true);
  assert.deepEqual(studyGrouping(d).groups.map(g => g.id), ['Drug', 'Vehicle'], 'Mice sheet order');
  const g = applyGroups(d, studyGrouping(d));
  assert.deepEqual(g.cages, ['Drug', 'Vehicle']);
  assert.equal(g.mice.find(m => m.id === 'A1').realCage, '9');
});

test('workbook: Animal ID and Cage ID headers, numeric IDs, extra Mice columns', () => {
  const sheets = {
    Measurements: [
      ['Animal ID', 'Cage ID', 'Tail mark', 'Date', 'Weight (g)', 'Tumor Length', 'Tumor Breadth', 'Notes'],
      [101, 3001, 1, serial('2026-03-01'), 20, null, null, null],
      [102, 3001, 2, serial('2026-03-01'), 21, 3, 2, null],
    ],
    Mice: [
      ['Animal ID', 'Cage ID', 'Tail mark', 'Sex', 'Group', 'Status', 'End date', 'End reason', 'Notes'],
      [101, 3001, 1, 'F', 'Drug', 'alive'],
      [102, 3001, 2, 'F', 'Vehicle', 'alive'],
    ],
  };
  const p = parseWorkbook(sheets);
  assert.deepEqual(p.warnings, []);
  assert.deepEqual(p.sessions[0].rows[1], { id: '102', cage: '3001', mark: '2', weight: 21, length: 3, breadth: 2 });
  assert.deepEqual(p.mice.map(m => [m.id, m.group]), [['101', 'Drug'], ['102', 'Vehicle']]);
});

test('workbook: problems are reported with sheet and row', () => {
  const sheets = {
    Data: [
      ['Notes', 'Mouse ID', 'Date', 'Weight (g)', 'Cage', 'Tail mark', 'Tumor Length', 'Tumor Breadth'],
      [null, 'A1', '2026-03-01', 20, 1, 1],
      [null, '', '2026-03-01', 20, 1, 2], // no ID
      [null, 'A1', '2026-03-01', 21, 1, 1], // twice
      [null, 'A3', 'March 1', 20, 1, 3], // bad date
      [null, 'A4', '2026-03-01', 'n/a', 1, 1], // bad number, same spot as A1
      [null, 'A5', '2026-03-01', 20, 2, 1, 3, null], // one tumor side
      [null, 'A6', '2026-03-09', 20, 2, 2], // after its end date
      [null, 'A6', '2026-03-01', 22, 2, 2],
    ],
    Mice: [MICE_HEAD, ['A1', '', '', 'alive'], ['A6', '', '', 'found dead', '2026-03-05'], ['A7', '', '', 'gone']],
  };
  const p = parseWorkbook(sheets);
  const at = p.warnings.map(w => w.where);
  assert.equal(at[0], 'Mice row 4');
  assert.match(p.warnings[0].message, /"gone" is not one of/);
  assert.ok(['Data row 3', 'Data row 4', 'Data row 5'].every(w => at.includes(w)), at.join('; '));
  assert.ok(p.warnings.some(w => w.where === 'Data row 6' && /both in cage 1, tail 1/.test(w.message)));
  assert.ok(p.warnings.some(w => w.where === 'Data row 6' && /"n\/a" is not a number/.test(w.message)));
  assert.ok(p.warnings.some(w => w.where === 'Data row 7' && /only one tumor side/.test(w.message)));
  assert.ok(p.warnings.some(w => w.where === 'Data row 8' && /ended on 2026-03-05/.test(w.message)));
  const dd = derive(p);
  assert.deepEqual(dd.mice.find(m => m.id === 'A6').points.map(x => [x.date, x.weight]), [['2026-03-01', 22], ['2026-03-09', null]]);
  assert.deepEqual(dd.groups.find(g => g.cage === '2').weight.map(x => [x.date, x.n]), [['2026-03-01', 2], ['2026-03-09', 0]],
    'nothing after the end date reaches the plots or group means');
  assert.ok(p.warnings.some(w => w.where === 'Mice' && /A4, A5/.test(w.message)), 'measured mice missing from the Mice sheet');
  assert.ok(p.warnings.some(w => /A7 is gone but has no end date/.test(w.message)));
  assert.deepEqual(parseWorkbook({ Sheet1: [['a', 'b']] }).sessions, []);
});

test('workbook: Injections sheet, with formula-only rows, warnings and doses per group', () => {
  const xl = iso => (Date.UTC(...iso.split('-').map((v, i) => (i === 1 ? v - 1 : +v))) - Date.UTC(1899, 11, 30)) / 86400000;
  const sheets = {
    Measurements: [
      ['Animal ID', 'Cage ID', 'Tail mark', 'Date', 'Weight (g)', 'Tumor Length', 'Tumor Breadth'],
      ['A1', '1', '1', xl('2026-01-01'), 20, null, null],
      ['A2', '1', '2', xl('2026-01-01'), 21, null, null],
      ['B1', '2', '1', xl('2026-01-01'), 22, null, null],
      ['A1', '1', '1', xl('2026-01-05'), 20.5, null, null],
    ],
    Mice: [
      ['Animal ID', 'Group', 'Status', 'End date'],
      ['A1', 'Drug', 'alive', null], ['A2', 'Drug', 'euthanized', xl('2026-01-02')], ['B1', 'Vehicle', 'alive', null],
    ],
    Injections: [
      ['Animal ID', 'Group', 'Cage ID', 'Tail mark', 'Date', 'Drug', 'Volume (µL)', 'Dose', 'Notes'],
      ['A1', 'Drug', 1, 1, xl('2026-01-02'), 'X', 100, '1 mg/kg', null],
      ['A2', 'Drug', 1, 2, xl('2026-01-02'), 'X', 100, '1 mg/kg', null],
      ['B1', 'Vehicle', 2, 1, '2026-01-02', 'PBS', 100, null, 'late'],
      ['A1', 'Drug', 1, 1, xl('2026-01-06'), 'X', 100, '1 mg/kg', null], // after the last session
      ['A2', 'Drug', 1, 2, xl('2026-01-06'), 'X', 100, '1 mg/kg', null], // after A2's end
      ['A1', 'Drug', 1, 1, xl('2026-01-06'), 'X', 100, '1 mg/kg', null], // twice
      ['B1', null, null, null, xl('2026-01-06'), null, 100, '1 mg/kg', null], // no drug
      ['Z9', null, null, null, xl('2026-01-06'), 'X', null, null, null], // unknown mouse
      [null, '', '', '', null, null, 0, '', null], // formula-only row: silent
    ],
  };
  const p = parseWorkbook(sheets);
  assert.deepEqual(p.injections.map(i => `${i.id}@${i.date}:${i.drug}`), ['A1@2026-01-02:X', 'A2@2026-01-02:X', 'B1@2026-01-02:PBS', 'A1@2026-01-06:X']);
  assert.deepEqual(p.injections[0], { id: 'A1', date: '2026-01-02', drug: 'X', dose: '1 mg/kg', volume: '100', route: '' });
  assert.equal(p.injections[2].note, 'late');
  assert.deepEqual(p.warnings.map(w => w.where), ['Injections row 6', 'Injections row 7', 'Injections row 8', 'Injections']);
  const d = derive(p);
  assert.deepEqual(d.injectionDates, ['2026-01-02', '2026-01-06']);
  const g = applyGroups(d, studyGrouping(d));
  const doses = dosesByKey(g.mice, g.cages);
  assert.deepEqual(doses.map(x => x.key), ['Drug', 'Vehicle']);
  assert.deepEqual(doses[0].doses.map(z => [z.date, z.eligible, z.items.map(i => i.mice.join('+'))]),
    [['2026-01-02', 2, ['A1+A2']], ['2026-01-06', 1, ['A1']]]);
  assert.deepEqual(parseWorkbook({ Measurements: sheets.Measurements }).injections, []);
  assert.equal(derive(parseNote(demo)).injectionDates.length, 0, 'notes have no injections');
});

test('doseCalendar: month grids, partial and double doses, a dose after the last session, ended mice', () => {
  const inj = (id, date, drug) => ({ id, date, drug, dose: '1 mg', volume: '100', route: 'IP' });
  const mouse = (id, cage, injections, endDate = null) => ({ id, cage, injections, ended: Boolean(endDate), endDate });
  const mice = [
    mouse('A', 'X', [inj('A', '2026-01-30', 'P'), inj('A', '2026-02-05', 'P')]),
    mouse('B', 'X', [inj('B', '2026-01-30', 'P')], '2026-01-31'), // ended before the 02-05 dose
    mouse('C', 'Y', [inj('C', '2026-01-30', 'P'), inj('C', '2026-01-30', 'Q')]),
    mouse('D', 'Y', [inj('D', '2026-01-30', 'P')]),
  ];
  const months = doseCalendar(mice, ['X', 'Y'], ['2026-01-29', '2026-02-02']);
  // Only weeks that touch 01-29 .. 02-05 are kept: Jan 25-31, and Feb 1-7 (a Sunday start, so no leading blanks).
  assert.deepEqual(months.map(m => [m.key, m.year, m.month, m.weeks.length]), [['2026-01', 2026, 0, 1], ['2026-02', 2026, 1, 1]]);
  assert.ok(months.every(m => m.weeks.every(w => w.length === 7)));
  const cells = months.flatMap(m => m.weeks.flat());
  const at = date => cells.find(c => c && c.date === date);
  assert.deepEqual(months[0].weeks[0].map(c => c && c.date.slice(8)), ['25', '26', '27', '28', '29', '30', '31']);
  assert.equal(months[1].weeks[0][0].date, '2026-02-01');
  assert.equal(months[1].weeks[0][6].date, '2026-02-07');
  assert.equal(at('2026-01-30'), months[0].weeks[0][5], 'the 30th is a Friday (column 5)');
  // January 2026 starts on a Thursday: a week kept in the middle of a month still pads the other month with nulls.
  const mid = doseCalendar([mouse('F', 'Z', [inj('F', '2026-01-02', 'P')])], ['Z'], ['2026-01-02']);
  assert.deepEqual(mid[0].weeks[0].map(c => c && c.date.slice(8)), [null, null, null, null, '01', '02', '03']);
  // Range, measurement days and study days.
  assert.equal(at('2026-01-25').inRange, false);
  assert.equal(at('2026-01-29').inRange, true);
  assert.equal(at('2026-02-05').inRange, true, 'the span runs to the last dose, after the last session');
  assert.equal(at('2026-02-06').inRange, false);
  assert.deepEqual(['2026-01-29', '2026-01-30', '2026-02-02', '2026-02-05'].map(x => at(x).measured), [true, false, true, false]);
  assert.deepEqual(['2026-01-29', '2026-01-30', '2026-02-05'].map(x => at(x).day), [0, 1, 7]);
  // The 30th: cage X gets P (2 of 2), cage Y gets P (2 of 2) and Q (1 of 2, partial) on the same day.
  assert.deepEqual(at('2026-01-30').items.map(i => [i.key, i.drug, i.n, i.eligible, i.mice.join('+')]),
    [['X', 'P', 2, 2, 'A+B'], ['Y', 'P', 2, 2, 'C+D'], ['Y', 'Q', 1, 2, 'C']]);
  // B had ended: only A was eligible on 02-05, so A's dose is a full one.
  assert.deepEqual(at('2026-02-05').items.map(i => [i.key, i.n, i.eligible]), [['X', 1, 1]]);
  assert.equal(at('2026-02-02').items.length, 0);
  assert.deepEqual(at('2026-01-30').items[0], { key: 'X', drug: 'P', dose: '1 mg', volume: '100', route: 'IP', n: 2, eligible: 2, mice: ['A', 'B'] });
  // A hidden group leaves the calendar; no sessions and no doses give no months; an injection alone still makes one.
  assert.deepEqual(doseCalendar(mice, ['Y'], ['2026-01-29']).flatMap(m => m.weeks.flat()).filter(c => c && c.items.length).map(c => c.date), ['2026-01-30']);
  assert.deepEqual(doseCalendar([], [], []), []);
  const lone = doseCalendar(mice, ['X'], []);
  assert.equal(lone.length, 2);
  assert.equal(lone[0].weeks.flat().find(c => c && c.date === '2026-01-30').day, null);
  // A study that crosses a year boundary.
  const ny = doseCalendar([mouse('E', 'Z', [inj('E', '2027-01-02', 'P')])], ['Z'], ['2026-12-28']);
  assert.deepEqual(ny.map(m => m.key), ['2026-12', '2027-01']);
});

test('survival: endpoints are events, end of study and removed are censored', () => {
  const m = (id, cage, endDate = null, status = 'alive', endReason = '') => ({ id, cage, ended: Boolean(endDate), endDate, status, endReason });
  const mice = [
    m('a', 'X', '2026-01-03', 'euthanized', 'weight loss'),
    m('b', 'X', '2026-01-05', 'removed'),
    m('c', 'X', '2026-01-08', 'found dead'),
    m('d', 'X'),
    m('e', 'Y', '2026-01-10', 'euthanized', 'end of study'),
  ];
  const [x, y] = survival(mice, ['X', 'Y'], ['2026-01-01', '2026-01-10']);
  assert.deepEqual(x.points.map(p => [p.date, p.atRisk, p.events]),
    [['2026-01-01', 4, 0], ['2026-01-03', 4, 1], ['2026-01-05', 3, 0], ['2026-01-08', 2, 1], ['2026-01-10', 1, 0]]);
  close(x.points[1].s, 3 / 4);
  close(x.points[3].s, (3 / 4) * (1 / 2));
  assert.deepEqual(y.points.map(p => p.s), [1, 1]);
});

test('demo workbook: read with SheetJS', () => {
  const sheets = readWorkbookSheets(XLSX, fs.readFileSync(path.join(__dirname, 'demo', 'synthetic-demo.xlsx')));
  assert.match(sheets.About[0][0], /SYNTHETIC/);
  const p = parseWorkbook(sheets);
  assert.deepEqual(p.warnings, []);
  assert.deepEqual(p.sessions.map(s => s.date), ['2026-01-05', '2026-01-08', '2026-01-12', '2026-01-15', '2026-01-19']);
  const d = derive(p);
  assert.deepEqual(d.cages, ['11', '12', '13']);
  assert.equal(d.mice.length, 12);
  assert.equal(d.mice.filter(m => m.points.some(x => x.moved)).length, 12, 'every mouse was rehoused on 2026-01-12');
  assert.deepEqual(d.latest.filter(r => r.flags.includes('ended')).map(r => r.id).sort(), ['D107', 'D112']);
  const g = applyGroups(d, studyGrouping(d));
  assert.deepEqual(g.cages, ['Vehicle', 'Treated']);
  const cage12 = d.mice.filter(m => m.cage === '12').map(m => m.group);
  assert.deepEqual([...new Set(cage12)].sort(), ['Treated', 'Vehicle'], 'cage 12 holds both groups');
});

test('workbook: Groups sheet treatment start, days from start and values from start', () => {
  const xl = iso => (Date.UTC(...iso.split('-').map((v, i) => (i === 1 ? v - 1 : +v))) - Date.UTC(1899, 11, 30)) / 86400000;
  const row = (id, date, w, l = null, b = null) => [id, xl(date), w, l, b];
  const sheets = {
    Measurements: [
      ['Animal ID', 'Date', 'Weight (g)', 'Tumor Length', 'Tumor Breadth'],
      row('A1', '2026-01-01', 20, 2, 1), row('A1', '2026-01-03', 22, 2, 2), row('A1', '2026-01-05', null, 4, 2), row('A1', '2026-01-07', 24.2, 4, 4),
      row('A2', '2026-01-01', 20), row('A2', '2026-01-03', null), row('A2', '2026-01-05', 19),
      row('B1', '2026-01-01', 20), row('B1', '2026-01-03', 20), row('B1', '2026-01-05', 20), row('B1', '2026-01-07', 22),
      row('C1', '2026-01-01', 20), row('C1', '2026-01-07', 20),
      row('D1', '2026-01-01', 20), row('D1', '2026-01-07', 20),
    ],
    Mice: [
      ['Animal ID', 'Group', 'Status', 'End date', 'End reason'],
      ['A1', 'Drug', 'alive'], ['A2', 'Drug', 'euthanized', xl('2026-01-05'), 'weight loss'], ['B1', 'vehicle', 'alive'],
      ['C1', null, 'alive'], ['D1', 'Late', 'alive'],
    ],
    Groups: [
      ['Group', 'Color', 'Mice', 'Drugs', null, 'Available colors', null, 'Treatment start'],
      ['Drug', 'Blue', 2, 'X', null, 'Orange', null, xl('2026-01-03')],
      ['Vehicle', 'Gray', 1, 'PBS', null, 'Green', null, '2026-01-05'], // text date; the Mice sheet's case differs
      ['Late', 'Red', 1, null, null, 'Red', null, null],
      [null, null, null, null, null, 'Purple', null, null], // helper column only: silent
      ['Other', null, 0, null, null, null, null, 'soon'],
    ],
    Injections: [
      ['Animal ID', 'Date', 'Drug'],
      ['A1', xl('2026-01-03'), 'X'], ['A2', xl('2026-01-03'), 'X'], ['B1', xl('2026-01-05'), 'PBS'], ['A1', xl('2026-01-05'), 'X'],
    ],
  };
  const p = parseWorkbook(sheets);
  assert.deepEqual(p.groups, [
    { group: 'Drug', start: '2026-01-03' }, { group: 'Vehicle', start: '2026-01-05' }, { group: 'Late', start: null }, { group: 'Other', start: null },
  ]);
  assert.deepEqual(p.warnings.map(w => w.where), ['Groups row 6', 'Groups']);
  assert.match(p.warnings[1].message, /No treatment start for Late;/);
  assert.deepEqual(parseWorkbook({ Measurements: sheets.Measurements, Mice: sheets.Mice }).groups, [], 'no Groups sheet');
  assert.equal(derive(parseWorkbook({ Measurements: sheets.Measurements })).hasStarts, false);

  const d = derive(p);
  const byId = id => d.mice.find(m => m.id === id);
  assert.equal(d.hasStarts, true);
  assert.deepEqual(['A1', 'A2', 'B1', 'C1', 'D1'].map(id => byId(id).start), ['2026-01-03', '2026-01-03', '2026-01-05', null, null]);
  assert.deepEqual(byId('A1').points.map(x => x.tday), [-2, 0, 2, 4]);
  assert.deepEqual(byId('B1').points.map(x => x.tday), [-4, -2, 0, 2]);
  assert.deepEqual(byId('C1').points.map(x => x.tday), [null, null, null, null]);
  const a1 = byId('A1').points[3];
  close(a1.pct, 21); // from the first weight, 20
  close(a1.pctStart, 10); // from 22, weighed on the start day
  close(a1.rtv, 32); // 32 ÷ the first volume, 1
  close(a1.rtvStart, 8); // 32 ÷ 4, the volume on the start day
  close(byId('A2').points[2].pctStart, -5, 1e-9); // not weighed on the start day: from the weight before it, 20
  assert.equal(byId('C1').points[3].pctStart, null);
  const latest = Object.fromEntries(d.latest.map(r => [r.id, r]));
  assert.deepEqual(['A1', 'B1', 'C1'].map(id => latest[id].tday), [4, 2, null]);

  // From treatment start: values swapped in, flags and the original left alone.
  const r = rebase(d);
  assert.equal(r.rebased, true);
  close(r.latest.find(x => x.id === 'A1').pct, 10);
  assert.equal(r.latest.find(x => x.id === 'C1').pct, null);
  assert.deepEqual(r.latest.map(x => x.flags), d.latest.map(x => x.flags));
  close(latest.A1.pct, 21);
  const g = applyGroups(r, studyGrouping(r));
  assert.deepEqual(g.cages, ['Drug', 'vehicle', 'Late', UNGROUPED]);
  close(g.groups.find(x => x.cage === 'Drug').pct[3].mean, 10);

  // Group means by date count a mouse from its baseline session before its start (a group's start counts too):
  // A1 from 01-03 (weighed on its start day), A2 from 01-01 (its last weight before the start), B1 from 01-05.
  const byDate = applyGroups(d, studyGrouping(d)).groups;
  const ns = (cage, metric) => byDate.find(x => x.cage === cage)[metric].map(x => x.n);
  assert.deepEqual(ns('Drug', 'weight'), [1, 1, 1, 1]);
  assert.deepEqual(ns('Drug', 'volume'), [0, 1, 1, 1], 'A1 not yet enrolled on 01-01');
  assert.deepEqual(ns('vehicle', 'weight'), [0, 0, 1, 1]);
  assert.equal(byDate.find(x => x.cage === 'vehicle').weight[0].mean, null);
  assert.deepEqual(ns('Late', 'weight'), [1, 0, 0, 1], 'no start: counted throughout');

  // Means by day from start: a cage mixing two starts gets a point per day of either; days before each baseline are left out.
  const mixed = summarizeByTreatDay([byId('A1'), byId('B1'), byId('C1')], 'weight');
  assert.deepEqual(mixed.map(b => [b.day, b.n, b.dates]), [
    [0, 2, ['2026-01-03', '2026-01-05']], [2, 1, ['2026-01-07']], [4, 1, ['2026-01-07']],
  ]);
  close(mixed[0].mean, 21);

  // Survival from start: A2's endpoint is on day 2 of treatment, A1 is censored on day 4.
  const [drug, vehicle, late] = survivalFromStart(g.mice, g.cages, d.latestDate);
  assert.deepEqual(drug.points.map(x => [x.day, x.s, x.atRisk, x.events]), [[0, 1, 2, 0], [2, 0.5, 2, 1], [4, 0.5, 1, 0]]);
  assert.deepEqual(vehicle.points.map(x => [x.day, x.s, x.atRisk]), [[0, 1, 1], [2, 1, 1]]);
  assert.equal(late.n, 0);

  // Doses by day from each mouse's start.
  const doses = dosesByTreatDay(g.mice, g.cages);
  assert.deepEqual(doses[0].doses.map(z => [z.day, z.dates, z.eligible, z.items.map(i => i.mice.join('+'))]),
    [[0, ['2026-01-03'], 2, ['A1+A2']], [2, ['2026-01-05'], 2, ['A1']]]);
  assert.deepEqual(doses[1].doses.map(z => [z.day, z.items[0].drug]), [[0, 'PBS']]);
  assert.deepEqual(doses[2].doses, []);
});

test('workbook: staggered starts, Regimens schedule, measurement cadence, binning and planned doses', () => {
  const xl = iso => (Date.UTC(...iso.split('-').map((v, i) => (i === 1 ? v - 1 : +v))) - Date.UTC(1899, 11, 30)) / 86400000;
  const every = ['2026-02-01', '2026-02-03', '2026-02-05', '2026-02-07', '2026-02-09'];
  const meas = (id, dates, w = () => 20) => dates.map(date => [id, xl(date), w(date)]);
  const sheets = {
    Measurements: [
      ['Animal ID', 'Date', 'Weight (g)'],
      ...meas('S1', [...every, '2026-02-02'], date => (date === '2026-02-02' ? 99 : 20)), // an extra session: one value per mouse per step
      ...meas('S2', every), ...meas('S3', every.slice(0, 4)), ...meas('S4', ['2026-02-09']), ...meas('U1', every), ...meas('G1', every),
    ],
    Mice: [
      ['Animal ID', 'Group', 'Status', 'End date', 'End reason', 'Treatment start', 'Start used'],
      ['S1', 'Drug', 'alive', null, null, xl('2026-02-01'), xl('2026-02-01')],
      ['S2', 'Drug', 'alive', null, null, '2026-02-02'],
      ['S3', 'Drug', 'euthanized', xl('2026-02-07'), 'tumor volume', xl('2026-02-04')],
      ['S4', 'Drug', 'alive', null, null, xl('2026-02-08')],
      ['U1', 'Drug', 'alive'], // not enrolled yet
      ['G1', 'Ctrl', 'alive', null, null, null, xl('2026-02-03')], // the group's start
    ],
    Groups: [
      ['Group', 'Treatment start', null, 'Measure every (days)', 2],
      ['Drug', null, null, 'Measure from', xl('2026-02-01')],
      ['Ctrl', xl('2026-02-03')],
      [null, null, null, 'Measure every 2 days from the date above; change it if you skip a day.'],
    ],
    Regimens: [
      ['Group', 'Drug', 'Dose', 'Volume (µL)', 'Route', 'Days', null, 'Drug list'],
      ['Drug', 'X', '1 mg', 100, 'IP', '0, 2', null, 'PBS'],
      ['Drug', 'Y', '', 50, 'IV', 4, null, 'W'],
      ['Ctrl', 'PBS', '', 100, 'IP', '0'],
      ['Ctrl', 'Z', '', null, null, null], // not scheduled
      ['Drug', 'W', '', null, null, '1 3'],
      [null, null, null, null, null, null, null, 'X'], // helper column only: silent
    ],
    Injections: [
      ['Animal ID', 'Date', 'Drug'],
      ['S1', xl('2026-02-01'), 'X'], ['S1', xl('2026-02-03'), 'x'], ['S1', xl('2026-02-05'), 'Y'],
      ['S2', xl('2026-02-02'), 'X'], ['S2', xl('2026-02-05'), 'X'], ['S3', xl('2026-02-04'), 'X'],
      ['U1', xl('2026-02-03'), 'X'], ['G1', xl('2026-02-03'), 'PBS'], ['G1', xl('2026-02-05'), 'Z'],
    ],
    // Sheets the workbook keeps for Excel; none of them may be read as one of the app's sheets.
    Checklist: [['Date:', xl('2026-02-09'), null, 'Measure day'], [], ['Animal ID', 'Group', 'Cage ID', '#', 'Weight', 'L', 'B', 'Inj', 'Notes'], ['S1', 'Drug', 1, 1]],
    Plan: [['From:', xl('2026-02-09')], [], ['Animal ID', 'Group', 'Cage ID', '#', xl('2026-02-09'), xl('2026-02-10')], ['S1', 'Drug', 1, 1, null, 'X']],
  };
  const p = parseWorkbook(sheets);
  assert.deepEqual(p.warnings.map(w => [w.where, w.message]), [['Regimens row 6', 'Drug, W: day "1 3" is not a whole number; ignored (separate days with commas).']]);
  assert.deepEqual(p.mice.map(m => m.start), ['2026-02-01', '2026-02-02', '2026-02-04', '2026-02-08', null, null]);
  assert.deepEqual(p.regimens.map(r => [r.group, r.drug, r.days]), [['Drug', 'X', [0, 2]], ['Drug', 'Y', [4]], ['Ctrl', 'PBS', [0]], ['Ctrl', 'Z', []], ['Drug', 'W', []]]);
  assert.deepEqual(p.regimens[0], { group: 'Drug', drug: 'X', dose: '1 mg', volume: '100', route: 'IP', days: [0, 2] });
  assert.deepEqual(p.cadence, { every: 2, from: '2026-02-01' });
  assert.equal(p.groups.length, 2, 'Drug has no group start, but its mice have their own: no warning');

  // Excel's Checklist and Plan test a day k with SEARCH(","&k&",", ","&SUBSTITUTE(Days," ","")&","): same days as the app.
  for (const row of sheets.Regimens.slice(1, 4)) {
    const parsed = p.regimens.find(r => r.drug === row[1]).days;
    for (let k = -3; k <= 10; k++) assert.equal(`,${String(row[5]).replace(/ /g, '')},`.includes(`,${k},`), parsed.includes(k), `${row[1]} day ${k}`);
  }

  const d = derive(p, { today: '2026-02-10' });
  const byId = id => d.mice.find(m => m.id === id);
  assert.equal(d.cutoff, '2026-02-09');
  assert.equal(d.today, '2026-02-10');
  assert.equal(d.hasSchedule, true);
  assert.deepEqual(['S1', 'S2', 'U1', 'G1'].map(id => byId(id).start), ['2026-02-01', '2026-02-02', null, '2026-02-03']);
  assert.deepEqual(['S1', 'G1'].map(id => byId(id).ownStart), ['2026-02-01', null]);
  const plan = id => byId(id).planned.map(x => `${x.date} ${x.drug} ${x.status}`);
  assert.deepEqual(plan('S1'), ['2026-02-01 X given', '2026-02-03 X given', '2026-02-05 Y given']);
  assert.deepEqual(plan('S2'), ['2026-02-02 X given', '2026-02-04 X missed', '2026-02-06 Y missed']);
  assert.deepEqual(plan('S3'), ['2026-02-04 X given', '2026-02-06 X missed'], 'nothing planned after the end date');
  assert.deepEqual(plan('S4'), ['2026-02-08 X missed', '2026-02-10 X planned', '2026-02-12 Y planned']);
  assert.deepEqual(plan('U1'), []);
  assert.deepEqual(plan('G1'), ['2026-02-03 PBS given']);
  assert.deepEqual(byId('S2').offSchedule.map(i => [i.date, i.drug, i.day, i.reason]), [['2026-02-05', 'X', 3, 'not-planned']]);
  assert.deepEqual(byId('U1').offSchedule.map(i => [i.date, i.reason]), [['2026-02-03', 'no-start']]);
  assert.deepEqual(byId('G1').offSchedule, [], 'an unscheduled drug is never off schedule');
  assert.deepEqual(byId('S1').offSchedule, []);

  // Means by day from start in 2-day steps: one value per mouse per step, the nearest to the step's day.
  const grouped = applyGroups(d, studyGrouping(d));
  const drug = grouped.mice.filter(m => m.cage === 'Drug');
  assert.deepEqual(drug.map(m => m.id).sort(), ['S1', 'S2', 'S3', 'S4', 'U1']);
  const binned = summarizeByTreatDay(drug, 'weight', 2);
  assert.deepEqual(binned.filter(b => b.n).map(b => [b.day, b.n, b.tdays]), [
    [0, 3, [-1, 0]], [2, 4, [1, 2]], [4, 3, [3, 4]], [6, 2, [5, 6]], [8, 2, [7, 8]],
  ]); // S3's day −3 is before its baseline (day −1); S2's day −1 is its baseline, so kept
  assert.equal(binned.find(b => b.day === 2).mean, 20, 'S1 counts with day 2, not its extra day-1 weight');
  assert.equal(summarizeByTreatDay(drug, 'weight').filter(b => b.n).length, 10, 'exact days by default: −1 and 0 to 8');
  // By date, a staggered mouse joins the group mean at its baseline session; U1 (no start) counts throughout.
  assert.deepEqual(grouped.groups.find(x => x.cage === 'Drug').weight.map(x => [x.date, x.n]), [
    ['2026-02-01', 3], ['2026-02-02', 1], ['2026-02-03', 4], ['2026-02-05', 4], ['2026-02-07', 4], ['2026-02-09', 4],
  ]);

  // Mice not yet enrolled, or enrolled after a day, are not expected to have had that dose.
  const [drugDoses] = dosesByKey(drug, ['Drug']).map(l => l.doses);
  const on = date => drugDoses.find(z => z.date === date);
  assert.deepEqual([on('2026-02-02').eligible, on('2026-02-02').items[0].eligible, on('2026-02-02').items[0].mice], [2, 1, ['S2']]);
  assert.deepEqual([on('2026-02-03').eligible, on('2026-02-03').items.map(i => [i.drug, i.mice.length, i.eligible])], [2, [['x', 1, 1], ['X', 1, 2]]]);
  const [treat] = dosesByTreatDay(drug, ['Drug'], d.cutoff).map(l => l.doses);
  assert.deepEqual(treat.map(z => [z.day, z.eligible, z.items.map(i => `${i.drug} ${i.mice.length}/${i.eligible}`)]), [
    [0, 4, ['X 3/4']], [2, 3, ['x 1/3']], [3, 3, ['X 1/1']], [4, 2, ['Y 1/2']], // day 3 is off schedule: nobody else was due
  ]);

  // The dose strip: one lane per group and drug, in Regimens order (case ignored), each with only its drug's doses.
  assert.deepEqual(d.drugs, ['X', 'Y', 'PBS', 'Z', 'W']);
  const split = splitByDrug(dosesByTreatDay(drug, ['Drug'], d.cutoff), d.drugs);
  assert.deepEqual(split.map(l => [l.key, l.drug, l.doses.map(z => `${z.day}:${z.items.map(i => i.drug).join('+')}`)]), [
    ['Drug', 'X', ['0:X', '2:x', '3:X']], ['Drug', 'Y', ['4:Y']],
  ]);
  assert.equal(split[0].doses[0].eligible, 4, 'a split lane keeps the day\'s eligible count');
  assert.deepEqual(splitByDrug([{ key: 'A', doses: [{ day: 0, items: [{ drug: 'Q', mice: [] }, { drug: 'Y', mice: [] }] }] }], d.drugs)
    .map(l => l.drug), ['Y', 'Q'], 'a drug not in Regimens comes after');

  // Measurement days and the calendar's planned and missed doses.
  assert.deepEqual(measureDates(d.cadence, d.latestDate, '2026-02-10', '2026-02-16'), ['2026-02-11', '2026-02-13', '2026-02-15']);
  assert.deepEqual(measureDates({ every: 3, from: null }, '2026-02-09', '2026-02-10', '2026-02-16'), ['2026-02-12', '2026-02-15']);
  assert.deepEqual(measureDates(null, '2026-02-09', '2026-02-10', '2026-02-16'), []);
  const cells = doseCalendar(drug, ['Drug'], d.dates, { measure: measureDates(d.cadence, d.latestDate, '2026-02-01', '2026-02-14') })
    .flatMap(mo => mo.weeks.flat()).filter(Boolean);
  const cell = date => cells.find(c => c.date === date);
  assert.deepEqual(cell('2026-02-06').plans.map(x => `${x.drug} ${x.status} ${x.mice.join('+')}`), ['Y missed S2', 'X missed S3']);
  assert.deepEqual(cell('2026-02-12').plans.map(x => `${x.drug} ${x.status} ${x.n}`), ['Y planned 1']);
  assert.deepEqual(cells.filter(c => c.toMeasure).map(c => c.date), ['2026-02-11', '2026-02-13']);
  assert.equal(cell('2026-02-13').inRange, true, 'the span reaches the upcoming measurement days');
  assert.equal(cell('2026-02-09').toMeasure, false, 'a past session is measured, not to measure');

  // Coming up: planned doses not yet given, and measurement days.
  const up = upcomingWork(drug, ['Drug'], '2026-02-10', 3, measureDates(d.cadence, d.latestDate, '2026-02-10', '2026-02-12'));
  assert.deepEqual(up.map(u => [u.date, u.measure, u.doses.map(x => `${x.drug} ${x.mice.join('+')}`)]), [
    ['2026-02-10', false, ['X S4']], ['2026-02-11', true, []], ['2026-02-12', false, ['Y S4']],
  ]);

  // Problems with a mouse's own start.
  const bad = parseWorkbook({
    Measurements: sheets.Measurements,
    Mice: [['Animal ID', 'Group', 'Status', 'End date', 'Treatment start'], ['S1', 'Drug', 'alive', null, 'soon'], ['S2', 'Drug', 'removed', xl('2026-02-03'), xl('2026-02-05')]],
    Groups: [['Group', 'Treatment start', 'Measure every', 'often']],
  });
  assert.deepEqual(bad.warnings.filter(w => /^(Mice|Groups) row/.test(w.where)).map(w => w.message), [
    'Mouse S1: treatment start "soon" is not a date (use YYYY-MM-DD).',
    'Mouse S2: treatment start 2026-02-05 is after its end date 2026-02-03.',
    'Measure every "often" is not a whole number of days; no measurement schedule.',
  ]);
  assert.equal(bad.cadence, null);
  assert.deepEqual(derive(parseWorkbook({ Measurements: sheets.Measurements })).hasSchedule, false);
});

test('dashboard grid: every card gives the full layout; hidden cards leave no gap', () => {
  const all = [...CHART_IDS];
  assert.deepEqual(gridTemplate(2, all), {
    areas: '"wg wi" "wl wl" "tg ti" "tl tl" "surv surv"',
    rows: 'var(--row-h) var(--row-h) var(--row-h) var(--row-h) var(--row-h)',
    fit: 2,
  });
  assert.equal(gridTemplate(6, all).areas, '"wg wg wi wi wl wl" "tg tg ti ti tl tl" "surv surv surv surv surv surv"');
  const shown = all.filter(id => !HIDDEN_VIEWS.includes(id));
  assert.deepEqual(gridTemplate(2, shown), {
    areas: '"wg wi" "tg ti" "surv surv"',
    rows: 'var(--row-h) var(--row-h) var(--row-h)',
    fit: 2,
  });
  assert.equal(gridTemplate(6, shown).areas, '"wg wg wg wi wi wi" "tg tg tg ti ti ti" "surv surv surv surv surv surv"');
  // One card left in a row takes the whole row.
  assert.equal(gridTemplate(6, ['weight-mice', 'survival']).areas, '"wi wi wi wi wi wi" "surv surv surv surv surv surv"');
  // The Injections tab's cards are not in the grid areas: they span the full width (style.css).
  assert.deepEqual(gridTemplate(2, ['schedule', 'dose-calendar', 'doses']), { areas: 'none', rows: 'none', fit: 1 });
  // A single chart row fills the screen height.
  assert.equal(gridTemplate(2, ['tumor-group', 'tumor-mice']).fit, 1);
  assert.equal(gridTemplate(6, ['weight-group', 'tumor-group']).fit, 2);
});
