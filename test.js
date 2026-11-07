// Tests for the pure part of app.js. Run: node --test
// Only synthetic data here. Checks against the real note live in private/ (gitignored).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  parseNote, parseWorkbook, readWorkbookSheets, derive, summarize, tumorVolume, cleanGrouping, applyGroups, distribute, groupLabel,
  studyGrouping, survival, UNGROUPED,
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
  assert.ok(p.warnings.some(w => w.where === 'Mice' && /A4, A5/.test(w.message)), 'measured mice missing from the Mice sheet');
  assert.ok(p.warnings.some(w => /A7 is gone but has no end date/.test(w.message)));
  assert.deepEqual(parseWorkbook({ Sheet1: [['a', 'b']] }).sessions, []);
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
