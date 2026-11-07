// Tests for the pure part of app.js. Run: node --test
// Only synthetic data here. Checks against the real note live in private/ (gitignored).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseNote, derive, summarize, tumorVolume, cleanGrouping, applyGroups, distribute, groupLabel, UNGROUPED } = require('./app.js');

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
