// In-vivo plots. Spec: PLAN.md.
// Pipeline: note text -> parseNote -> derive -> render. parseNote and derive are pure
// (no DOM, no globals) so they can be tested in Node: `node --test`.
'use strict';

/* ------------------------------------------------------------------ parse */

// Column header (lowercased, letters and digits only) -> row field.
const COLUMNS = {
  cageno: 'cage',
  mouseno: 'mouse',
  bodyweightg: 'weight',
  tumorlength: 'length',
  tumorbreadth: 'breadth',
};
const REQUIRED = ['cage', 'mouse', 'weight', 'length', 'breadth'];
const NUMBER = /^(\d+(\.\d*)?|\.\d+)$/;
const ID = /^[A-Za-z0-9]+$/;

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map(c => c.trim());
}

const isSeparator = line => /^\|?(\s*:?-+:?\s*\|)*\s*:?-+:?\s*\|?$/.test(line.trim());

function isValidDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/**
 * Parse an experiment note.
 * Returns { sessions: [{ date, rows: [{ cage, mouse, weight, length, breadth }] }], warnings: [{ line, message }] }.
 * Sessions are sorted by date. cage and mouse are strings; measurements are numbers or null (not measured).
 */
function parseNote(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const warnings = [];
  const warn = (i, message) => warnings.push({ line: i + 1, message });
  const byDate = new Map();
  let i = 0;

  // Frontmatter
  if (lines[0] !== undefined && lines[0].trim() === '---') {
    const end = lines.findIndex((l, k) => k > 0 && /^(---|\.\.\.)\s*$/.test(l));
    if (end > 0) i = end + 1;
    else warn(0, 'Frontmatter starts with --- but is never closed; reading the whole note.');
  }

  let cur = null;
  while (i < lines.length) {
    const line = lines[i];
    const h = /^##\s+(\d{4}-\d{2}-\d{2})/.exec(line);
    if (h) {
      const date = h[1];
      if (!isValidDate(date)) {
        warn(i, `"${date}" is not a real date; section skipped.`);
        cur = null;
      } else {
        if (byDate.has(date)) warn(i, `Date ${date} appears more than once; the sections are combined.`);
        cur = byDate.get(date) || { date, rows: [], line: i, ids: new Set(), hasTable: false };
        byDate.set(date, cur);
      }
      i++;
      continue;
    }
    // Any other level-1 or level-2 heading ends the current session.
    if (/^#{1,2}\s/.test(line)) { cur = null; i++; continue; }

    if (cur && line.trim().startsWith('|')) {
      const start = i;
      const block = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) block.push(lines[i++]);
      parseTable(block, start, cur, warn);
      continue;
    }
    i++;
  }

  const sessions = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const s of sessions) {
    if (!s.hasTable) warn(s.line, `Session ${s.date} has no table with the columns Cage No., Mouse No., Body Weight (g), Tumor Length, Tumor Breadth.`);
  }
  warnings.sort((a, b) => a.line - b.line);
  return { sessions: sessions.map(s => ({ date: s.date, rows: s.rows })), warnings };
}

function parseTable(block, start, session, warn) {
  const header = splitRow(block[0]);
  const idx = {};
  header.forEach((name, k) => {
    const field = COLUMNS[name.toLowerCase().replace(/[^a-z0-9]/g, '')];
    if (field && idx[field] === undefined) idx[field] = k;
  });
  if (!REQUIRED.every(f => idx[f] !== undefined)) return; // some other table: ignore
  session.hasTable = true;

  for (let r = 1; r < block.length; r++) {
    const line = block[r];
    const ln = start + r;
    if (isSeparator(line)) continue;
    const cells = splitRow(line);
    const get = f => cells[idx[f]] ?? '';
    if (cells.every(c => c === '')) continue; // blank template row

    const cage = get('cage');
    const mouse = get('mouse');
    if (!ID.test(cage) || !ID.test(mouse)) {
      warn(ln, `${session.date}: row skipped, cage "${cage}" / mouse "${mouse}" is missing or not a plain number.`);
      continue;
    }
    const id = `${cage}-${mouse}`;
    if (session.ids.has(id)) {
      warn(ln, `${session.date}: mouse ${id} is listed twice; the later row is ignored.`);
      continue;
    }
    session.ids.add(id);

    const row = { cage, mouse };
    for (const f of ['weight', 'length', 'breadth']) {
      const v = get(f);
      if (v === '') row[f] = null;
      else if (NUMBER.test(v)) row[f] = Number(v);
      else {
        row[f] = null;
        warn(ln, `${session.date}: mouse ${id}, ${f} "${v}" is not a number; treated as not measured.`);
      }
    }
    if ((row.length === null) !== (row.breadth === null)) {
      warn(ln, `${session.date}: mouse ${id} has only one tumor side; no volume.`);
    }
    session.rows.push(row);
  }
}

/* --------------------------------------------------------- parse a workbook */
// The study workbook (.xlsx) has a Measurements sheet, one row per mouse per session as written on the
// day's sheet (cage, tail mark) plus the mouse's ID, and an optional Mice sheet, one row per mouse
// (group, status, end date). Sheets arrive as arrays of rows of raw cell values (SheetJS sheet_to_json
// with header: 1), so this part runs in Node without SheetJS.

const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const MEASURE_COLUMNS = {
  date: 'date', cage: 'cage', cageno: 'cage', cageid: 'cage', tailmark: 'mark', tail: 'mark', mouseno: 'mark',
  mouseid: 'id', animalid: 'id',
  weightg: 'weight', bodyweightg: 'weight', bodyweight: 'weight', weight: 'weight',
  tumorlength: 'length', tumorbreadth: 'breadth', notes: 'note', note: 'note',
};
// `Treatment start` on Mice is the mouse's own start (staggered enrollment); blank means its group's start.
// A helper column such as `Start used` (an Excel formula) is not matched, so it is ignored.
const MICE_COLUMNS = {
  mouseid: 'id', animalid: 'id', sex: 'sex', group: 'group', status: 'status', enddate: 'endDate', endreason: 'endReason', notes: 'notes', note: 'notes',
  treatmentstart: 'start', treatmentstartdate: 'start', startdate: 'start',
};
// The Regimens sheet: one line per drug a group gets, with `Days` (from each mouse's treatment start) to dose on.
const REGIMEN_COLUMNS = {
  group: 'group', drug: 'drug', treatment: 'drug', dose: 'dose', volumel: 'volume', volumeul: 'volume', volume: 'volume', route: 'route',
  days: 'days', daysfromstart: 'days', schedule: 'days',
};
// Labels of the measurement cadence cells on the Groups sheet; the value is the next filled cell to the right.
const CADENCE_LABELS = { measureevery: 'every', measureeverydays: 'every', measurefrom: 'from' };
// `Volume (µL)` normalizes to `volumel` (µ is dropped). Group, Cage and Tail mark are ignored: a mouse's group comes from Mice.
const INJECTION_COLUMNS = {
  date: 'date', mouseid: 'id', animalid: 'id', drug: 'drug', treatment: 'drug', dose: 'dose',
  volumel: 'volume', volumeul: 'volume', volume: 'volume', route: 'route', notes: 'note', note: 'note',
};
// The Groups sheet: one row per group. Only the treatment start is read; Color, Mice, Drugs and the rest are ignored.
const GROUP_COLUMNS = { group: 'group', treatmentstart: 'treat', treatmentstartdate: 'treat', startdate: 'treat', start: 'treat' };
const STATUSES = ['alive', 'euthanized', 'found dead', 'removed'];
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

const cellText = v => (v === null || v === undefined ? '' : String(v).trim());

/** A date cell (Excel serial number, Date or "YYYY-MM-DD" text) as ISO, or null. */
function cellDate(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(EXCEL_EPOCH + Math.round(v) * DAY).toISOString().slice(0, 10);
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(cellText(v));
  if (!m) return null;
  const iso = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return isValidDate(iso) ? iso : null;
}

/** The header row (first non-empty row) of a sheet, mapped to fields. */
function readSheet(rows, map) {
  const start = rows.findIndex(r => Array.isArray(r) && r.some(c => cellText(c) !== ''));
  if (start < 0) return null;
  const idx = {};
  rows[start].forEach((name, k) => {
    const f = map[norm(name)];
    if (f && idx[f] === undefined) idx[f] = k;
  });
  return { idx, start, rows };
}

/** The sheet named like `nameRe` whose header has the `required` fields, else the first sheet that has them. */
function pickSheet(sheets, nameRe, map, required) {
  const names = Object.keys(sheets);
  const fits = n => {
    const s = readSheet(sheets[n] || [], map);
    return s && required.every(f => s.idx[f] !== undefined) ? { name: n, ...s } : null;
  };
  for (const n of names.filter(x => nameRe.test(x.trim()))) { const s = fits(n); if (s) return s; }
  for (const n of names) { const s = fits(n); if (s) return s; }
  return null;
}

/**
 * Parse a study workbook given as { sheetName: rows }.
 * Returns { sessions: [{ date, rows: [{ id, cage, mark, weight, length, breadth, note? }] }],
 *           mice: [{ id, sex, group, status, endDate, endReason, notes }],
 *           injections: [{ id, date, drug, dose, volume, route, note? }], groups: [{ group, start }],
 *           warnings: [{ where, message }] }.
 */
function parseWorkbook(sheets) {
  const warnings = [];
  const warn = (where, message) => warnings.push({ where, message });
  const meas = pickSheet(sheets, /^measurements?$/i, MEASURE_COLUMNS, ['date', 'id']);
  if (!meas) {
    warn('Workbook', 'No Measurements sheet: it needs a header row with at least Date and Mouse ID columns.');
    return { sessions: [], mice: [], injections: [], groups: [], regimens: [], cadence: null, warnings };
  }

  const roster = [];
  const rosterById = new Map();
  const miceSheet = pickSheet(sheets, /^mice$/i, MICE_COLUMNS, ['id', 'status']);
  if (miceSheet && miceSheet.name !== meas.name) {
    const { idx, start, rows, name } = miceSheet;
    for (let r = start + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      if (!row.some(c => cellText(c) !== '')) continue;
      const get = f => (idx[f] === undefined ? '' : row[idx[f]]);
      const where = `${name} row ${r + 1}`;
      const id = cellText(get('id'));
      if (!id) { warn(where, 'No Mouse ID; row skipped.'); continue; }
      if (rosterById.has(id)) { warn(where, `Mouse ${id} is listed twice; the later row is ignored.`); continue; }
      const status = cellText(get('status')).toLowerCase();
      if (status && !STATUSES.includes(status)) warn(where, `Mouse ${id}: status "${status}" is not one of ${STATUSES.join(', ')}; treated as ended.`);
      let endDate = null;
      if (cellText(get('endDate')) !== '') {
        endDate = cellDate(get('endDate'));
        if (!endDate) warn(where, `Mouse ${id}: end date "${cellText(get('endDate'))}" is not a date (use YYYY-MM-DD).`);
      }
      const m = {
        id, sex: cellText(get('sex')), group: cellText(get('group')),
        status: status || (endDate ? 'ended' : 'alive'), endDate, endReason: cellText(get('endReason')), notes: cellText(get('notes')),
      };
      if (m.status !== 'alive' && !endDate) warn(where, `Mouse ${id} is ${m.status} but has no end date; its last measurement is used.`);
      m.start = null;
      if (cellText(get('start')) !== '') {
        m.start = cellDate(get('start'));
        if (!m.start) warn(where, `Mouse ${id}: treatment start "${cellText(get('start'))}" is not a date (use YYYY-MM-DD).`);
        else if (endDate && m.start > endDate) warn(where, `Mouse ${id}: treatment start ${m.start} is after its end date ${endDate}.`);
      }
      roster.push(m);
      rosterById.set(id, m);
    }
  }

  const byDate = new Map();
  const unknown = new Set();
  const { idx, start, rows, name } = meas;
  for (let r = start + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    if (!row.some(c => cellText(c) !== '')) continue;
    const get = f => (idx[f] === undefined ? '' : row[idx[f]]);
    const where = `${name} row ${r + 1}`;
    const date = cellDate(get('date'));
    if (!date) { warn(where, `Date "${cellText(get('date'))}" is not a date (use YYYY-MM-DD); row skipped.`); continue; }
    const id = cellText(get('id'));
    const cage = cellText(get('cage'));
    const mark = cellText(get('mark'));
    if (!id) { warn(where, `${date}: no Mouse ID${cage ? ` for cage ${cage}${mark ? `, tail ${mark}` : ''}` : ''}; row skipped.`); continue; }
    if (!byDate.has(date)) byDate.set(date, { date, rows: [], ids: new Set(), spots: new Map() });
    const s = byDate.get(date);
    if (s.ids.has(id)) { warn(where, `${date}: mouse ${id} is listed twice; the later row is ignored.`); continue; }
    const info = rosterById.get(id);
    if (info && info.endDate && date > info.endDate) { warn(where, `${date}: mouse ${id} ended on ${info.endDate}; this later row is ignored.`); continue; }
    s.ids.add(id);
    if (cage && mark) {
      const spot = `${cage}/${mark}`;
      if (s.spots.has(spot)) warn(where, `${date}: mice ${s.spots.get(spot)} and ${id} are both in cage ${cage}, tail ${mark}.`);
      else s.spots.set(spot, id);
    }
    const out = { id, cage, mark };
    for (const f of ['weight', 'length', 'breadth']) {
      const v = get(f);
      const text = cellText(v);
      if (typeof v === 'number' && Number.isFinite(v)) out[f] = v;
      else if (text === '') out[f] = null;
      else if (NUMBER.test(text)) out[f] = Number(text);
      else {
        out[f] = null;
        warn(where, `${date}: mouse ${id}, ${f} "${text}" is not a number; treated as not measured.`);
      }
    }
    if ((out.length === null) !== (out.breadth === null)) warn(where, `${date}: mouse ${id} has only one tumor side; no volume.`);
    const note = cellText(get('note'));
    if (note) out.note = note;
    s.rows.push(out);
    if (roster.length && !info) unknown.add(id);
  }
  if (unknown.size) warn(miceSheet.name, `Measured but not listed on this sheet: ${[...unknown].sort(byNatural).join(', ')}.`);

  const sessions = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).map(s => ({ date: s.date, rows: s.rows }));
  const measured = new Set(sessions.flatMap(s => s.rows.map(r => r.id)));
  const injections = parseInjections(sheets, [meas.name, miceSheet && miceSheet.name], rosterById, measured, warn);
  const groups = parseGroups(sheets, [meas.name, miceSheet && miceSheet.name], roster, warn);
  const regimens = parseRegimens(sheets, [meas.name, miceSheet && miceSheet.name], warn);
  const cadence = parseCadence(sheets, warn);
  return { sessions, mice: roster, injections, groups, regimens, cadence, warnings };
}

/**
 * The optional Regimens sheet, read when it has Group, Drug and Days columns: [{ group, drug, dose, volume, route, days }]
 * in the sheet's order. `days` are whole days from each mouse's treatment start, written as a comma-separated list
 * (`0` or `2, 4`); empty means the drug is not scheduled. Commas only, so Excel's formulas read the list the same way.
 */
function parseRegimens(sheets, skip, warn) {
  const others = Object.fromEntries(Object.entries(sheets).filter(([n]) => !skip.includes(n)));
  const sheet = pickSheet(others, /^regimens?$/i, REGIMEN_COLUMNS, ['group', 'drug', 'days']);
  if (!sheet) return [];
  const { idx, start, rows, name } = sheet;
  const out = [];
  for (let r = start + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const get = f => (idx[f] === undefined ? '' : cellText(row[idx[f]]));
    const group = get('group');
    const drug = get('drug');
    const raw = get('days');
    if (!group && !drug && !raw) continue;
    const where = `${name} row ${r + 1}`;
    if (!group || !drug) { if (raw) warn(where, `Days "${raw}" need both a group and a drug; ignored.`); continue; }
    const days = [];
    for (const token of raw.split(',').map(s => s.trim()).filter(Boolean)) {
      if (!/^-?\d+$/.test(token)) { warn(where, `${group}, ${drug}: day "${token}" is not a whole number; ignored (separate days with commas).`); continue; }
      const day = Number(token);
      if (Math.abs(day) > 365) {
        warn(where, `${group}, ${drug}: day ${day} looks wrong; ignored. If you typed a list, format the Days column as Text so Excel keeps the commas.`);
        continue;
      }
      if (!days.includes(day)) days.push(day);
    }
    out.push({ group, drug, dose: get('dose'), volume: get('volume'), route: get('route'), days: days.sort((a, b) => a - b) });
  }
  return out;
}

/**
 * The measurement cadence, from labelled cells on the sheet named Groups: `Measure every (days)` and `Measure from`
 * (a date measurements fall on), each value in the next filled cell to the right. Returns { every, from } or null.
 * `from` may be null; measure days are then counted from the latest session.
 */
function parseCadence(sheets, warn) {
  for (const name of Object.keys(sheets).filter(n => /^groups?$/i.test(n.trim()))) {
    const found = {};
    (sheets[name] || []).forEach((row, r) => (row || []).forEach((cell, c) => {
      const key = CADENCE_LABELS[norm(cell)];
      if (!key || found[key]) return;
      const k = row.findIndex((v, j) => j > c && cellText(v) !== '');
      found[key] = { value: k < 0 ? '' : row[k], where: `${name} row ${r + 1}` };
    }));
    if (!found.every) continue;
    const every = Number(cellText(found.every.value));
    if (!Number.isInteger(every) || every < 1) {
      warn(found.every.where, `Measure every "${cellText(found.every.value)}" is not a whole number of days; no measurement schedule.`);
      return null;
    }
    let from = null;
    if (found.from && cellText(found.from.value) !== '') {
      from = cellDate(found.from.value);
      if (!from) warn(found.from.where, `Measure from "${cellText(found.from.value)}" is not a date (use YYYY-MM-DD); counted from the latest session.`);
    }
    return { every, from };
  }
  return null;
}

/**
 * The optional Groups sheet, read only when it has a Group and a Treatment start column: [{ group, start }] in the
 * sheet's order, start as ISO or null when empty. A group on the Mice sheet with no start, and none of whose mice has
 * a start of its own, is reported once.
 */
function parseGroups(sheets, skip, roster, warn) {
  const others = Object.fromEntries(Object.entries(sheets).filter(([n]) => !skip.includes(n)));
  const sheet = pickSheet(others, /^groups?$/i, GROUP_COLUMNS, ['group', 'treat']);
  if (!sheet) return [];
  const { idx, start, rows, name } = sheet;
  const out = [];
  const seen = new Set();
  for (let r = start + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const get = f => (idx[f] === undefined ? '' : row[idx[f]]);
    const group = cellText(get('group'));
    const raw = cellText(get('treat'));
    if (!group && !raw) continue;
    const where = `${name} row ${r + 1}`;
    if (!group) { warn(where, `Treatment start "${raw}" has no group; ignored.`); continue; }
    if (seen.has(group.toLowerCase())) { warn(where, `Group ${group} is listed twice; the later row is ignored.`); continue; }
    seen.add(group.toLowerCase());
    let date = null;
    if (raw) {
      date = cellDate(get('treat'));
      if (!date) warn(where, `Group ${group}: treatment start "${raw}" is not a date (use YYYY-MM-DD).`);
    }
    out.push({ group, start: date });
  }
  // A group with mice of their own start (staggered enrollment) needs none: report only groups where nobody has a start.
  const dated = new Set([...out.filter(g => g.start), ...roster.filter(m => m.start)].map(g => g.group.toLowerCase()));
  const missing = [...new Set(roster.map(m => m.group).filter(g => g && !dated.has(g.toLowerCase())))];
  if (missing.length) {
    warn(name, `No treatment start for ${missing.join(', ')}; ${missing.length > 1 ? 'these groups are' : 'this group is'} left out when plotting from treatment start.`);
  }
  return out;
}

/**
 * The optional Injections sheet: one row per mouse per dose. Returns [{ id, date, drug, dose, volume, route, note }]
 * sorted by date. Rows with no date, mouse and drug are skipped silently (the sheet's formulas fill other columns
 * far down the table).
 */
function parseInjections(sheets, skip, rosterById, measured, warn) {
  const others = Object.fromEntries(Object.entries(sheets).filter(([n]) => !skip.includes(n)));
  const sheet = pickSheet(others, /^(injections?|dosing|doses)$/i, INJECTION_COLUMNS, ['date', 'id', 'drug']);
  if (!sheet) return [];
  const { idx, start, rows, name } = sheet;
  const out = [];
  const seen = new Set();
  const unknown = new Set();
  for (let r = start + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const get = f => (idx[f] === undefined ? '' : row[idx[f]]);
    const id = cellText(get('id'));
    const drug = cellText(get('drug'));
    const rawDate = cellText(get('date'));
    if (!id && !drug && !rawDate) continue;
    const where = `${name} row ${r + 1}`;
    const date = cellDate(get('date'));
    if (!date) { warn(where, `Date "${rawDate}" is not a date (use YYYY-MM-DD); row skipped.`); continue; }
    if (!id) { warn(where, `${date}: no Mouse ID${drug ? ` for ${drug}` : ''}; row skipped.`); continue; }
    if (!drug) { warn(where, `${date}: mouse ${id} has no drug; row skipped.`); continue; }
    const info = rosterById.get(id);
    if (!info && !measured.has(id)) { unknown.add(id); continue; }
    if (info && info.endDate && date > info.endDate) { warn(where, `${date}: mouse ${id} ended on ${info.endDate}; this later injection is ignored.`); continue; }
    const key = `${id}|${date}|${drug.toLowerCase()}`;
    if (seen.has(key)) { warn(where, `${date}: mouse ${id} has ${drug} twice; the later row is ignored.`); continue; }
    seen.add(key);
    const inj = { id, date, drug, dose: cellText(get('dose')), volume: cellText(get('volume')), route: cellText(get('route')) };
    const note = cellText(get('note'));
    if (note) inj.note = note;
    out.push(inj);
  }
  if (unknown.size) warn(name, `Injected but never measured or listed on Mice, so not shown: ${[...unknown].sort(byNatural).join(', ')}.`);
  return out.sort((a, b) => a.date.localeCompare(b.date) || byNatural(a.id, b.id));
}

/** Workbook bytes -> { sheetName: rows } with SheetJS (`lib` is the XLSX global). Row k is spreadsheet row k + 1. */
function readWorkbookSheets(lib, data) {
  const wb = lib.read(data, { type: 'array', cellDates: false });
  const out = {};
  for (const n of wb.SheetNames) {
    const ws = wb.Sheets[n];
    const rows = lib.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true });
    const r0 = ws['!ref'] ? lib.utils.decode_range(ws['!ref']).s.r : 0;
    out[n] = [...Array.from({ length: r0 }, () => []), ...rows];
  }
  return out;
}

/* ----------------------------------------------------------------- derive */

const byNatural = (a, b) => a.localeCompare(b, undefined, { numeric: true });
const DAY = 86400000;
const ts = iso => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const daysBetween = (from, to) => Math.round((ts(to) - ts(from)) / DAY);

/** mean ± SEM (sample SD / √n) over non-null values. sem is null when n < 2; mean is null when n = 0. */
function summarize(values) {
  const v = values.filter(x => x !== null && x !== undefined && Number.isFinite(x));
  const n = v.length;
  if (n === 0) return { mean: null, sem: null, n: 0 };
  const mean = v.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { mean, sem: null, n };
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  return { mean, sem: sd / Math.sqrt(n), n };
}

function tumorVolume(length, breadth) {
  if (length === null || breadth === null) return null;
  const long = Math.max(length, breadth);
  const short = Math.min(length, breadth);
  return (long * short * short) / 2;
}

const LOSS_WARNING = -15;
const LOSS_ALERT = -20;

/**
 * Per-mouse series, weight % change from the first recorded weight, tumor volume and relative tumor
 * volume (÷ the mouse's first measured volume), per-cage mean ± SEM, and latest-session values with flags.
 * days[k] is the study day of session k (days since the first session).
 *
 * A mouse is its Mouse ID (workbook) or `cage-mouse` (note). Its `cage` and `mouse` (tail mark) are where it
 * is now, from its latest row, so the by-cage views put each mouse's whole history under its current cage.
 * Each point keeps the cage and tail mark of that day, and `moved` (the previous place) when they changed.
 * `parsed.mice` (the workbook's Mice sheet) adds group, status and end date; points after the end are empty.
 *
 * A mouse's `start` is its own Treatment start (Mice sheet), else its group's (Groups sheet). Its points then
 * carry `tday` (days from the start, negative before it), `pctStart` (weight % change from the last weight on or
 * before the start) and `rtvStart` (volume ÷ the last volume on or before the start); mice with no start get null.
 *
 * Schedule: each mouse with a start gets `planned`, one dose per Regimens day of its group's drugs (to its end date):
 * { date, day, drug, dose, volume, route, status }, status `given` (an Injections row has that drug that day), `missed`
 * (none, on or before `cutoff`, the later of the last session and the last injection) or `planned` (after the cutoff).
 * `offSchedule` lists its injections of a scheduled drug on a day not planned (`reason: 'not-planned'`), or given
 * before it has a start (`reason: 'no-start'`). The cutoff comes from the data, not the clock, so a remembered file
 * does not grow missed doses. `opts.today` (ISO) is only kept for the views' "coming up" list.
 */
function derive(parsed, opts = {}) {
  const dates = parsed.sessions.map(s => s.date);
  const days = dates.map(date => Math.round((ts(date) - ts(dates[0])) / DAY));
  const dayOf = date => Math.round((ts(date) - ts(dates[0])) / DAY);
  const latestDate = dates[dates.length - 1] ?? null;
  const roster = new Map((parsed.mice || []).map(m => [m.id, m]));
  const startOf = new Map((parsed.groups || []).filter(g => g.start).map(g => [g.group.toLowerCase(), g.start]));
  const miceById = new Map();

  for (const s of parsed.sessions) {
    for (const r of s.rows) {
      const id = r.id ?? `${r.cage}-${r.mouse}`;
      if (!miceById.has(id)) miceById.set(id, { id, byDate: {} });
      miceById.get(id).byDate[s.date] = r;
    }
  }

  const place = r => ({ cage: cellText(r.cage), mark: cellText(r.mark ?? r.mouse) });
  const hasData = r => r && (r.weight !== null || r.length !== null || r.breadth !== null);
  for (const m of miceById.values()) {
    const rowDates = dates.filter(d => m.byDate[d]);
    const now = place(m.byDate[rowDates[rowDates.length - 1]]);
    m.cage = now.cage;
    m.mouse = now.mark;
    const info = roster.get(m.id) || {};
    m.group = info.group || '';
    m.sex = info.sex || '';
    m.status = info.status || 'alive';
    m.endReason = info.endReason || '';
    m.ended = m.status !== 'alive' || Boolean(info.endDate);
    const seen = dates.filter(d => hasData(m.byDate[d]));
    m.endDate = m.ended ? (info.endDate || seen[seen.length - 1] || rowDates[rowDates.length - 1]) : null;
    m.endDay = m.endDate ? dayOf(m.endDate) : null;
    m.ownStart = info.start || null;
    m.start = m.ownStart || (m.group && startOf.get(m.group.toLowerCase())) || null;
  }

  const injectionsOf = new Map();
  for (const inj of parsed.injections || []) {
    if (!injectionsOf.has(inj.id)) injectionsOf.set(inj.id, []);
    injectionsOf.get(inj.id).push(inj);
  }

  const mice = [...miceById.values()].sort((a, b) => byNatural(a.cage, b.cage) || byNatural(a.mouse, b.mouse) || byNatural(a.id, b.id));
  for (const m of mice) {
    const rowAt = date => (m.endDate && date > m.endDate ? null : m.byDate[date] || null);
    const firstWeighed = dates.find(d => rowAt(d) && rowAt(d).weight !== null);
    m.baseline = firstWeighed ? rowAt(firstWeighed).weight : null;
    let prev = null;
    m.points = dates.map((date, k) => {
      const r = rowAt(date);
      const weight = r ? r.weight : null;
      const length = r ? r.length : null;
      const breadth = r ? r.breadth : null;
      const pct = weight !== null && m.baseline ? ((weight - m.baseline) / m.baseline) * 100 : null;
      const p = { date, day: days[k], weight, pct, length, breadth, volume: tumorVolume(length, breadth), cage: null, mark: null };
      if (r) {
        const here = place(r);
        p.cage = here.cage;
        p.mark = here.mark;
        if (prev && here.cage && prev.cage && (here.cage !== prev.cage || here.mark !== prev.mark)) p.moved = prev;
        if (here.cage) prev = here;
        if (r.note) p.note = r.note;
      }
      return p;
    });
    const firstTumor = m.points.find(p => p.volume !== null);
    m.firstVolume = firstTumor ? firstTumor.volume : null;
    for (const p of m.points) p.rtv = p.volume !== null && m.firstVolume ? p.volume / m.firstVolume : null;
    // From the treatment start: the last value on or before it is the baseline.
    const before = m.start ? m.points.filter(p => p.date <= m.start) : [];
    const lastWith = f => [...before].reverse().find(x => x[f] !== null) || null;
    const wBase = lastWith('weight'), vBase = lastWith('volume');
    m.startWeight = wBase ? wBase.weight : null;
    m.startVolume = vBase ? vBase.volume : null;
    // Group means count the mouse from its baseline session (the earlier of its weight and volume baselines), else
    // from its start; mice with no start count throughout.
    const bases = [wBase, vBase].filter(Boolean).map(p => p.date).sort();
    m.inGroupFrom = m.start ? bases[0] || m.start : null;
    for (const p of m.points) {
      p.tday = m.start ? daysBetween(m.start, p.date) : null;
      p.pctStart = p.weight !== null && m.startWeight ? ((p.weight - m.startWeight) / m.startWeight) * 100 : null;
      p.rtvStart = p.volume !== null && m.startVolume ? p.volume / m.startVolume : null;
    }
    const seen = m.points.filter(p => p.weight !== null || p.length !== null || p.breadth !== null);
    m.lastSeen = seen.length ? seen[seen.length - 1].date : null;
    if (m.ended) {
      // The end marker goes on the last point drawn on or before the end date.
      const last = [...m.points].reverse().find(p => p.date <= m.endDate && (p.weight !== null || p.volume !== null));
      if (last) last.end = true;
    }
    delete m.byDate;
    m.injections = injectionsOf.get(m.id) || [];
  }

  // Schedule: planned doses from each mouse's start and its group's Regimens days.
  const lastInjection = (parsed.injections || []).reduce((a, i) => (i.date > a ? i.date : a), '');
  const cutoff = [latestDate || '', lastInjection].sort().pop() || null;
  const regimensOf = new Map();
  for (const r of parsed.regimens || []) {
    if (!r.days || !r.days.length) continue;
    const g = r.group.toLowerCase();
    if (!regimensOf.has(g)) regimensOf.set(g, []);
    regimensOf.get(g).push(r);
  }
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  for (const m of mice) {
    const regs = (m.group && regimensOf.get(m.group.toLowerCase())) || [];
    m.planned = [];
    m.offSchedule = [];
    if (!regs.length) continue;
    if (m.start) {
      const seen = new Set();
      for (const r of regs) {
        for (const day of r.days) {
          const date = addDays(m.start, day);
          const k = `${date}|${r.drug.toLowerCase()}`;
          if ((m.endDate && date > m.endDate) || seen.has(k)) continue;
          seen.add(k);
          const given = m.injections.some(i => i.date === date && same(i.drug, r.drug));
          m.planned.push({ date, day, drug: r.drug, dose: r.dose, volume: r.volume, route: r.route,
            status: given ? 'given' : cutoff && date <= cutoff ? 'missed' : 'planned' });
        }
      }
      m.planned.sort((a, b) => a.date.localeCompare(b.date) || byNatural(a.drug, b.drug));
    }
    const scheduled = regs.map(r => r.drug);
    m.offSchedule = m.injections.filter(i => scheduled.some(x => same(x, i.drug)))
      .filter(i => !m.planned.some(p => p.date === i.date && same(p.drug, i.drug)))
      .map(i => ({ ...i, day: m.start ? daysBetween(m.start, i.date) : null, reason: m.start ? 'not-planned' : 'no-start' }));
  }

  const cages = [...new Set(mice.map(m => m.cage))].sort(byNatural);
  const groups = summarizeGroups(mice, cages, dates);

  const latest = mice.map(m => {
    const p = m.points[m.points.length - 1] || {};
    const flags = [];
    if (p.pct !== null && p.pct !== undefined) {
      if (p.pct <= LOSS_ALERT) flags.push('loss-alert');
      else if (p.pct <= LOSS_WARNING) flags.push('loss-warning');
    }
    if (m.ended) flags.push('ended');
    else if (m.lastSeen !== null && m.lastSeen !== latestDate) flags.push('missing');
    return {
      id: m.id, cage: m.cage, mouse: m.mouse,
      weight: p.weight ?? null, pct: p.pct ?? null, volume: p.volume ?? null, rtv: p.rtv ?? null,
      pctStart: p.pctStart ?? null, rtvStart: p.rtvStart ?? null,
      start: m.start, tday: m.start && latestDate ? daysBetween(m.start, latestDate) : null,
      lastSeen: m.lastSeen, flags,
      group: m.group, status: m.status, endDate: m.endDate, endDay: m.endDay, endReason: m.endReason,
    };
  });

  // Workbook groups in the order they first appear on the Mice sheet.
  const groupNames = [...new Set([...(parsed.mice || []).map(m => m.group), ...mice.map(m => m.group)].filter(Boolean))];
  // Every date a shown mouse was injected (they need not be measurement sessions).
  const injectionDates = [...new Set(mice.flatMap(m => m.injections.map(i => i.date)))].sort();
  const hasStarts = mice.some(m => m.start);
  const cadence = parsed.cadence || null;
  const hasSchedule = regimensOf.size > 0 || Boolean(cadence);
  return {
    unit: 'cage', dates, days, latestDate, mice, cages, groups, latest, groupNames, hasRoster: roster.size > 0, injectionDates, hasStarts,
    cutoff, today: opts.today || null, cadence, hasSchedule,
  };
}

const addDays = (iso, n) => new Date(ts(iso) + n * DAY).toISOString().slice(0, 10);

/**
 * Measurement days from `from` to `to` (ISO, inclusive): every `cadence.every` days counted from `cadence.from`, else
 * from `anchor` (the latest session). [] without a cadence.
 */
function measureDates(cadence, anchor, from, to) {
  const origin = (cadence && cadence.from) || anchor;
  if (!cadence || !origin || !from || !to || from > to) return [];
  const out = [];
  const k0 = Math.ceil(daysBetween(origin, from) / cadence.every);
  for (let date = addDays(origin, k0 * cadence.every); date <= to; date = addDays(date, cadence.every)) out.push(date);
  return out;
}

/**
 * `derive` (or `applyGroups`) output with weight % change and relative tumor volume measured from each mouse's
 * treatment start (`pctStart`, `rtvStart`) instead of its first measurement; mice with no start have none.
 * Loss flags are left as they are: they stay on the first recorded weight.
 */
function rebase(d) {
  const mice = d.mice.map(m => ({ ...m, points: m.points.map(p => ({ ...p, pct: p.pctStart, rtv: p.rtvStart })) }));
  const latest = d.latest.map(r => ({ ...r, pct: r.pctStart, rtv: r.rtvStart }));
  return { ...d, mice, latest, groups: summarizeGroups(mice, d.cages, d.dates), rebased: true };
}

/**
 * Mean ± SEM of `metric` per day from treatment start, over the mice that have a start, each from its baseline session on (`inGroup`):
 * [{ day, mean, sem, n, dates, tdays }] by day, `dates` being the calendar dates and `tdays` the days from start that
 * went into it. With `bin` > 1 (the measurement cadence) days are grouped in steps of `bin`, rounding up (bin 2:
 * day 0 holds days −1 and 0, day 2 holds 1 and 2), so mice with different starts measured on the same calendar days
 * line up; each mouse then counts once per step, with its value nearest the step's day (the later one on a tie).
 */
function summarizeByTreatDay(members, metric, bin = 1) {
  const step = t => (bin > 1 ? Math.ceil(t / bin) * bin || 0 : t);
  const byDay = new Map();
  for (const m of members) {
    if (!m.start) continue;
    const mine = new Map(); // step -> the point that counts, or null when none has a value
    for (const p of m.points) {
      if (!inGroup(m, p.date)) continue;
      const s = step(p.tday);
      const best = mine.get(s);
      if (p[metric] === null) { if (best === undefined) mine.set(s, null); continue; }
      if (!best || Math.abs(p.tday - s) <= Math.abs(best.tday - s)) mine.set(s, p);
    }
    for (const [s, p] of mine) {
      if (!byDay.has(s)) byDay.set(s, { values: [], dates: new Set(), tdays: new Set() });
      const b = byDay.get(s);
      b.values.push(p ? p[metric] : null);
      if (p) { b.dates.add(p.date); b.tdays.add(p.tday); }
    }
  }
  return [...byDay.entries()].sort((a, b) => a[0] - b[0])
    .map(([day, b]) => ({ day, ...summarize(b.values), dates: [...b.dates].sort(), tdays: [...b.tdays].sort((x, y) => x - y) }));
}

/** The workbook's groups (Mice sheet), as a grouping for applyGroups, in the sheet's order. */
function studyGrouping(d) {
  const used = new Set(d.mice.map(m => m.group).filter(Boolean));
  const names = (d.groupNames || [...used]).filter(n => used.has(n));
  return {
    groups: names.map(n => ({ id: n, label: n })),
    assign: Object.fromEntries(d.mice.filter(m => m.group).map(m => [m.id, m.group])),
  };
}

// Found dead, or euthanized at a humane endpoint, is an event. Euthanized at the end of the study,
// removed from the study, and alive at the last session are censored.
const isEvent = m => m.ended && m.status !== 'removed' && !/end of study/i.test(m.endReason || '');

/**
 * Kaplan–Meier survival of the mice whose `cage` is each key. Returns [{ key, n, points: [{ date, s,
 * atRisk, events }] }], with a point at the first session, at each end date and at the last session.
 */
function survival(mice, keys, dates) {
  const first = dates[0];
  const lastSession = dates[dates.length - 1];
  return keys.map(key => {
    const members = mice.filter(m => m.cage === key);
    const ends = [...new Set(members.filter(m => m.ended).map(m => m.endDate))].sort();
    let s = 1;
    const points = [{ date: first, s, atRisk: members.length, events: 0 }];
    for (const date of ends) {
      const atRisk = members.filter(m => !m.ended || m.endDate >= date).length;
      const events = members.filter(m => m.endDate === date && isEvent(m)).length;
      if (events && atRisk) s *= 1 - events / atRisk;
      points.push({ date, s, atRisk, events });
    }
    const last = ends.length && ends[ends.length - 1] > lastSession ? ends[ends.length - 1] : lastSession;
    if (points[points.length - 1].date !== last) points.push({ date: last, s, atRisk: members.filter(m => !m.ended).length, events: 0 });
    return { key, n: members.length, points };
  });
}

/**
 * Kaplan–Meier from each mouse's treatment start, over the mice that have one and had not ended before it:
 * [{ key, n, points: [{ day, s, atRisk, events }] }], `day` counted from the start. A mouse still alive is
 * censored at the latest session.
 */
function survivalFromStart(mice, keys, latestDate) {
  return keys.map(key => {
    const members = mice.filter(m => m.cage === key && m.start && (!m.ended || m.endDate >= m.start));
    const time = m => daysBetween(m.start, m.ended ? m.endDate : latestDate);
    const ends = [...new Set(members.filter(m => m.ended).map(time))].sort((a, b) => a - b);
    let s = 1;
    const points = [{ day: 0, s, atRisk: members.length, events: 0 }];
    for (const day of ends) {
      const atRisk = members.filter(m => time(m) >= day).length;
      const events = members.filter(m => m.ended && time(m) === day && isEvent(m)).length;
      if (events && atRisk) s *= 1 - events / atRisk;
      points.push({ day, s, atRisk, events });
    }
    const last = Math.max(0, ...members.map(time));
    if (points[points.length - 1].day !== last) points.push({ day: last, s, atRisk: members.filter(m => time(m) >= last).length, events: 0 });
    return { key, n: members.length, points };
  });
}

/** Whether a mouse counts in its group's means on `date`: from its baseline session before treatment (`inGroupFrom`) on. */
const inGroup = (m, date) => !m.inGroupFrom || date >= m.inGroupFrom;

/**
 * Per-group mean ± SEM of every metric at every session. `keys` are the values of m.cage, in display order.
 * A mouse with a treatment start counts only from its baseline session (`inGroup`), so mice not yet enrolled are left out.
 */
function summarizeGroups(mice, keys, dates) {
  return keys.map(cage => {
    const members = mice.filter(m => m.cage === cage);
    const series = metric => dates.map((date, k) => ({ date, ...summarize(members.filter(m => inGroup(m, date)).map(m => m.points[k][metric])) }));
    return {
      cage, mice: members.map(m => m.id),
      pct: series('pct'), weight: series('weight'), volume: series('volume'), rtv: series('rtv'),
    };
  });
}

/**
 * How many mice should have had an item: when the drug is on the schedule of some member (`scheduled`), the mice planned
 * it that date (or day) plus any that got it anyway; else the lane's `eligible`. Never fewer than got it.
 */
function itemEligible(it, plannedMice, eligible, scheduled) {
  const n = scheduled ? new Set([...plannedMice, ...it.mice]).size : eligible;
  return Math.max(n, it.mice.length);
}
const plansDrug = (members, drug) => members.some(m => (m.planned || []).some(p => p.drug.toLowerCase() === drug.toLowerCase()));

/**
 * Doses given to the mice whose `cage` is each key, for the dose strip: [{ key, doses: [{ date, eligible,
 * items: [{ drug, dose, volume, route, mice, eligible }] }] }], dates ascending. One item per drug/dose/volume/route
 * given that day (`mice` = ids that got it). `eligible` = members not ended by that date; when some member has a
 * treatment start, only members started by then (staggered enrollment: mice not yet enrolled are not expected).
 * An item's `eligible` is the mice planned that drug that day when there is a schedule (see `itemEligible`).
 */
function dosesByKey(mice, keys) {
  return keys.map(key => {
    const members = mice.filter(m => m.cage === key);
    const anyStart = members.some(m => m.start);
    const byDate = new Map();
    for (const m of members) {
      for (const inj of m.injections || []) {
        if (!byDate.has(inj.date)) byDate.set(inj.date, new Map());
        const what = byDate.get(inj.date);
        const k = [inj.drug, inj.dose, inj.volume, inj.route].join('|');
        if (!what.has(k)) what.set(k, { drug: inj.drug, dose: inj.dose, volume: inj.volume, route: inj.route, mice: [] });
        what.get(k).mice.push(m.id);
      }
    }
    const doses = [...byDate.keys()].sort().map(date => {
      const eligible = members.filter(m => (!m.ended || m.endDate >= date) && (!anyStart || (m.start && m.start <= date))).length;
      const items = [...byDate.get(date).values()].map(it => {
        const planned = new Set(members.filter(m => (m.planned || []).some(p => p.date === date && p.drug.toLowerCase() === it.drug.toLowerCase())).map(m => m.id));
        return { ...it, eligible: itemEligible(it, planned, eligible, plansDrug(members, it.drug)) };
      });
      return { date, eligible, items };
    });
    return { key, doses };
  });
}

/**
 * Doses as `dosesByKey`, but by day from each mouse's own treatment start, for the dose strip when the x axis is
 * days from treatment start: [{ key, doses: [{ day, dates, eligible, items }] }]. Mice with no start are left out.
 * `eligible` counts the mice that had reached that day by `asOf` (the data's cutoff) and not ended before it, so a
 * mouse enrolled two days ago is not expected at day 10.
 */
function dosesByTreatDay(mice, keys, asOf = null) {
  return keys.map(key => {
    const members = mice.filter(m => m.cage === key && m.start);
    const byDay = new Map();
    for (const m of members) {
      for (const inj of m.injections || []) {
        const day = daysBetween(m.start, inj.date);
        if (!byDay.has(day)) byDay.set(day, { dates: new Set(), what: new Map() });
        const b = byDay.get(day);
        b.dates.add(inj.date);
        const k = [inj.drug, inj.dose, inj.volume, inj.route].join('|');
        if (!b.what.has(k)) b.what.set(k, { drug: inj.drug, dose: inj.dose, volume: inj.volume, route: inj.route, mice: [] });
        b.what.get(k).mice.push(m.id);
      }
    }
    const doses = [...byDay.keys()].sort((a, b) => a - b).map(day => {
      const eligible = members.filter(m => (!m.ended || daysBetween(m.start, m.endDate) >= day)
        && (!asOf || daysBetween(m.start, asOf) >= day)).length;
      const items = [...byDay.get(day).what.values()].map(it => {
        const planned = new Set(members.filter(m => (m.planned || []).some(p => p.day === day && p.drug.toLowerCase() === it.drug.toLowerCase())
          && (!asOf || addDays(m.start, day) <= asOf)).map(m => m.id));
        return { ...it, eligible: itemEligible(it, planned, eligible, plansDrug(members, it.drug)) };
      });
      return { day, dates: [...byDay.get(day).dates].sort(), eligible, items };
    });
    return { key, doses };
  });
}

/**
 * Injections laid out as month grids for the calendar view: [{ key: 'YYYY-MM', year, month (0-11), weeks }], where
 * each week is 7 cells (Sunday first), `null` for days outside the month, else { date, day, inRange, measured, items };
 * weeks with no day in the study span are left out, so a long gap before the first session takes no room.
 * `day` is the study day (days since the first session, null without sessions), `inRange` is false outside the span
 * from the first session or dose to the last, `measured` marks session dates, and `items` are the doses given that
 * day, one per group or cage and drug/dose/volume/route: { key, drug, dose, volume, route, n, eligible, mice } (`n` of
 * `eligible` mice in the group or cage were given it, as in `dosesByKey`). Dates are ISO strings; all date math is UTC.
 * With a schedule each cell also has `plans`: doses planned and not given, one per group or cage, drug and status
 * (`missed` or `planned`): { key, drug, dose, volume, route, status, n, mice }, and the span reaches the last one.
 * `opts.measure` (ISO dates) marks `toMeasure` on days after the last session that are measurement days.
 */
function doseCalendar(mice, keys, sessionDates = [], opts = {}) {
  const itemsOn = new Map();
  for (const lane of dosesByKey(mice, keys)) {
    for (const z of lane.doses) {
      if (!itemsOn.has(z.date)) itemsOn.set(z.date, []);
      for (const it of z.items) {
        itemsOn.get(z.date).push({ key: lane.key, drug: it.drug, dose: it.dose, volume: it.volume, route: it.route,
          n: it.mice.length, eligible: it.eligible ?? z.eligible, mice: it.mice });
      }
    }
  }
  const plansOn = new Map();
  for (const m of mice) {
    if (!keys.includes(m.cage)) continue;
    for (const p of m.planned || []) {
      if (p.status === 'given') continue;
      if (!plansOn.has(p.date)) plansOn.set(p.date, new Map());
      const k = [m.cage, p.drug, p.dose, p.volume, p.route, p.status].join('|');
      const on = plansOn.get(p.date);
      if (!on.has(k)) on.set(k, { key: m.cage, drug: p.drug, dose: p.dose, volume: p.volume, route: p.route, status: p.status, mice: [] });
      on.get(k).mice.push(m.id);
    }
  }
  const lastSession = [...sessionDates].sort().pop() || '';
  const toMeasure = new Set((opts.measure || []).filter(date => date > lastSession));
  const all = [...sessionDates, ...itemsOn.keys(), ...plansOn.keys(), ...toMeasure].sort();
  if (!all.length) return [];
  const first = all[0];
  const last = all[all.length - 1];
  const measured = new Set(sessionDates);
  const origin = sessionDates.length ? [...sessionDates].sort()[0] : null;
  const pad = n => String(n).padStart(2, '0');
  const months = [];
  let [y, m] = first.split('-').map(Number);
  m -= 1;
  const [ly, lm] = last.split('-').map(Number);
  while (y < ly || (y === ly && m <= lm - 1)) {
    const length = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const cells = Array(new Date(Date.UTC(y, m, 1)).getUTCDay()).fill(null);
    for (let day = 1; day <= length; day++) {
      const date = `${y}-${pad(m + 1)}-${pad(day)}`;
      cells.push({
        date, day: origin ? Math.round((ts(date) - ts(origin)) / DAY) : null, inRange: date >= first && date <= last,
        measured: measured.has(date), items: itemsOn.get(date) || [],
        plans: [...(plansOn.get(date) || new Map()).values()].map(p => ({ ...p, n: p.mice.length })),
        toMeasure: toMeasure.has(date),
      });
    }
    while (cells.length % 7) cells.push(null);
    const weeks = [];
    for (let i = 0; i < cells.length; i += 7) {
      const week = cells.slice(i, i + 7);
      if (week.some(c => c && c.inRange)) weeks.push(week); // weeks wholly outside the study are left out
    }
    months.push({ key: `${y}-${pad(m + 1)}`, year: y, month: m, weeks });
    if (++m > 11) { m = 0; y += 1; }
  }
  return months;
}

/**
 * The work for the days `from` .. `from + n - 1` (ISO): [{ date, measure, doses: [{ key, drug, dose, volume, route,
 * mice }] }], one entry per day, `measure` true on measurement days (`measure` = ISO dates). Doses are the planned,
 * not yet given doses of the mice whose `cage` is in `keys`, one per group or cage and drug/dose/volume/route.
 */
function upcomingWork(mice, keys, from, n, measure = []) {
  const meas = new Set(measure);
  return Array.from({ length: n }, (_, k) => {
    const date = addDays(from, k);
    const what = new Map();
    for (const m of mice) {
      if (!keys.includes(m.cage)) continue;
      for (const p of m.planned || []) {
        if (p.date !== date || p.status === 'given') continue;
        const id = [m.cage, p.drug, p.dose, p.volume, p.route].join('|');
        if (!what.has(id)) what.set(id, { key: m.cage, drug: p.drug, dose: p.dose, volume: p.volume, route: p.route, mice: [] });
        what.get(id).mice.push(m.id);
      }
    }
    const doses = [...what.values()].sort((a, b) => keys.indexOf(a.key) - keys.indexOf(b.key) || byNatural(a.drug, b.drug));
    return { date, measure: meas.has(date), doses };
  });
}

/* ----------------------------------------------------------------- groups */
// The user's own groups (e.g. treatment arms), kept on the device per note, not in the note:
// { groups: [{ id, label }], assign: { mouseId: groupId } }. Ids are opaque so a group can be renamed.

const UNGROUPED = '_none';

/** A saved grouping with anything malformed dropped. Assignments to unknown mice are kept (they are ignored). */
function cleanGrouping(raw) {
  const groups = [];
  const ids = new Set();
  for (const g of raw && Array.isArray(raw.groups) ? raw.groups : []) {
    if (!g || typeof g.id !== 'string' || !g.id || g.id === UNGROUPED || ids.has(g.id)) continue;
    ids.add(g.id);
    groups.push({ id: g.id, label: typeof g.label === 'string' ? g.label : '' });
  }
  const assign = {};
  const a = raw && raw.assign && typeof raw.assign === 'object' ? raw.assign : {};
  for (const [mouse, gid] of Object.entries(a)) if (ids.has(gid)) assign[mouse] = gid;
  return { groups, assign };
}

function groupLabel(grouping, id) {
  if (id === UNGROUPED) return 'Not grouped';
  const k = grouping.groups.findIndex(g => g.id === id);
  return k < 0 ? '' : grouping.groups[k].label.trim() || `Group ${k + 1}`;
}

const groupOf = (grouping, mouseId) => {
  const gid = grouping.assign[mouseId];
  return grouping.groups.some(g => g.id === gid) ? gid : UNGROUPED;
};

/**
 * `derive` output re-keyed by the user's groups: every mouse's `cage` becomes its group id (the real cage
 * moves to `realCage`), so the views aggregate and color by group unchanged. Groups keep the user's order;
 * mice in no group go last, under UNGROUPED.
 */
function applyGroups(d, grouping) {
  const keys = grouping.groups.map(g => g.id);
  const regroup = x => ({ ...x, realCage: x.cage, cage: groupOf(grouping, x.id) });
  let mice = d.mice.map(regroup);
  if (mice.some(m => m.cage === UNGROUPED)) keys.push(UNGROUPED);
  const rank = new Map(keys.map((k, i) => [k, i]));
  const order = (a, b) => rank.get(a.cage) - rank.get(b.cage) || byNatural(a.realCage, b.realCage) || byNatural(a.mouse, b.mouse);
  mice = mice.sort(order);
  const latest = d.latest.map(regroup).sort(order);
  const labels = Object.fromEntries(keys.map(k => [k, groupLabel(grouping, k)]));
  return { ...d, unit: 'group', mice, cages: keys, labels, groups: summarizeGroups(mice, keys, d.dates), latest };
}

/**
 * Deal `rows` ({ id, volume, weight, ... }) into the groups so group sizes differ by at most one.
 * by = 'volume' or 'weight': rank the mice by that value (largest first, unmeasured last) and send each run of
 * k mice (k groups) one to each group in a random order, so the group means stay close. by = 'random': plain
 * shuffle. Returns { mouseId: groupId }. `rand` returns [0, 1) (injectable for tests).
 */
function distribute(rows, groupIds, by, rand = Math.random) {
  const k = groupIds.length;
  if (!k) return {};
  const shuffle = a => {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };
  let order = shuffle([...rows]); // random order breaks ties
  if (by !== 'random') {
    const v = r => (r[by] === null || r[by] === undefined ? -Infinity : r[by]);
    order = order.map((r, i) => [r, i]).sort((a, b) => (v(b[0]) > v(a[0])) - (v(b[0]) < v(a[0])) || a[1] - b[1]).map(x => x[0]);
  }
  const out = {};
  for (let i = 0; i < order.length; i += k) {
    const perm = shuffle([...groupIds]);
    order.slice(i, i + k).forEach((r, j) => { out[r.id] = perm[j]; });
  }
  return out;
}

/* ----------------------------------------------------------------- render */
// Everything below needs a browser.

const STORE_NOTE = 'in-vivo-plots:note';
const STORE_PREFS = 'in-vivo-plots:prefs';

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); return true; } catch { return false; } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* storage unavailable */ } },
};

const fmtDate = (x, opts = { month: 'short', day: 'numeric' }) =>
  new Date(x).toLocaleDateString(undefined, { ...opts, timeZone: 'UTC' });
/** Today on this device, as ISO (local date). */
const localToday = () => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`; };
const fmtLongDate = iso => fmtDate(ts(iso), { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const fmt = (v, digits = 1) => (v === null || v === undefined ? '—' : v.toFixed(digits));
const fmtSigned = (v, digits = 1) => (v === null || v === undefined ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(digits));

// Display settings: allowed values, the first is the default. Saved per device.
const PREF_VALUES = {
  weight: ['pct', 'weight'],     // body weight as % change or grams
  tumor: ['volume', 'rtv'],      // tumor volume, or relative to each mouse's first measured volume
  scale: ['linear', 'log'],      // tumor y axis
  error: ['sem', 'sd', 'none'],  // whiskers on the per-cage charts
  x: ['date', 'day', 'treat'],   // x axis: calendar date, study day, or days from each mouse's treatment start
  base: ['first', 'start'],      // weight % change and relative volume from the first measurement or the treatment start
  theme: ['auto', 'light', 'dark'],
  order: ['value', 'mouse'],     // per-mouse bar charts
  heat: ['pct', 'weight', 'volume', 'rtv'],
  // Aggregate and color by the workbook's groups, the current cage, or the user's own groups (this device).
  // Falls back when the chosen one isn't there (see effectiveBy).
  by: ['group', 'cage', 'mine'],
  // Slide images (see SLIDE_SIZES): size, background and whether the chart title is on the image.
  slideSize: ['content', 'full', 'half', 'pair'],
  slideBg: ['light', 'dark', 'none'],
  slideTitle: ['off', 'on'],
};
const SORT_KEYS = ['id', 'where', 'start', 'tday', 'weight', 'pct', 'volume', 'rtv', 'flags'];

function loadPrefs() {
  let saved = {};
  try { saved = JSON.parse(store.get(STORE_PREFS) || '{}') || {}; } catch { saved = {}; }
  const prefs = {};
  for (const [k, vals] of Object.entries(PREF_VALUES)) prefs[k] = vals.includes(saved[k]) ? saved[k] : vals[0];
  for (const k of ['hidden', 'hiddenGroups']) prefs[k] = Array.isArray(saved[k]) ? saved[k].filter(c => typeof c === 'string') : [];
  const s = saved.sort || {};
  prefs.sort = { key: SORT_KEYS.includes(s.key) ? s.key : 'id', dir: s.dir === -1 ? -1 : 1 };
  return prefs;
}

const state = {
  charts: [], derived: null, name: '', prefs: loadPrefs(),
  focus: null,      // highlighted mouse id
  expanded: null,   // id of the card shown full screen
  views: {},        // id -> { title, subtitle, chart?, rows() } for the export tools
  base: null,       // derive() output, by cage; state.derived is this or applyGroups(base)
  grouping: { groups: [], assign: {} },
  selected: new Set(), // mice ticked in the groups panel
  panel: false,     // groups panel open
  panelSort: 'mouse',
  minVolume: '',    // "Tumor vol. ≥" box in the groups panel
  parsed: null,     // parse output, for the workbook's Mice order
  jumpTo: null,     // card last picked in the jump bar, to tell apart cards that share a row
  moreSettings: false, // phone: the toolbar's less-used settings unfolded
  slide: null,      // { id, from } while the slide image dialog is open
  chartFont: 12,    // chart text size the views were drawn with (chartFont)
};

const savePrefs = () => store.set(STORE_PREFS, JSON.stringify(state.prefs));

const METRICS = {
  pct: {
    name: 'Body weight change', axis: 'Change from first weight (%)', digits: 1,
    tick: v => `${v}%`, val: v => `${fmtSigned(v)}%`, err: v => fmt(v),
  },
  weight: {
    name: 'Body weight', axis: 'Body weight (g)', digits: 2,
    tick: v => v, val: v => `${fmt(v, 2)} g`, err: v => fmt(v, 2),
  },
  volume: {
    name: 'Tumor volume', axis: 'Tumor volume (L × W² / 2)', digits: 1, tumor: true,
    tick: v => Number(v).toLocaleString(), val: v => fmt(v), err: v => fmt(v),
  },
  rtv: {
    name: 'Relative tumor volume', axis: 'Tumor volume (× first measured)', digits: 2, tumor: true,
    tick: v => `${+Number(v).toFixed(2)}×`, val: v => `${fmt(v, 2)}×`, err: v => fmt(v, 2),
  },
};

function theme() {
  const cs = getComputedStyle(document.documentElement);
  const v = name => cs.getPropertyValue(name).trim();
  return {
    page: v('--page'), surface: v('--surface'), ink: v('--ink'), ink2: v('--ink-2'), muted: v('--muted'),
    grid: v('--grid'), axis: v('--axis'), warning: v('--warning'), critical: v('--critical'), band: v('--band'),
    series: [1, 2, 3, 4, 5, 6, 7, 8].map(k => v(`--series-${k}`)),
  };
}

// Categorical colors in fixed order; past eight, reuse with a dashed line (composite encoding).
// Colors follow the cage's position in the full cage list, so filtering never repaints a cage.
const seriesStyle = (t, k) => ({ color: t.series[k % 8], dash: k >= 8 ? [6, 4] : [] });
const seriesVar = k => `var(--series-${(k % 8) + 1})`;
const dim = color => `${color}2e`; // hex + alpha

// In group mode d.cages holds group ids; hidden ones are remembered separately from hidden cages.
const hiddenKey = d => (d.unit === 'group' ? 'hiddenGroups' : 'hidden');
const shownCages = d => {
  const shown = d.cages.filter(c => !state.prefs[hiddenKey(d)].includes(c));
  return shown.length ? shown : d.cages;
};
const cageName = (d, c) => (d.unit === 'group' ? d.labels[c] : `Cage ${c}`);
const cageText = (d, c) => (d.unit === 'group' ? d.labels[c] : c); // for chips and CSV
// Mouse identity columns for CSV: in group mode the real cage and the group label.
const idHead = d => (d.unit === 'group' ? ['mouse', 'cage', 'group'] : ['mouse', 'cage']);
const idVals = (d, m) => (d.unit === 'group' ? [m.id, m.realCage, d.labels[m.cage]] : [m.id, m.cage]);
// Where a mouse is now (latest row), or was on a point's date.
const realCage = m => m.realCage ?? m.cage;
const placeText = (cage, mark) => (cage ? `${cage}${mark ? ` · t${mark}` : ''}` : '—');
const placeLong = (cage, mark) => (cage ? `cage ${cage}${mark ? `, tail ${mark}` : ''}` : '');
const STATUS_TEXT = { euthanized: 'Euthanized', 'found dead': 'Found dead', removed: 'Removed', ended: 'Ended' };
const statusText = s => STATUS_TEXT[s] || (s ? s[0].toUpperCase() + s.slice(1) : 'Ended');
/** "Euthanized Nov 12 (day 15) · weight loss" */
const endText = m => `${statusText(m.status)} ${fmtDate(ts(m.endDate))} (day ${m.endDay})${m.endReason ? ` · ${m.endReason}` : ''}`;
// The treatment-start settings apply only when the workbook gives some group a Treatment start.
const hasStarts = () => Boolean(state.base && state.base.hasStarts);
const effX = () => (state.prefs.x === 'treat' && !hasStarts() ? 'date' : state.prefs.x);
const effBase = () => (state.prefs.base === 'start' && hasStarts() ? 'start' : 'first');
const treatMode = () => effX() === 'treat';
// From treatment start, means are taken in steps of the measurement cadence (Groups sheet), so staggered starts line up.
const binDays = () => (treatMode() && state.base && state.base.cadence ? state.base.cadence.every : 1);
const binDay = t => { const b = binDays(); return b > 1 ? Math.ceil(t / b) * b || 0 : t; };
const xv = (d, k) => (effX() === 'day' ? d.days[k] : ts(d.dates[k]));
// Wording that follows the baseline setting.
const FROM_START = {
  pct: { axis: 'Change from weight at treatment start (%)', what: '% change from each mouse’s weight at its treatment start' },
  rtv: { axis: 'Tumor volume (× at treatment start)', what: 'each mouse’s volume ÷ its volume at its treatment start' },
};
const axisTitle = metric => (effBase() === 'start' && FROM_START[metric] ? FROM_START[metric].axis : METRICS[metric].axis);
const noStartNote = n => (n ? ` ${n} ${n > 1 ? 'mice' : 'mouse'} with no treatment start ${n > 1 ? 'are' : 'is'} left out.` : '');
// Relative volume from treatment start needs a volume on or before the start: say how many tumor-bearing mice lack one.
function noBaselineNote(d, metric, mice) {
  if (!d.rebased || metric !== 'rtv') return '';
  const n = mice.filter(m => m.start && m.startVolume === null && m.points.some(p => p.volume !== null)).length;
  return n ? ` ${n} ${n > 1 ? 'mice' : 'mouse'} with no tumor measured by the treatment start ${n > 1 ? 'have' : 'has'} no relative volume.` : '';
}
const errName = () => ({ sem: 'SEM', sd: 'SD', none: '' }[state.prefs.error]);

/* ---------------------------------------------------------- chart plugins */

// Chart text is 12px, larger on big screens (chartFont) and on slides (SLIDE_FONT). The plugins below size their
// text, lines and markers from Chart.defaults.font.size, so they grow with it.
const chartFont = () => Math.min(15, Math.max(12, Math.round(innerWidth / 200)));
const fz = px => Math.round(px * (Chart.defaults.font.size || 12) / 12 * 10) / 10;
const sysFont = (px, weight = '') => `${weight ? `${weight} ` : ''}${fz(px)}px system-ui, -apple-system, "Segoe UI", sans-serif`;

// Chart.js has no error bars: draw whiskers for datasets that carry `err`.
const errBars = {
  id: 'errBars',
  afterDatasetsDraw(chart) {
    const { ctx } = chart;
    const y = chart.scales.y;
    chart.data.datasets.forEach((ds, di) => {
      if (!ds.err || !chart.isDatasetVisible(di)) return;
      const meta = chart.getDatasetMeta(di);
      ctx.save();
      ctx.strokeStyle = ds.borderColor;
      ctx.lineWidth = fz(1.5);
      const cap = fz(4);
      meta.data.forEach((pt, i) => {
        const d = ds.data[i];
        const s = ds.err[i];
        if (!d || d.y === null || s === null || s === undefined) return;
        const top = y.getPixelForValue(d.y + s);
        // On a log axis a whisker can reach zero or below: stop it at the bottom of the plot.
        const low = d.y - s;
        const bottom = y.type === 'logarithmic' && low <= 0 ? chart.chartArea.bottom : y.getPixelForValue(low);
        ctx.beginPath();
        ctx.moveTo(pt.x, top); ctx.lineTo(pt.x, bottom);
        ctx.moveTo(pt.x - cap, top); ctx.lineTo(pt.x + cap, top);
        ctx.moveTo(pt.x - cap, bottom); ctx.lineTo(pt.x + cap, bottom);
        ctx.stroke();
      });
      ctx.restore();
    });
  },
};

// Shaded horizontal bands behind the data: options.plugins.bands = { color, labelColor, bands: [{ from, to, label }] }.
// Used for the tumor volume range 50–100 (TUMOR_BAND) on the tumor volume charts.
const TUMOR_BAND = { from: 50, to: 100, label: '50–100' };
const bandNote = metric => (metric === 'volume' ? ` Shaded: volume ${TUMOR_BAND.label}.` : '');
const bands = {
  id: 'bands',
  beforeDatasetsDraw(chart, _args, opts) {
    const list = (opts && opts.bands) || [];
    const { ctx, chartArea: a } = chart;
    const y = chart.scales.y;
    for (const b of list) {
      const clamp = v => Math.max(a.top, Math.min(a.bottom, v));
      const top = clamp(y.getPixelForValue(b.to));
      const bottom = clamp(y.getPixelForValue(b.from));
      if (bottom - top < 1) continue;
      ctx.save();
      ctx.fillStyle = opts.color;
      ctx.fillRect(a.left, top, a.right - a.left, bottom - top);
      if (b.label && bottom - top > fz(14)) {
        ctx.font = sysFont(11);
        ctx.fillStyle = opts.labelColor;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(b.label, a.left + fz(4), top + fz(3));
      }
      ctx.restore();
    }
  },
};

// Horizontal threshold lines: options.plugins.refLines = { labelColor, lines: [{ y, color, label }] }.
const refLines = {
  id: 'refLines',
  beforeDatasetsDraw(chart, _args, opts) {
    const lines = (opts && opts.lines) || [];
    const { ctx, chartArea: a } = chart;
    const y = chart.scales.y;
    for (const l of lines) {
      const py = y.getPixelForValue(l.y);
      if (py < a.top || py > a.bottom) continue;
      ctx.save();
      ctx.strokeStyle = l.color;
      ctx.lineWidth = fz(1.5);
      ctx.setLineDash([fz(6), fz(4)]);
      ctx.beginPath(); ctx.moveTo(a.left, py); ctx.lineTo(a.right, py); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = opts.labelColor;
      ctx.font = sysFont(12);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText(l.label, a.right - fz(4), py - fz(3));
      ctx.restore();
    }
  },
};

// Direct labels at the last point of datasets that carry `endLabel`, nudged apart so they don't overlap.
const endLabels = {
  id: 'endLabels',
  afterDatasetsDraw(chart, _args, opts) {
    const { ctx } = chart;
    const labels = [];
    chart.data.datasets.forEach((ds, di) => {
      if (!ds.endLabel || !chart.isDatasetVisible(di)) return;
      let k = ds.data.length - 1;
      while (k >= 0 && (ds.data[k].y === null || ds.data[k].y === undefined)) k--;
      if (k < 0) return;
      const pt = chart.getDatasetMeta(di).data[k];
      labels.push({ x: pt.x + fz(8), y: pt.y, text: ds.endLabel });
    });
    labels.sort((a, b) => a.y - b.y);
    for (let i = 1; i < labels.length; i++) labels[i].y = Math.max(labels[i].y, labels[i - 1].y + fz(12));
    ctx.save();
    ctx.font = sysFont(11, 600);
    ctx.fillStyle = opts.color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (const l of labels) ctx.fillText(l.text, l.x, l.y);
    ctx.restore();
  },
};

// Doses: a strip between the plot and the x axis, one lane per shown group or cage that was dosed, with a ▲ in
// the lane's color on each dose date (filled: every mouse in the lane got it; hollow: only some did). Hovering
// or tapping the strip shows what each lane got that day. options.plugins.doses = { lanes: [{ label, color,
// doses: [{ x, title, eligible, items }] }], ink, ink2, muted, grid, surface, axis }; doses at the same x share a box.
// Lane height: tighter on short (phone) charts so a strip of several lanes leaves room for the plot.
const doseLaneBase = chart => (chart.height < 340 * fz(1) ? 8 : 11);
const doseLane = chart => fz(doseLaneBase(chart));
const doseText = it => [it.drug, it.dose, it.volume ? `${it.volume} µL` : '', it.route].filter(Boolean).join(' · ');
const doseCount = (it, eligible) => (it.mice.length >= eligible ? `${it.mice.length} mice` : `${it.mice.length} of ${eligible} mice`);

function doseTriangle(ctx, x, y, r, filled) {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y + r * 0.8);
  ctx.lineTo(x - r, y + r * 0.8);
  ctx.closePath();
  if (filled) ctx.fill(); else { ctx.lineWidth = fz(1.5); ctx.stroke(); }
}

const doseStrip = {
  id: 'doses',
  start(chart, _args, opts) {
    const box = {
      position: 'bottom', weight: -10, fullSize: false, options: {}, opts,
      isHorizontal: () => true,
      update(maxWidth) {
        const n = (box.opts.lanes || []).length;
        box.width = maxWidth;
        box.height = n ? fz(6) + n * doseLane(chart) : 0;
      },
      draw() { drawDoseLanes(chart, box); },
    };
    chart.$doseBox = box;
    Chart.layouts.addBox(chart, box);
  },
  beforeUpdate(chart, _args, opts) { chart.$doseBox.opts = opts; },
  stop(chart) { Chart.layouts.removeBox(chart, chart.$doseBox); },
  beforeEvent(chart, args) {
    const box = chart.$doseBox;
    const lanes = box.opts.lanes || [];
    if (!lanes.length) return undefined;
    const e = args.event;
    const inStrip = e.type !== 'mouseout' && e.y >= box.top - 2 && e.y <= box.bottom + 2
      && e.x >= chart.chartArea.left - 8 && e.x <= chart.chartArea.right + 8;
    let hit = null;
    if (inStrip) {
      let best = 9;
      for (const l of lanes) {
        for (const dz of l.doses) {
          const dist = Math.abs(chart.scales.x.getPixelForValue(dz.x) - e.x);
          if (dist < best) { best = dist; hit = dz.x; }
        }
      }
    }
    if (hit !== (chart.$doseHit ?? null)) { chart.$doseHit = hit; args.changed = true; }
    if (!inStrip) return undefined;
    // Over the strip: the dose box replaces the chart's own tooltip and hover.
    if (chart.getActiveElements().length) chart.setActiveElements([]);
    if (chart.tooltip && chart.tooltip.getActiveElements().length) chart.tooltip.setActiveElements([], { x: e.x, y: e.y });
    e.native.target.style.cursor = hit !== null ? 'help' : '';
    chart.render();
    return false;
  },
  afterDraw(chart) {
    const at = chart.$doseHit;
    if (at === null || at === undefined) return;
    const box = chart.$doseBox;
    const o = box.opts;
    const hits = (o.lanes || []).map(l => ({ l, dz: l.doses.find(z => z.x === at) })).filter(h => h.dz);
    if (!hits.length) return;
    const { ctx, chartArea: a } = chart;
    const px = chart.scales.x.getPixelForValue(at);
    const title = hits[0].dz.title;
    const lines = hits.flatMap(({ l, dz }) => dz.items.map(it => ({ color: l.color, text: `${l.label}: ${doseText(it)} (${doseCount(it, it.eligible ?? dz.eligible)})` })));
    ctx.save();
    ctx.strokeStyle = o.muted;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, box.bottom); ctx.stroke();
    ctx.setLineDash([]);
    const font = '12px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.font = `600 ${font}`;
    let w = ctx.measureText(title).width;
    ctx.font = font;
    for (const ln of lines) w = Math.max(w, ctx.measureText(ln.text).width + 14);
    const pad = 8;
    const lh = 16;
    const bw = Math.min(w + 2 * pad, chart.width - 4);
    const bh = pad * 2 + lh * (lines.length + 1);
    const bx = Math.max(2, Math.min(px - bw / 2, chart.width - bw - 2));
    const by = Math.max(2, box.top - bh - 6);
    ctx.fillStyle = o.surface;
    ctx.strokeStyle = o.axis;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(bx, by, bw, bh, 6) : ctx.rect(bx, by, bw, bh);
    ctx.fill(); ctx.stroke();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = `600 ${font}`;
    ctx.fillStyle = o.ink;
    ctx.fillText(title, bx + pad, by + pad + lh / 2, bw - 2 * pad);
    ctx.font = font;
    lines.forEach((ln, i) => {
      const y = by + pad + lh * (i + 1) + lh / 2;
      ctx.fillStyle = ln.color;
      doseTriangle(ctx, bx + pad + 4, y, 4, true);
      ctx.fillStyle = o.ink2;
      ctx.fillText(ln.text, bx + pad + 14, y, bw - 2 * pad - 14);
    });
    ctx.restore();
  },
};

function drawDoseLanes(chart, box) {
  const o = box.opts;
  const lanes = o.lanes || [];
  if (!lanes.length) return;
  const { ctx, chartArea: a } = chart;
  const x = chart.scales.x;
  const lane = doseLane(chart);
  ctx.save();
  const top = box.top + fz(3);
  ctx.font = sysFont(10);
  ctx.fillStyle = o.muted;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText('Dose', a.left - fz(6), top + (lanes.length * lane) / 2);
  lanes.forEach((l, i) => {
    const cy = top + i * lane + lane / 2;
    ctx.strokeStyle = o.grid;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(a.left, cy); ctx.lineTo(a.right, cy); ctx.stroke();
    ctx.fillStyle = l.color;
    ctx.strokeStyle = l.color;
    for (const dz of l.doses) {
      const px = x.getPixelForValue(dz.x);
      if (px < a.left - 1 || px > a.right + 1) continue;
      const all = dz.items.every(it => it.mice.length >= (it.eligible ?? dz.eligible));
      doseTriangle(ctx, px, cy, fz(doseLaneBase(chart) < 10 ? 3.2 : 4), all);
    }
  });
  ctx.restore();
}

/* --------------------------------------------------------- chart options */

// x of any date on the date or study-day axis (an end date can fall between sessions).
const xOfDate = (d, date) => (effX() === 'day' ? daysBetween(d.dates[0], date) : ts(date));

// The x values that get a tick: the sessions, or with x = treatment, every day (or step, see binDays) from treatment
// start on which a shown mouse with a start has a value of `metric` (any weight or volume when none is given), so a
// tumor chart does not reach back to sessions that only weighed the mice.
const hasValue = metric => p => (metric ? p[metric] !== null && p[metric] !== undefined : p.weight !== null || p.volume !== null);
function tickXs(d, metric = null) {
  if (!treatMode()) return d.dates.map((_, k) => xv(d, k));
  const shown = shownCages(d);
  return [...new Set(d.mice.filter(m => m.start && shown.includes(m.cage))
    .flatMap(m => m.points.filter(hasValue(metric)).map(p => binDay(p.tday))))].sort((a, b) => a - b);
}

function xScale(t, d, extraXs = [], metric = null) {
  const byDate = effX() === 'date';
  const xs = tickXs(d, metric);
  // With binning the ticks are the steps, but each mouse's own line keeps its exact days: keep those in range too.
  const exact = treatMode() && binDays() > 1
    ? d.mice.filter(m => m.start && shownCages(d).includes(m.cage)).flatMap(m => m.points.filter(hasValue(metric)).map(p => p.tday))
    : [];
  const all = [...xs, ...extraXs, ...exact];
  if (!all.length) all.push(0);
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const unit = byDate ? DAY : 1;
  const pad = Math.max(0.4 * unit, (hi - lo) * 0.03);
  return {
    type: 'linear',
    min: lo - pad,
    max: hi + pad,
    afterBuildTicks: axis => { axis.ticks = xs.map(value => ({ value })); },
    afterTickToLabelConversion: thinLabels,
    // From treatment start the ticks are denser (one per session per start) and the axis has a title: numbers only.
    ticks: { color: t.muted, maxRotation: 0, autoSkip: false, callback: v => (byDate ? fmtDate(v) : treatMode() ? `${v}` : `Day ${v}`) },
    title: { display: treatMode(), text: 'Days from treatment start', color: t.ink2 },
    grid: { color: t.grid },
    border: { color: t.axis },
  };
}

// Sessions are unevenly spaced, so Chart.js's autoSkip lets close labels run into each other ("Nov 5Nov 6").
// Blank the labels that would touch, keeping the latest one and going back in time; every session keeps its grid line.
function thinLabels(axis) {
  const ticks = axis.ticks;
  if (ticks.length < 2 || !(axis.max > axis.min)) return;
  const ctx = axis.ctx;
  ctx.save();
  ctx.font = Chart.helpers.toFont(axis.options.ticks.font).string;
  const widths = ticks.map(tk => ctx.measureText(String(tk.label ?? '')).width);
  ctx.restore();
  const W = axis.maxWidth || axis.chart.width;
  const px = v => ((v - axis.min) / (axis.max - axis.min)) * W;
  const gap = fz(10);
  let left = Infinity;
  for (let i = ticks.length - 1; i >= 0; i--) {
    const c = px(ticks[i].value);
    if (c + widths[i] / 2 + gap <= left) left = c - widths[i] / 2;
    else ticks[i].label = '';
  }
}

// Log ticks: label only 1, 2 and 5 × 10^n so the axis stays readable.
const logTick = M => v => {
  const p = 10 ** Math.floor(Math.log10(v));
  const m = v / p;
  return [1, 2, 5].some(x => Math.abs(m - x) < 1e-6) ? M.tick(+v.toPrecision(2)) : '';
};

function yScale(t, metric) {
  const M = METRICS[metric];
  const log = M.tumor && state.prefs.scale === 'log';
  const y = {
    type: log ? 'logarithmic' : 'linear',
    title: { display: true, text: axisTitle(metric), color: t.ink2 },
    ticks: { color: t.muted, callback: log ? logTick(M) : v => M.tick(v) },
    grid: { color: t.grid },
    border: { color: t.axis },
  };
  if (metric === 'pct') { y.suggestedMin = -22; y.suggestedMax = 5; }
  if (M.tumor && !log) y.beginAtZero = true;
  return y;
}

/** Tooltip title of a time-chart point: its date and study day, or its day from treatment start (and the date(s)). */
function pointTitle(raw) {
  if (!raw) return '';
  if (treatMode()) {
    const dates = raw.dates || (raw.date ? [raw.date] : []);
    const span = raw.tdays && (raw.tdays.length > 1 || raw.tdays[0] !== raw.tday)
      ? ` (day${raw.tdays.length > 1 ? 's' : ''} ${raw.tdays.length > 1 ? `${raw.tdays[0]}–${raw.tdays[raw.tdays.length - 1]}` : raw.tdays[0]})` : '';
    return `Treatment day ${raw.tday}${span}${dates.length ? ` · ${dates.length === 1 ? fmtLongDate(dates[0]) : dates.map(x => fmtDate(ts(x))).join(', ')}` : ''}`;
  }
  return raw.date ? `${fmtLongDate(raw.date)} · Day ${raw.day}` : '';
}

function chartOptions(t, d, metric) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'nearest', axis: 'xy', intersect: false },
    layout: { padding: { right: fz(14) } },
    scales: { x: xScale(t, d, [], metric), y: yScale(t, metric) },
    plugins: {
      legend: {
        position: 'top',
        align: 'start',
        labels: { color: t.ink2, usePointStyle: true, pointStyle: 'circle', boxWidth: 8, boxHeight: 8, padding: 12 },
      },
      tooltip: {
        backgroundColor: t.surface, titleColor: t.ink, bodyColor: t.ink2, borderColor: t.axis, borderWidth: 1,
        padding: 10, usePointStyle: true, boxWidth: 8, boxHeight: 8,
        callbacks: {
          title: items => pointTitle(items.length ? items[0].raw : null),
        },
      },
      // The −15% and −20% lines are humane endpoints from the first weight, so they are left off a chart from treatment start.
      refLines: {
        labelColor: t.ink2,
        lines: metric === 'pct' && !d.rebased ? [
          { y: LOSS_WARNING, color: t.warning, label: '−15%' },
          { y: LOSS_ALERT, color: t.critical, label: '−20%' },
        ] : [],
      },
      endLabels: { color: t.ink2 },
      bands: { color: t.band, labelColor: t.muted, bands: metric === 'volume' ? [TUMOR_BAND] : [] },
      doses: { lanes: [], ink: t.ink, ink2: t.ink2, muted: t.muted, grid: t.grid, surface: t.surface, axis: t.axis },
    },
  };
}

/** Dose strip lanes for the shown groups or cages that were dosed, colored like their series. */
// With x = treatment, each mouse's doses are placed by its own start, so a lane's ▲ can stand for several dates.
function doseLanes(t, d, shown) {
  if (!d.injectionDates || !d.injectionDates.length) return [];
  const treat = treatMode();
  const place = treat
    ? z => ({ ...z, x: z.day, title: `Dosed on treatment day ${z.day} · ${z.dates.map(x => fmtDate(ts(x))).join(', ')}` })
    : z => ({ ...z, x: xOfDate(d, z.date), title: `Dosed ${fmtLongDate(z.date)} · Day ${daysBetween(d.dates[0], z.date)}` });
  return (treat ? dosesByTreatDay(d.mice, d.cages, d.cutoff) : dosesByKey(d.mice, d.cages))
    .map((g, k) => ({ g, k }))
    .filter(({ g }) => shown.includes(g.key) && g.doses.length)
    .map(({ g, k }) => ({ label: cageName(d, g.key), color: seriesStyle(t, k).color, doses: g.doses.map(place) }));
}

/** Put the dose strip on a time chart: lanes, and an x axis wide enough for doses outside the sessions. */
function addDoses(opts, t, d, lanes, extraXs = [], metric = null) {
  opts.plugins.doses.lanes = lanes;
  opts.scales.x = xScale(t, d, [...extraXs, ...lanes.flatMap(l => l.doses.map(z => z.x))], metric);
}
const DOSE_KEY = '▲ dose (tap or hover the strip for the drug)';

// Legend with one entry per cage; hidden cages are struck through. Clicking an entry shows or hides the cage.
function cageLegend(t, d, pointStyle = 'circle') {
  return {
    generateLabels: () => d.cages.map((c, k) => ({
      text: cageName(d, c), fillStyle: seriesStyle(t, k).color, strokeStyle: seriesStyle(t, k).color,
      fontColor: t.ink2, pointStyle, lineWidth: 0, hidden: !shownCages(d).includes(c), cage: c,
    })),
    onClick: (_e, item) => toggleCage(item.cage),
  };
}

function makeChart(canvas, config) {
  const chart = new Chart(canvas, { ...config, plugins: [bands, errBars, refLines, endLabels, doseStrip] });
  state.charts.push(chart);
  return chart;
}

/* ------------------------------------------------------------------ cards */

const ICONS = {
  png: '<path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5v-1h-8v8h1"/>',
  csv: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M2.5 6.5h11M2.5 9.75h11M6.5 6.5V13"/>',
  expand: '<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>',
  slide: '<rect x="1.5" y="2.5" width="13" height="8.5" rx="1.2"/><path d="M8 11v2.5M5 13.5h6M4.5 8.5l2.5-2.5 2 1.5 2.5-3"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  collapse: '<path d="M6 2.5V6H2.5M13.5 6H10V2.5M10 13.5V10h3.5M2.5 10H6v3.5"/>',
};
const icon = name => `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
const TOOL_TIPS = {
  png: 'Download PNG', copy: 'Copy as a slide image (16:9), with the last slide settings',
  slide: 'Slide image for PowerPoint: size, background, preview, copy or download', tsv: 'Copy as a table (paste into Excel or Prism)', csv: 'Download CSV',
};
const CHART_TOOLS = ['slide', 'copy', 'csv', 'expand'];
const TABLE_TOOLS = ['tsv', 'csv', 'expand'];

function card(id, title, subtitle, tools, { extra = '', hint = '' } = {}) {
  const sec = document.createElement('section');
  sec.className = 'card' + (state.expanded === id ? ' expanded' : '');
  sec.id = id;
  const buttons = tools.map(tool => {
    const label = tool === 'expand' ? (state.expanded === id ? 'Close full screen (Esc)' : 'Full screen') : TOOL_TIPS[tool];
    const ic = tool === 'expand' ? (state.expanded === id ? 'collapse' : 'expand') : tool === 'tsv' ? 'copy' : tool;
    return `<button type="button" class="tool" data-tool="${tool}" title="${label}" aria-label="${label}">${icon(ic)}</button>`;
  }).join('');
  sec.innerHTML = `<div class="card-head"><div class="titles"><h2 title="${escapeHtml(title)}">${title}</h2>${
    subtitle ? `<p class="sub" title="${escapeHtml(`${subtitle} ${hint}`.trim())}">${subtitle}${hint ? ` <span class="hint">${hint}</span>` : ''}</p>` : ''}</div>`
    + `<div class="card-tools">${extra}<div class="tools">${buttons}</div></div></div>`
    + (state.expanded === id ? cardControls(id) : '');
  state.views[id] = { title, subtitle, rows: () => [] };
  return sec;
}

function chartBox(sec) {
  sec.classList.add('chart-card');
  const box = document.createElement('div');
  box.className = 'chart';
  const canvas = document.createElement('canvas');
  box.appendChild(canvas);
  sec.appendChild(box);
  return canvas;
}

const empty = (sec, text) => sec.insertAdjacentHTML('beforeend', `<p class="empty">${text}</p>`);

function segControl(key, label, options) {
  return `<div class="seg" role="group" aria-label="${label}"><span class="seg-label">${label}</span><div class="seg-buttons">${
    options.map(([v, text, tip]) => `<button type="button" data-pref="${key}" data-value="${v}" aria-pressed="${state.prefs[key] === v}"${
      tip ? ` title="${tip}"` : ''}>${text}</button>`).join('')}</div></div>`;
}

/* ------------------------------------------------------------------ views */

// One line per cage: mean ± error of `metric`. Points are nudged apart on x so whiskers don't overlap.
function renderGroupChart(root, t, d, id, metric, title) {
  const M = METRICS[metric];
  const what = { pct: '% change from each mouse’s first recorded weight', weight: 'body weight',
    volume: 'longer side × shorter side² / 2', rtv: 'each mouse’s volume ÷ its first measured volume' }[metric];
  const treat = treatMode();
  const shown = shownCages(d);
  const lanes = doseLanes(t, d, shown);
  const left = treat ? d.mice.filter(m => shown.includes(m.cage) && !m.start).length : 0;
  const sub = `${errName() ? `Mean ± ${errName()}` : 'Mean'} of ${effBase() === 'start' && FROM_START[metric] ? FROM_START[metric].what : what}.${
    treat ? ` Day 0 is each mouse’s treatment start.${binDays() > 1 ? ` Days are grouped in ${binDays()}-day steps (measured every ${binDays()} days).` : ''}` : ''}${noStartNote(left)}${
    noBaselineNote(d, metric, d.mice.filter(m => shown.includes(m.cage)))}${bandNote(metric)}${lanes.length ? ` ${DOSE_KEY}.` : ''}`;
  const sec = card(id, title, sub, CHART_TOOLS, { hint: `Click a ${d.unit} in the legend to hide it.` });
  root.appendChild(sec);

  // Points per group or cage: { x, mean, sem, n, date, day } per session, or with x = treatment per day from start.
  const xs = tickXs(d);
  const series = d.groups.map(g => (treat
    ? summarizeByTreatDay(d.mice.filter(m => m.cage === g.cage), metric, binDays())
      .map(b => ({ ...b, x: b.day, tday: b.day, date: b.dates.length === 1 ? b.dates[0] : null }))
    : g[metric].map((p, i) => ({ ...p, x: xs[i], day: d.days[i] }))));
  if (!d.groups.some((g, k) => shown.includes(g.cage) && series[k].some(p => p.n > 0))) {
    empty(sec, M.tumor ? 'No tumor measurements yet.' : 'No measurements yet.');
    return;
  }

  const n = d.groups.length;
  const unit = effX() === 'date' ? DAY : 1;
  const span = xs.length > 1 ? Math.min(...xs.slice(1).map((x, k) => x - xs[k])) : unit;
  const step = Math.min(0.08 * unit, (span * 0.5) / Math.max(n, 1));
  const errKey = state.prefs.error;
  const datasets = d.groups.map((g, k) => {
    const { color, dash } = seriesStyle(t, k);
    const nudge = (k - (n - 1) / 2) * step;
    const pts = series[k];
    const err = errKey === 'none' ? null
      : pts.map(p => (p.sem === null ? null : errKey === 'sd' ? p.sem * Math.sqrt(p.n) : p.sem));
    return {
      label: cageName(d, g.cage), cage: g.cage, hidden: !shown.includes(g.cage),
      data: pts.map((p, i) => ({ x: p.x + nudge, y: p.mean, date: p.date, dates: p.dates, tdays: p.tdays, day: p.day, tday: p.tday, n: p.n, err: err ? err[i] : null })),
      err,
      borderColor: color, backgroundColor: color, borderDash: dash,
      borderWidth: 2, pointRadius: 4, pointHoverRadius: 6, pointBorderColor: t.surface, pointBorderWidth: 1.5,
      spanGaps: true,
    };
  });
  const opts = chartOptions(t, d, metric);
  addDoses(opts, t, d, lanes, [], metric);
  opts.plugins.legend.labels.generateLabels = cageLegend(t, d).generateLabels;
  opts.plugins.legend.onClick = cageLegend(t, d).onClick;
  opts.plugins.tooltip.callbacks.label = c =>
    `${c.dataset.label}: ${M.val(c.raw.y)}${c.raw.err !== null ? ` ± ${M.err(c.raw.err)}` : ''} (n=${c.raw.n})`;
  state.views[id].chart = makeChart(chartBox(sec), { type: 'line', data: { datasets }, options: opts });
  const sd = p => num(p.sem === null ? null : p.sem * Math.sqrt(p.n));
  state.views[id].rows = () => (treat ? [
    [d.unit, 'treatment_day', 'days_included', 'dates', 'mean', 'sem', 'sd', 'n'],
    ...d.groups.flatMap((g, k) => (shown.includes(g.cage) ? series[k] : []).map(p => [
      cageText(d, g.cage), p.tday, p.tdays.join(' '), p.dates.join(' '), num(p.mean), num(p.sem), sd(p), p.n])),
  ] : [
    [d.unit, 'date', 'study_day', 'mean', 'sem', 'sd', 'n'],
    ...d.groups.flatMap((g, k) => (shown.includes(g.cage) ? series[k] : []).map(p => [
      cageText(d, g.cage), p.date, p.day, num(p.mean), num(p.sem), sd(p), p.n])),
  ]);
}

// Dim every line but the hovered (or highlighted) one.
// The end marker (✕) is drawn with the point border, so it takes the line color instead of the ring.
function emphasize(datasets, active) {
  datasets.forEach((ds, i) => {
    const on = active === null || i === active;
    const color = on ? ds.$color : dim(ds.$color);
    const ring = on ? ds.$ring : 'transparent';
    ds.borderColor = ds.backgroundColor = color;
    ds.pointBorderColor = c => (c.raw && c.raw.end ? color : ring);
    ds.borderWidth = active !== null && i === active ? ds.$width + 1.5 : ds.$width;
  });
}

// Point markers on the individual lines: ◆ where the mouse changed cage or tail mark, ✕ at its end.
const markerStyle = c => (c.raw && c.raw.end ? 'crossRot' : c.raw && c.raw.moved ? 'rectRot' : 'circle');
const markerRadius = base => c => (c.raw && c.raw.end ? base + 3.5 : c.raw && c.raw.moved ? base + 1.5 : base);
const markerBorder = c => (c.raw && c.raw.end ? 2.5 : 1);

// One line per mouse. All cages: color = cage. One cage: color = mouse, by its fixed position in the cage,
// and each line is labelled at its end.
function renderMiceChart(root, t, d, id, metric, title) {
  const M = METRICS[metric];
  const treat = treatMode();
  const shown = shownCages(d);
  const inShown = d.mice.filter(m => shown.includes(m.cage));
  const mice = treat ? inShown.filter(m => m.start) : inShown;
  const lanes = doseLanes(t, d, shown);
  const keys = [mice.some(m => m.points.some(p => p.moved)) && '◆ moved cage', mice.some(m => m.ended) && '✕ ended',
    lanes.length && DOSE_KEY].filter(Boolean);
  const sub = `One line per mouse.${treat ? ' Day 0 is each mouse’s treatment start.' : ''}${noStartNote(inShown.length - mice.length)}${
    noBaselineNote(d, metric, mice)}${bandNote(metric)}${
    keys.length ? ` ${keys.join(', ')}.` : ''}`;
  const sec = card(id, title, sub, CHART_TOOLS, { hint: 'Hover to pick out a mouse; click to highlight it everywhere.' });
  root.appendChild(sec);
  const starts = d.hasStarts;
  state.views[id].rows = () => [
    [...idHead(d), 'date', 'study_day', ...(starts ? ['treatment_day'] : []), 'cage_that_day', 'tail_mark_that_day', metric],
    ...mice.flatMap(m => m.points.map(p => [...idVals(d, m), p.date, p.day, ...(starts ? [p.tday] : []), p.cage, p.mark, num(p[metric])])),
  ];
  if (!mice.some(m => m.points.some(p => p[metric] !== null))) {
    empty(sec, M.tumor ? 'No tumor measurements yet.' : 'No measurements yet.');
    return;
  }
  const solo = shown.length === 1;
  const datasets = mice.map(m => {
    const k = solo ? d.mice.filter(x => x.cage === m.cage).indexOf(m) : d.cages.indexOf(m.cage);
    const { color, dash } = seriesStyle(t, k);
    const width = solo ? 2 : 1.5;
    return {
      label: m.id, mouse: m.id, cage: m.cage, $m: m,
      data: m.points.map((p, i) => ({
        x: treat ? p.tday : xv(d, i), y: p[metric], date: p.date, day: p.day, tday: p.tday,
        cage: p.cage, mark: p.mark, moved: p.moved, end: p.end, note: p.note,
      })),
      $color: color, $ring: t.surface, $width: width, borderDash: dash,
      pointStyle: markerStyle, pointRadius: markerRadius(solo ? 3.5 : 2.5), pointHoverRadius: markerRadius(6),
      pointBorderWidth: markerBorder, spanGaps: true,
      endLabel: solo || m.id === state.focus ? m.id : null,
    };
  });
  const focusIndex = () => { const i = datasets.findIndex(ds => ds.mouse === state.focus); return i < 0 ? null : i; };
  emphasize(datasets, focusIndex());

  const opts = chartOptions(t, d, metric);
  addDoses(opts, t, d, lanes, [], metric);
  opts.interaction = { mode: 'nearest', intersect: false };
  if (datasets.some(ds => ds.endLabel)) opts.layout.padding.right = fz(44);
  opts.plugins.tooltip.callbacks.label = c => {
    const where = placeLong(c.raw.cage, c.raw.mark);
    return `Mouse ${c.dataset.label}${where ? ` (${where})` : ''}: ${M.val(c.raw.y)}`;
  };
  opts.plugins.tooltip.callbacks.afterLabel = c => [
    c.raw.moved ? `◆ Moved from ${placeLong(c.raw.moved.cage, c.raw.moved.mark)}` : '',
    c.raw.end ? `✕ ${endText(c.dataset.$m)}` : '',
    c.raw.note ? `Note: ${c.raw.note}` : '',
  ].filter(Boolean);
  if (!solo) {
    opts.plugins.legend.labels.generateLabels = cageLegend(t, d).generateLabels;
    opts.plugins.legend.onClick = cageLegend(t, d).onClick;
  }
  const hover = (chart, i) => {
    if (i === chart.$hover) return;
    chart.$hover = i;
    emphasize(chart.data.datasets, i ?? focusIndex());
    chart.update('none');
  };
  opts.onHover = (e, els, chart) => {
    hover(chart, els.length ? els[0].datasetIndex : null);
    e.native.target.style.cursor = els.length ? 'pointer' : '';
  };
  opts.onClick = (_e, els, chart) => { if (els.length) setFocus(chart.data.datasets[els[0].datasetIndex].mouse, true); };
  const chart = makeChart(chartBox(sec), { type: 'line', data: { datasets }, options: opts });
  chart.canvas.addEventListener('mouseleave', () => hover(chart, null));
  state.views[id].chart = chart;
}

// Latest session, one bar per mouse, colored by cage. Sorted by value (a waterfall) or by mouse.
function renderLatestBars(root, t, d, id, metric, title) {
  const M = METRICS[metric];
  const shown = shownCages(d);
  const all = d.latest.filter(r => shown.includes(r.cage));
  let rows = all.filter(r => r[metric] !== null);
  if (state.prefs.order === 'value') rows = [...rows].sort((a, b) => b[metric] - a[metric]);
  const left = all.length - rows.length;
  const sub = `Latest session, ${fmtDate(ts(d.latestDate), { month: 'short', day: 'numeric', year: 'numeric' })}.`
    + (left ? ` ${left} ${left > 1 ? 'mice' : 'mouse'} not measured then ${left > 1 ? 'are' : 'is'} left out.` : '') + bandNote(metric);
  const order = segControl('order', 'Order', [['value', 'Sorted', 'Largest first'], ['mouse', 'Mouse', 'By cage and mouse']]);
  const sec = card(id, title, sub, CHART_TOOLS, { extra: order, hint: 'Click a bar to highlight the mouse.' });
  root.appendChild(sec);
  state.views[id].rows = () => [[...idHead(d), 'date', metric], ...rows.map(r => [...idVals(d, r), d.latestDate, num(r[metric])])];
  if (!rows.length) {
    empty(sec, M.tumor ? 'No tumor measurements in the latest session.' : 'No measurements in the latest session.');
    return;
  }
  const base = rows.map(r => seriesStyle(t, d.cages.indexOf(r.cage)).color);
  const focused = rows.findIndex(r => r.id === state.focus);
  const opts = chartOptions(t, d, metric);
  opts.interaction = { mode: 'index', axis: 'x', intersect: false };
  opts.scales.x = {
    type: 'category',
    ticks: { color: t.muted, autoSkip: false, maxRotation: 90, minRotation: 0, font: { size: fz(11) } },
    // Chart.js tilts the mouse IDs only as far as their width needs; with many bars the tilted labels still touch,
    // so stand them upright when a bar is narrower than about 1.5 lines of text.
    afterCalculateLabelRotation: axis => {
      const step = (axis.maxWidth || axis.width) / Math.max(axis.ticks.length, 1);
      if (axis.labelRotation > 0 && step < fz(11) * 1.5) axis.labelRotation = 90;
    },
    grid: { display: false },
    border: { color: t.axis },
  };
  opts.plugins.legend.labels.generateLabels = cageLegend(t, d, 'rect').generateLabels;
  opts.plugins.legend.onClick = cageLegend(t, d).onClick;
  opts.plugins.tooltip.callbacks.title = items => (items.length ? `Mouse ${rows[items[0].dataIndex].id}` : '');
  opts.plugins.tooltip.callbacks.label = c => {
    const r = rows[c.dataIndex];
    const where = placeLong(realCage(r), r.mouse);
    return `${M.val(c.raw)} · ${d.unit === 'group' ? `${cageName(d, r.cage)}${where ? `, ${where}` : ''}` : where}`;
  };
  opts.onHover = (e, els) => { e.native.target.style.cursor = els.length ? 'pointer' : ''; };
  opts.onClick = (_e, els) => { if (els.length) setFocus(rows[els[0].index].id, true); };
  const datasets = [{
    label: M.name,
    data: rows.map(r => r[metric]),
    backgroundColor: base.map((c, i) => (focused < 0 || i === focused ? c : dim(c))),
    hoverBackgroundColor: base,
    borderRadius: 4, borderSkipped: 'start', maxBarThickness: 28, categoryPercentage: 0.9, barPercentage: 0.85,
  }];
  state.views[id].chart = makeChart(chartBox(sec), { type: 'bar', data: { labels: rows.map(r => r.id), datasets }, options: opts });
}

const FLAGS = {
  'loss-alert': { cls: 'critical', icon: '⛔', text: 'Lost ≥ 20%', summary: 'lost ≥ 20%' },
  'loss-warning': { cls: 'warning', icon: '⚠', text: 'Lost ≥ 15%', summary: 'lost ≥ 15%' },
  ended: { cls: 'ended', icon: '✕', text: '', summary: 'ended (euthanized, found dead or removed)' },
  missing: { cls: 'missing', icon: '○', text: 'No data since', summary: 'no data in the latest session' },
};
const FLAG_ORDER = ['loss-alert', 'loss-warning', 'ended', 'missing'];
const FLAG_RANK = r => { const k = FLAG_ORDER.findIndex(f => r.flags.includes(f)); return k < 0 ? 0 : FLAG_ORDER.length - k; };
const flagText = (r, f) => (f === 'ended' ? endText(r) : `${FLAGS[f].text}${f === 'missing' ? ` ${fmtDate(ts(r.lastSeen))}` : ''}`);

const TABLE_COLS = [
  { key: 'id', label: 'Mouse' },
  { key: 'where', label: 'Cage · tail' },
  { key: 'weight', label: 'Weight (g)', show: v => fmt(v, 2) },
  { key: 'pct', label: 'Change', show: v => (v === null ? '—' : `${fmtSigned(v)}%`) },
  { key: 'volume', label: 'Tumor vol.', show: v => fmt(v) },
  { key: 'rtv', label: 'Rel. vol.', show: v => (v === null ? '—' : `${fmt(v, 2)}×`) },
  { key: 'flags', label: 'Flags' },
];
// With treatment starts, each mouse's start and its days on treatment at the latest session come after Cage · tail.
const START_COL = { key: 'start', label: 'Start', show: v => (v ? fmtDate(ts(v)) : '—') };
const TDAY_COL = { key: 'tday', label: 'Days treated', show: v => (v === null ? '—' : v) };
const tableCols = d => (d.hasStarts ? [...TABLE_COLS.slice(0, 2), START_COL, TDAY_COL, ...TABLE_COLS.slice(2)] : TABLE_COLS);

function sortRows(d, rows) {
  const { key, dir } = state.prefs.sort;
  const val = r => (key === 'flags' ? FLAG_RANK(r) : key === 'start' ? (r.start ? ts(r.start) : null) : r[key]);
  const pos = r => d.cages.indexOf(r.cage);
  return [...rows].sort((a, b) => {
    if (key === 'id') {
      return dir * (pos(a) - pos(b) || byNatural(realCage(a), realCage(b)) || byNatural(a.mouse, b.mouse) || byNatural(a.id, b.id));
    }
    if (key === 'where') return dir * (byNatural(realCage(a), realCage(b)) || byNatural(a.mouse, b.mouse) || byNatural(a.id, b.id));
    const va = val(a), vb = val(b);
    if (va === null && vb === null) return 0;
    if (va === null) return 1; // not measured: always last
    if (vb === null) return -1;
    return dir * (va - vb) || byNatural(a.id, b.id);
  });
}

const mouseCell = (d, id, cage, ended = '') =>
  `<th scope="row"><span class="dot" style="background:${seriesVar(d.cages.indexOf(cage))}"></span>${escapeHtml(id)}${
    ended ? ` <span class="end-mark" title="${escapeHtml(ended)}" aria-label="${escapeHtml(ended)}">✕</span>` : ''}</th>`;

function renderLatestTable(root, d) {
  const shown = shownCages(d);
  const rows = sortRows(d, d.latest.filter(r => shown.includes(r.cage)));
  const cols = tableCols(d);
  const sub = d.rebased
    ? 'Change and relative volume are from each mouse’s treatment start; the weight-loss flags stay on its first recorded weight.'
    : 'Change is from each mouse’s first recorded weight.';
  const sec = card('table', `Latest values · ${fmtDate(ts(d.latestDate), { month: 'short', day: 'numeric', year: 'numeric' })}`,
    sub, TABLE_TOOLS, { hint: 'Click a column to sort, a row to highlight the mouse.' });
  const counts = {};
  rows.forEach(r => r.flags.forEach(f => { counts[f] = (counts[f] || 0) + 1; }));
  const summary = Object.keys(FLAGS).filter(f => counts[f])
    .map(f => `<span class="flag ${FLAGS[f].cls}">${FLAGS[f].icon} ${counts[f]} ${counts[f] > 1 ? 'mice' : 'mouse'} ${FLAGS[f].summary}</span>`);
  sec.insertAdjacentHTML('beforeend', `<p class="flags-summary">${summary.length ? summary.join(' ') : 'No flags.'}</p>`);

  const { key, dir } = state.prefs.sort;
  const head = cols.map(c => {
    const sort = c.key === key ? (dir === 1 ? 'ascending' : 'descending') : 'none';
    return `<th scope="col" aria-sort="${sort}"><button type="button" data-sort="${c.key}">${c.label}<span class="arrow" aria-hidden="true">${
      c.key === key ? (dir === 1 ? '▲' : '▼') : ''}</span></button></th>`;
  }).join('');
  const body = rows.map(r => {
    const flags = r.flags.map(f => `<span class="flag ${FLAGS[f].cls}">${FLAGS[f].icon} ${escapeHtml(flagText(r, f))}</span>`).join(' ');
    const rowCls = FLAG_ORDER.find(f => r.flags.includes(f));
    const cls = [rowCls ? FLAGS[rowCls].cls : '', r.id === state.focus ? 'focused' : ''].join(' ').trim();
    return `<tr class="${cls}" data-mouse="${escapeHtml(r.id)}" tabindex="0">${mouseCell(d, r.id, r.cage)}<td class="where">${
      escapeHtml(placeText(realCage(r), r.mouse))}</td>${
      cols.slice(2, -1).map(c => `<td>${c.show(r[c.key])}</td>`).join('')}<td>${flags}</td></tr>`;
  }).join('');
  sec.insertAdjacentHTML('beforeend', `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`);
  root.appendChild(sec);
  const starts = d.hasStarts;
  const from = d.rebased ? '_from_start' : '';
  state.views.table.rows = () => [
    [...idHead(d), 'tail_mark', ...(starts ? ['treatment_start', 'days_treated'] : []), 'weight_g', `weight_pct_change${from}`, 'tumor_volume',
      `relative_tumor_volume${from}`, 'last_seen', 'status', 'end_date', 'end_reason', 'flags'],
    ...rows.map(r => [...idVals(d, r), r.mouse, ...(starts ? [r.start, r.tday] : []), num(r.weight), num(r.pct), num(r.volume), num(r.rtv), r.lastSeen,
      r.status, r.endDate, r.endReason, r.flags.join(' ')]),
  ];
}

// Every mouse × every session, colored by value. Weight change uses a diverging scale (red = loss,
// blue = gain, full color at ±20%); the others a sequential blue scale over the cells shown.
function renderHeatmap(root, d) {
  const metric = state.prefs.heat;
  const M = METRICS[metric];
  const shown = shownCages(d);
  const mice = d.mice.filter(m => shown.includes(m.cage));
  const key = metric === 'pct' ? 'Red is weight loss, blue is gain; full color at ±20%.' : 'Darker is larger.';
  const select = `<label class="seg"><span class="seg-label">Show</span><select data-pref-select="heat">${
    PREF_VALUES.heat.map(v => `<option value="${v}"${v === metric ? ' selected' : ''}>${METRICS[v].name}</option>`).join('')}</select></label>`;
  const sec = card('grid', 'All measurements', `${M.name} for every mouse and session. ${key}`, TABLE_TOOLS, { extra: select });

  const vals = mice.flatMap(m => m.points.map(p => p[metric])).filter(v => v !== null);
  const log = M.tumor && state.prefs.scale === 'log';
  const tf = v => (log ? Math.log(v) : v);
  const lo = vals.length ? Math.min(...vals.map(tf)) : 0;
  const hi = vals.length ? Math.max(...vals.map(tf)) : 1;
  const shade = v => {
    if (v === null) return '';
    if (metric === 'pct') {
      const s = Math.min(1, Math.abs(v) / 20);
      return `background:color-mix(in oklab, var(${v < 0 ? '--series-8' : '--series-1'}) ${Math.round(4 + 62 * s)}%, var(--surface))`;
    }
    const s = hi > lo ? (tf(v) - lo) / (hi - lo) : 0.5;
    return `background:color-mix(in oklab, var(--series-1) ${Math.round(4 + 62 * s)}%, var(--surface))`;
  };
  const colLabel = k => (effX() === 'day' ? `Day ${d.days[k]}` : fmtDate(ts(d.dates[k])));
  const head = `<th scope="col">Mouse</th>${d.dates.map((date, k) => `<th scope="col" title="${fmtLongDate(date)}">${colLabel(k)}</th>`).join('')}`;
  let prevCage = null;
  const body = mice.map(m => {
    const cells = m.points.map(p => {
      const v = p[metric];
      const after = m.ended && p.date > m.endDate;
      const cls = [metric === 'pct' && v !== null && v <= LOSS_WARNING ? 'strong' : '', p.moved ? 'moved' : '', after ? 'after-end' : ''].filter(Boolean);
      const text = v === null ? '' : metric === 'pct' ? fmtSigned(v) : v.toFixed(M.digits);
      const what = after ? endText(m) : v === null ? 'not measured' : M.val(v);
      const where = placeLong(p.cage, p.mark);
      const tip = `${m.id}${where ? ` (${where})` : ''} · ${fmtLongDate(p.date)}${p.tday !== null ? ` (treatment day ${p.tday})` : ''}: ${what}${
        p.moved ? ` · moved from ${placeLong(p.moved.cage, p.moved.mark)}` : ''}`;
      return `<td style="${after ? '' : shade(v)}"${cls.length ? ` class="${cls.join(' ')}"` : ''} title="${escapeHtml(tip)}">${text}</td>`;
    }).join('');
    const cls = [m.cage !== prevCage && prevCage !== null ? 'cage-start' : '', m.id === state.focus ? 'focused' : ''].join(' ').trim();
    prevCage = m.cage;
    return `<tr class="${cls}" data-mouse="${escapeHtml(m.id)}" tabindex="0">${mouseCell(d, m.id, m.cage, m.ended ? endText(m) : '')}${cells}</tr>`;
  }).join('');
  sec.insertAdjacentHTML('beforeend', `<div class="table-wrap heat"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`);
  root.appendChild(sec);
  state.views.grid.rows = () => [
    [...idHead(d), ...d.dates],
    ...mice.map(m => [...idVals(d, m), ...m.points.map(p => num(p[metric]))]),
  ];
}

// Every mouse × every injection day (from the Injections sheet), the drug in each cell, tinted by group or cage.
function renderDoses(root, d) {
  if (!d.injectionDates || !d.injectionDates.length) return;
  const shown = shownCages(d);
  const mice = d.mice.filter(m => shown.includes(m.cage));
  const dates = [...new Set(mice.flatMap(m => m.injections.map(i => i.date)))].sort();
  if (!dates.length) return;
  const n = mice.reduce((k, m) => k + m.injections.length, 0);
  const sec = card('doses', 'Injections', `${n} dose${n === 1 ? '' : 's'} on ${dates.length} day${dates.length === 1 ? '' : 's'}, from the Injections sheet.`,
    TABLE_TOOLS, { hint: 'Hover a cell for dose and volume.' });
  const day = date => Math.round((ts(date) - ts(d.dates[0])) / DAY);
  const colLabel = date => (effX() === 'day' ? `Day ${day(date)}` : fmtDate(ts(date)));
  const head = `<th scope="col">Mouse</th>${dates.map(date => `<th scope="col" title="${fmtLongDate(date)}">${colLabel(date)}</th>`).join('')}`;
  let prevCage = null;
  const body = mice.map(m => {
    const tint = `background:color-mix(in oklab, ${seriesVar(d.cages.indexOf(m.cage))} 22%, var(--surface))`;
    const cells = dates.map(date => {
      const given = m.injections.filter(i => i.date === date);
      const after = m.ended && date > m.endDate;
      const what = after ? endText(m) : given.length ? given.map(i => `${doseText(i)}${i.note ? ` (${i.note})` : ''}`).join('; ') : 'no dose';
      const tip = `${m.id} · ${fmtLongDate(date)}: ${what}`;
      return `<td${after ? ' class="after-end"' : ''} style="${given.length ? tint : ''}" title="${escapeHtml(tip)}">${escapeHtml(given.map(i => i.drug).join(' + '))}</td>`;
    }).join('');
    const cls = [m.cage !== prevCage && prevCage !== null ? 'cage-start' : '', m.id === state.focus ? 'focused' : ''].join(' ').trim();
    prevCage = m.cage;
    return `<tr class="${cls}" data-mouse="${escapeHtml(m.id)}" tabindex="0">${mouseCell(d, m.id, m.cage, m.ended ? endText(m) : '')}${cells}</tr>`;
  }).join('');
  sec.insertAdjacentHTML('beforeend', `<div class="table-wrap heat doses"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`);
  root.appendChild(sec);
  state.views.doses.rows = () => [
    [...idHead(d), 'date', 'study_day', 'drug', 'dose', 'volume_ul', 'route', 'note'],
    ...mice.flatMap(m => m.injections.map(i => [...idVals(d, m), i.date, day(i.date), i.drug, i.dose, i.volume, i.route, i.note])),
  ];
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// The injections as month calendars (from the Injections sheet). Each dose is a chip in its group's or cage's color
// with the drug and "mice given / mice in the group"; a dashed chip means only some of them got it. ● = measurement day.
// With a schedule (Regimens Days), doses planned and not given show as dotted chips (red when missed), and ○ marks the
// coming measurement days (Groups sheet cadence) for two weeks past today or the latest session.
// On a phone the cells show only colored dots and the doses are listed under each month, since there is no hover.
function renderDoseCalendar(root, d) {
  const shown = shownCages(d);
  const mice = d.mice.filter(m => shown.includes(m.cage));
  const today = localToday();
  const horizon = addDays([d.latestDate, today].sort().pop(), 13);
  const months = doseCalendar(mice, shown, d.dates, { measure: measureDates(d.cadence, d.latestDate, d.dates[0], horizon) });
  const cells = months.flatMap(mo => mo.weeks.flat()).filter(Boolean);
  const doseDays = cells.filter(c => c.items.length);
  const planDays = cells.filter(c => c.plans.length);
  if (!doseDays.length && !planDays.length && !cells.some(c => c.toMeasure)) return;
  const n = doseDays.reduce((k, c) => k + c.items.reduce((j, it) => j + it.n, 0), 0);
  const missed = planDays.reduce((k, c) => k + c.plans.filter(p => p.status === 'missed').reduce((j, p) => j + p.n, 0), 0);
  const key = [`${n} dose${n === 1 ? '' : 's'} on ${doseDays.length} day${doseDays.length === 1 ? '' : 's'}, colored by ${d.unit}.`,
    'Dashed: only some mice.', planDays.length ? `Dotted: planned${missed ? `; red: ${missed} missed` : ''}.` : '', '● measured.',
    cells.some(c => c.toMeasure) ? '○ to measure.' : ''].filter(Boolean).join(' ');
  const sec = card('dose-calendar', 'Injection calendar', key,
    TABLE_TOOLS, { hint: state.focus ? `Outlined: doses of ${escapeHtml(state.focus)}.` : 'Hover a dose for the dose and volume.' });
  const color = k => seriesVar(d.cages.indexOf(k));
  const tip = it => `${cageName(d, it.key)}: ${doseText(it)} · ${it.n} of ${it.eligible} mice (${it.mice.join(', ')})`;
  const planTip = p => `${p.status === 'missed' ? 'Missed' : 'Planned'} · ${cageName(d, p.key)}: ${doseText(p)} · ${p.n} ${p.n > 1 ? 'mice' : 'mouse'} (${p.mice.join(', ')})`;
  const mine = it => state.focus && it.mice.includes(state.focus);
  const chip = it => `<div class="cal-item${it.n < it.eligible ? ' partial' : ''}${mine(it) ? ' mine' : ''}" style="--c:${
    color(it.key)}" title="${escapeHtml(tip(it))}"><span class="cal-drug">${escapeHtml(it.drug)}</span> <span class="cal-key">${
    escapeHtml(cageText(d, it.key))}</span> <span class="cal-n">${it.n}/${it.eligible}</span></div>`;
  const planChip = p => `<div class="cal-item plan ${p.status}${mine(p) ? ' mine' : ''}" style="--c:${color(p.key)}" title="${
    escapeHtml(planTip(p))}"><span class="cal-drug">${escapeHtml(p.drug)}</span> <span class="cal-key">${escapeHtml(cageText(d, p.key))}</span> <span class="cal-n">${
    p.status === 'missed' ? `${p.n} missed` : p.n}</span></div>`;
  const dot = (k, cls) => `<span class="cal-dot${cls ? ` ${cls}` : ''}" style="--c:${color(k)}"></span>`;
  const byDay = effX() === 'day';
  const cell = c => {
    if (!c) return '<div class="cal-cell blank"></div>';
    const dayNo = Number(c.date.slice(8));
    const study = c.day === null || !c.inRange ? '' : `D${c.day}`;
    const [big, small] = byDay && study ? [study, dayNo] : [dayNo, study];
    const cls = ['cal-cell', c.inRange ? '' : 'out', c.items.length ? 'dosed' : '', c.date === today ? 'today' : '',
      state.focus && [...c.items, ...c.plans].some(mine) ? 'has-focus' : ''].filter(Boolean).join(' ');
    const label = `${fmtLongDate(c.date)}${c.toMeasure ? ', to measure' : ''}${[...c.items.map(tip), ...c.plans.map(planTip)].map(x => `: ${x}`).join(';')}`;
    const mark = c.measured ? '<span class="cal-meas" title="Measured this day" aria-label="measured">●</span>'
      : c.toMeasure ? '<span class="cal-meas" title="Measurement day" aria-label="to measure">○</span>' : '';
    const dots = [...c.items.map(it => dot(it.key, it.n < it.eligible ? 'partial' : '')), ...c.plans.map(p => dot(p.key, `plan ${p.status}`))];
    return `<div class="${cls}" role="group" aria-label="${escapeHtml(label)}"><div class="cal-top"><span class="cal-num">${big}</span>${
      small !== '' ? `<span class="cal-sub">${small}</span>` : ''}${mark}</div>${c.items.map(chip).join('')}${c.plans.map(planChip).join('')}${
      dots.length ? `<div class="cal-dots">${dots.join('')}</div>` : ''}</div>`;
  };
  const agenda = mo => {
    const rows = mo.weeks.flat().filter(c => c && (c.items.length || c.plans.length)).map(c => `<li><strong>${
      fmtDate(ts(c.date), { weekday: 'short', month: 'short', day: 'numeric' })}${c.day === null ? '' : ` · day ${c.day}`}</strong><ul>${
      c.items.map(it => `<li>${dot(it.key, it.n < it.eligible ? 'partial' : '')}${escapeHtml(cageName(d, it.key))}: ${escapeHtml(doseText(it))} · ${it.n}/${it.eligible} mice</li>`).join('')}${
      c.plans.map(p => `<li class="${p.status}">${dot(p.key, `plan ${p.status}`)}${p.status === 'missed' ? 'Missed: ' : 'Planned: '}${escapeHtml(cageName(d, p.key))}: ${
        escapeHtml(doseText(p))} · ${p.mice.map(escapeHtml).join(', ')}</li>`).join('')}</ul></li>`).join('');
    return rows ? `<ul class="cal-agenda">${rows}</ul>` : '';
  };
  const body = months.map(mo => `<div class="cal-month"><h3>${fmtDate(Date.UTC(mo.year, mo.month, 1), { month: 'long', year: 'numeric' })}</h3>`
    + `<div class="cal-grid">${WEEKDAYS.map(w => `<div class="cal-dow">${w}</div>`).join('')}${mo.weeks.flat().map(cell).join('')}</div>${agenda(mo)}</div>`).join('');
  sec.insertAdjacentHTML('beforeend', `<div class="table-wrap cal-wrap">${body}</div>`);
  root.appendChild(sec);
  state.views['dose-calendar'].rows = () => [
    ['date', 'study_day', d.unit, 'status', 'drug', 'dose', 'volume_ul', 'route', 'mice', 'mice_in_group', 'mouse_ids'],
    ...cells.filter(c => c.items.length || c.plans.length).flatMap(c => [
      ...c.items.map(it => [c.date, c.day, cageText(d, it.key), 'given', it.drug, it.dose, it.volume, it.route, it.n, it.eligible, it.mice.join(' ')]),
      ...c.plans.map(p => [c.date, c.day, cageText(d, p.key), p.status, p.drug, p.dose, p.volume, p.route, p.n, '', p.mice.join(' ')]),
    ]),
  ];
}

// What to do on each of the next 7 days from the schedule: measurement days (Groups sheet cadence) and the doses
// planned from each mouse's start (Regimens Days), with the cage and tail mark to find the mouse. Below it, doses
// planned since the latest data that are not entered yet, missed doses and doses off the schedule.
function renderSchedule(root, d) {
  if (!d.hasSchedule) return;
  const shown = shownCages(d);
  const mice = d.mice.filter(m => shown.includes(m.cage));
  const byId = new Map(mice.map(m => [m.id, m]));
  const today = localToday();
  const days = 7;
  const end = addDays(today, days - 1);
  const week = upcomingWork(mice, shown, today, days, measureDates(d.cadence, d.latestDate, today, end));
  const alive = mice.filter(m => !m.ended).length;
  const where = id => { const m = byId.get(id); return m ? placeText(realCage(m), m.mouse) : ''; };
  const mouseList = ids => ids.map(id => `<span class="sched-mouse" data-mouse-ref="${escapeHtml(id)}">${escapeHtml(id)} <span class="where">${escapeHtml(where(id))}</span></span>`).join('');
  const doseLine = x => `<li><span class="cal-dot" style="--c:${seriesVar(d.cages.indexOf(x.key))}"></span><strong>${escapeHtml(cageName(d, x.key))}</strong>: ${
    escapeHtml(doseText(x))} · ${x.mice.length} ${x.mice.length > 1 ? 'mice' : 'mouse'}<div class="sched-mice">${mouseList(x.mice)}</div></li>`;
  const dayBlock = u => `<li class="sched-day${u.date === today ? ' today' : ''}"><h3>${u.date === today ? 'Today, ' : ''}${
    fmtDate(ts(u.date), { weekday: 'short', month: 'short', day: 'numeric' })}</h3><ul>${
    u.measure ? `<li class="sched-measure">○ Weigh and measure tumors · ${alive} mice</li>` : ''}${u.doses.map(doseLine).join('')}${
    !u.measure && !u.doses.length ? '<li class="sched-none">Nothing scheduled</li>' : ''}</ul></li>`;
  const late = mice.flatMap(m => m.planned.filter(p => p.status === 'planned' && p.date < today).map(p => ({ m, p })));
  const missed = mice.flatMap(m => m.planned.filter(p => p.status === 'missed').map(p => ({ m, p })));
  const off = mice.flatMap(m => m.offSchedule.map(i => ({ m, i })));
  const row = (m, date, text) => `<li><strong>${fmtDate(ts(date))}</strong> · ${escapeHtml(m.id)} <span class="where">${
    escapeHtml(placeText(realCage(m), m.mouse))}</span> · ${escapeHtml(text)}</li>`;
  const section = (cls, title, items) => (items.length ? `<div class="sched-list ${cls}"><h3>${title}</h3><ul>${items.join('')}</ul></div>` : '');
  const lists = [
    section('late', `Planned since the latest data (${fmtDate(ts(d.cutoff))}), not entered yet`, late.map(({ m, p }) => row(m, p.date, `${doseText(p)} (day ${p.day})`))),
    section('missed', `Missed: planned, no Injections row`, missed.map(({ m, p }) => row(m, p.date, `${doseText(p)} (day ${p.day})`))),
    section('off', 'Off schedule', off.map(({ m, i }) => row(m, i.date, `${doseText(i)} · ${i.reason === 'no-start'
      ? 'given before the mouse has a treatment start' : `day ${i.day}, not a planned day for ${i.drug}`}`))),
  ].join('');
  const every = d.cadence ? ` Measured every ${d.cadence.every} day${d.cadence.every > 1 ? 's' : ''}.` : '';
  const sub = `The next ${days} days from the schedule: doses from each mouse’s treatment start (Regimens Days).${every}`
    + `${missed.length ? ` ${missed.length} missed dose${missed.length > 1 ? 's' : ''}.` : ''}`;
  const sec = card('schedule', 'Coming up', sub, TABLE_TOOLS, { hint: 'Mice not yet started are not listed.' });
  sec.insertAdjacentHTML('beforeend', `<div class="sched"><ol class="sched-week">${week.map(dayBlock).join('')}</ol>${lists}</div>`);
  root.appendChild(sec);
  const place = id => { const m = byId.get(id); return m ? [realCage(m), m.mouse] : ['', '']; };
  const groupOfKey = k => cageText(d, k);
  state.views.schedule.rows = () => [
    ['date', 'what', d.unit, 'drug', 'dose', 'volume_ul', 'route', 'mouse', 'cage', 'tail_mark', 'treatment_day', 'note'],
    ...week.flatMap(u => [
      ...(u.measure ? [[u.date, 'measure', '', '', '', '', '', '', '', '', '', `${alive} mice`]] : []),
      ...u.doses.flatMap(x => x.mice.map(id => [u.date, 'dose', groupOfKey(x.key), x.drug, x.dose, x.volume, x.route, id, ...place(id),
        daysBetween(byId.get(id).start, u.date), ''])),
    ]),
    ...late.map(({ m, p }) => [p.date, 'not entered', groupOfKey(m.cage), p.drug, p.dose, p.volume, p.route, m.id, realCage(m), m.mouse, p.day, '']),
    ...missed.map(({ m, p }) => [p.date, 'missed', groupOfKey(m.cage), p.drug, p.dose, p.volume, p.route, m.id, realCage(m), m.mouse, p.day, '']),
    ...off.map(({ m, i }) => [i.date, 'off schedule', groupOfKey(m.cage), i.drug, i.dose, i.volume, i.route, m.id, realCage(m), m.mouse, i.day ?? '',
      i.reason === 'no-start' ? 'no treatment start' : 'not a planned day']),
  ];
}

// Kaplan–Meier curve per cage or group: share of mice that have not died or reached a humane endpoint.
function renderSurvival(root, t, d) {
  const treat = treatMode();
  const shown = shownCages(d);
  const curves = treat ? survivalFromStart(d.mice, d.cages, d.latestDate) : survival(d.mice, d.cages, d.dates);
  const ended = d.mice.filter(m => shown.includes(m.cage) && m.ended).length;
  const lanes = doseLanes(t, d, shown);
  const left = treat ? d.mice.filter(m => shown.includes(m.cage) && !(m.start && (!m.ended || m.endDate >= m.start))).length : 0;
  const sub = `Kaplan–Meier. Found dead or euthanized at an endpoint ends the line; euthanized at end of study or removed is censored.${
    ended ? '' : ' No mouse has ended yet.'}${treat ? ' Counted from each mouse’s treatment start.' : ''}${
    left ? ` ${left} ${left > 1 ? 'mice' : 'mouse'} with no treatment start, or ended before it, ${left > 1 ? 'are' : 'is'} left out.` : ''}${
    lanes.length ? ` ${DOSE_KEY}.` : ''}`;
  const sec = card('survival', `Survival by ${d.unit}`, sub, CHART_TOOLS, { hint: `Click a ${d.unit} in the legend to hide it.` });
  root.appendChild(sec);
  state.views.survival.rows = () => (treat ? [
    [d.unit, 'treatment_day', 'surviving_pct', 'at_risk', 'events'],
    ...curves.filter(c => shown.includes(c.key)).flatMap(c => c.points.map(p => [cageText(d, c.key), p.day, num(p.s * 100), p.atRisk, p.events])),
  ] : [
    [d.unit, 'date', 'study_day', 'surviving_pct', 'at_risk', 'events'],
    ...curves.filter(c => shown.includes(c.key)).flatMap(c => c.points.map(p =>
      [cageText(d, c.key), p.date, daysBetween(d.dates[0], p.date), num(p.s * 100), p.atRisk, p.events])),
  ]);
  const n = curves.length;
  const datasets = curves.map((c, k) => {
    const { color, dash } = seriesStyle(t, k);
    const nudge = (k - (n - 1) / 2) * 0.6; // keep overlapping 100% lines apart
    return {
      label: cageName(d, c.key), cage: c.key, hidden: !shown.includes(c.key),
      data: c.points.map(p => (treat
        ? { x: p.day, y: p.s * 100 + nudge, s: p.s, tday: p.day, atRisk: p.atRisk, events: p.events }
        : { x: xOfDate(d, p.date), y: p.s * 100 + nudge, s: p.s, date: p.date, day: daysBetween(d.dates[0], p.date), atRisk: p.atRisk, events: p.events })),
      stepped: true, borderColor: color, backgroundColor: color, borderDash: dash, borderWidth: 2,
      pointRadius: c.points.map(p => (p.events ? 4 : 0)), pointHoverRadius: 5, pointBorderColor: t.surface, pointBorderWidth: 1.5,
    };
  });
  const opts = chartOptions(t, d, 'pct');
  addDoses(opts, t, d, lanes, curves.flatMap(c => c.points.map(p => (treat ? p.day : xOfDate(d, p.date)))));
  opts.scales.y = {
    type: 'linear', min: 0, max: 105,
    title: { display: true, text: 'Surviving (%)', color: t.ink2 },
    ticks: { color: t.muted, stepSize: 20, callback: v => (v <= 100 ? `${v}%` : '') },
    grid: { color: t.grid }, border: { color: t.axis },
  };
  opts.plugins.refLines.lines = [];
  opts.plugins.legend.labels.generateLabels = cageLegend(t, d).generateLabels;
  opts.plugins.legend.onClick = cageLegend(t, d).onClick;
  opts.plugins.tooltip.callbacks.label = c => `${c.dataset.label}: ${fmt(c.raw.s * 100, 0)}% (${c.raw.atRisk} at risk${
    c.raw.events ? `, ${c.raw.events} ended` : ''})`;
  state.views.survival.chart = makeChart(chartBox(sec), { type: 'line', data: { datasets }, options: opts });
}

function renderKpis(d) {
  const box = document.getElementById('kpis');
  if (!d) { box.hidden = true; box.innerHTML = ''; return; }
  const shown = shownCages(d);
  const rows = d.latest.filter(r => shown.includes(r.cage));
  const count = f => rows.filter(r => r.flags.includes(f)).length;
  const tiles = [
    [`Day ${d.days[d.days.length - 1]}`, `latest, ${fmtDate(ts(d.latestDate))}`, ''],
    [rows.length === d.latest.length ? rows.length : `${rows.length} / ${d.latest.length}`, `mice, ${shown.length} ${d.unit}${shown.length > 1 ? 's' : ''}`, ''],
    [count('loss-alert'), '⛔ lost ≥ 20%', 'critical'],
    [count('loss-warning'), '⚠ lost 15–20%', 'warning'],
    [count('ended'), '✕ ended', 'ended'],
    [count('missing'), '○ missing latest', 'missing'],
    ...(d.hasSchedule ? [[d.mice.filter(m => shown.includes(m.cage)).reduce((k, m) => k + m.planned.filter(p => p.status === 'missed').length, 0),
      '✕ missed doses', 'critical']] : []),
  ];
  box.innerHTML = tiles.map(([value, label, cls]) =>
    `<div class="kpi${cls && value ? ` ${cls}` : ''}"><span class="kpi-value">${value}</span><span class="kpi-label">${label}</span></div>`).join('');
  box.hidden = false;
}

/** The chart views by card id, each drawing its card into `root` with theme `t` (also used for slide images). */
function chartRenderers(d) {
  const w = state.prefs.weight;
  const tm = state.prefs.tumor;
  const by = `by ${d.unit}`;
  return {
    'weight-group': (root, t) => renderGroupChart(root, t, d, 'weight-group', w, w === 'pct' ? `Body weight change ${by}` : `Body weight ${by}`),
    'weight-mice': (root, t) => renderMiceChart(root, t, d, 'weight-mice', w, w === 'pct' ? 'Individual body weight change' : 'Individual body weights'),
    'weight-latest': (root, t) => renderLatestBars(root, t, d, 'weight-latest', w, `${w === 'pct' ? 'Weight change' : 'Body weight'} per mouse`),
    'tumor-group': (root, t) => renderGroupChart(root, t, d, 'tumor-group', tm, tm === 'rtv' ? `Relative tumor volume ${by}` : `Tumor volume ${by}`),
    'tumor-mice': (root, t) => renderMiceChart(root, t, d, 'tumor-mice', tm, tm === 'rtv' ? 'Individual relative tumor volumes' : 'Individual tumor volumes'),
    'tumor-latest': (root, t) => renderLatestBars(root, t, d, 'tumor-latest', tm, `${tm === 'rtv' ? 'Relative tumor volume' : 'Tumor volume'} per mouse`),
    survival: (root, t) => renderSurvival(root, t, d),
  };
}

/** Draw every view into #views from state.derived and state.prefs. */
function renderViews() {
  const d = state.derived;
  state.charts.forEach(c => c.destroy());
  state.charts = [];
  state.views = {};
  const root = document.getElementById('views');
  root.innerHTML = '';
  document.body.classList.toggle('has-expanded', Boolean(d && state.expanded));
  renderKpis(d && d.dates.length ? d : null);
  if (!d || !d.dates.length) { renderJump(); return; }
  const t = theme();
  Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", sans-serif';
  Chart.defaults.font.size = state.chartFont = chartFont();
  Chart.defaults.color = t.ink2;
  const charts = chartRenderers(d);
  CHART_IDS.forEach(id => charts[id](root, t));
  renderLatestTable(root, d);
  renderHeatmap(root, d);
  renderSchedule(root, d);
  renderDoseCalendar(root, d);
  renderDoses(root, d);
  renderJump();
  document.querySelectorAll('#views .card-controls').forEach(syncControls);
  setTop();
}

/* ------------------------------------------------------------- jump bar */

// One link per topic, in page order, to the topic's first card present. A topic with no card is left out.
const JUMP = [
  [['weight-group'], 'Weight'],
  [['tumor-group'], 'Tumor'],
  [['survival'], 'Survival'],
  [['table'], 'Latest values'],
  [['grid'], 'All measurements'],
  [['schedule'], 'Coming up'],
  [['dose-calendar', 'doses'], 'Injections'],
];

function renderJump() {
  const nav = document.getElementById('jump');
  if (!nav) return; // an index.html from before the jump bar, still in the offline cache
  const links = JUMP.map(([ids, text]) => [ids.find(id => document.getElementById(id)), text]).filter(([id]) => id);
  nav.hidden = !links.length;
  nav.innerHTML = links.map(([id, text]) => `<a href="#${id}" data-jump="${id}">${text}</a>`).join('');
  updateJump();
}

/** Mark the topic now at the top of the screen. The one last picked wins when it shares a row with that
 *  topic (cards side by side), or when the page is at its end and the picked card is on screen (it can't reach the top). */
function updateJump() {
  const nav = document.getElementById('jump');
  if (!nav || nav.hidden) return;
  const links = [...nav.querySelectorAll('[data-jump]')];
  const navBottom = nav.getBoundingClientRect().bottom;
  const line = navBottom + (innerHeight - navBottom) / 3;
  const tops = links.map(a => document.getElementById(a.dataset.jump).getBoundingClientRect().top);
  let k = 0;
  tops.forEach((top, i) => { if (top <= line && top > tops[k] + 4) k = i; });
  const picked = links.findIndex(a => a.dataset.jump === state.jumpTo);
  const atEnd = scrollY + innerHeight >= document.documentElement.scrollHeight - 2;
  if (picked >= 0 && (Math.abs(tops[picked] - tops[k]) <= 4
      || (atEnd && tops[picked] >= navBottom - 4 && tops[picked] < innerHeight))) k = picked;
  links.forEach((a, i) => (i === k ? a.setAttribute('aria-current', 'location') : a.removeAttribute('aria-current')));
  // Keep the marked link in view when the bar scrolls sideways (phone). Not scrollIntoView: it would stop a smooth page scroll.
  const a = links[k];
  if (a && nav.scrollWidth > nav.clientWidth) {
    const left = a.offsetLeft - nav.offsetLeft;
    if (left < nav.scrollLeft || left + a.offsetWidth > nav.scrollLeft + nav.clientWidth) nav.scrollLeft = left - 16;
  }
}

function jump(id) {
  const target = document.getElementById(id);
  if (!target) return;
  state.jumpTo = id;
  const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  target.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
  updateJump(); // now, in case nothing scrolls (same row, or page end); a smooth scroll updates it as it goes
}

/* ---------------------------------------------------------------- toolbar */

// Toolbar pieces, shared with the full-screen card (which shows only the settings that change it).
function groupByControl(d) {
  const grouped = hasGroups();
  const byOptions = [
    hasStudyGroups() && ['group', 'Group', 'Groups from the Mice sheet of the workbook'],
    ['cage', 'Cage', 'Each mouse’s current cage, with its whole history'],
    grouped && ['mine', 'My groups', 'Your groups, set in the groups panel on this device'],
  ].filter(Boolean);
  return `<div class="seg" role="group" aria-label="Group by"><span class="seg-label">Group by</span>${byOptions.length > 1
    ? `<div class="seg-buttons">${byOptions.map(([v, text, tip]) => `<button type="button" data-pref="by" data-value="${v}" title="${tip}">${text}</button>`).join('')}</div>`
    : ''}<button type="button" class="chip edit" data-groups-open title="Pick mice and sort them into labelled groups, on this device">${grouped ? 'Edit my groups' : 'Make groups'}</button></div>`;
}

function cageChips(d) {
  const u = d.unit;
  const chips = d.cages.map((c, k) => `<button type="button" class="chip" data-cage="${escapeHtml(c)}" title="Show or hide ${
    escapeHtml(cageName(d, c))}. Double-click to show only this ${u}."><span class="dot" style="background:${seriesVar(k)}"></span>${
    escapeHtml(cageText(d, c))}</button>`).join('');
  return `<div class="seg" role="group" aria-label="${u === 'group' ? 'Groups' : 'Cages'}"><span class="seg-label">${u === 'group' ? 'Groups' : 'Cages'}</span><div class="chips">${chips}<button type="button" class="chip all" data-cage-all>All</button></div></div>`;
}

/** The display settings by key, as toolbar controls. `focus` is the Highlight select (id only in the toolbar). */
function prefControls(d, inToolbar = false) {
  const mice = d.cages.map(c => `<optgroup label="${escapeHtml(cageName(d, c))}">${
    d.mice.filter(m => m.cage === c).map(m => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.id)}</option>`).join('')}</optgroup>`).join('');
  return {
    weight: segControl('weight', 'Weight', [['pct', '% change'], ['weight', 'Grams']]),
    tumor: segControl('tumor', 'Tumor', [['volume', 'Volume'], ['rtv', 'Relative', 'Each mouse’s volume ÷ its first measured volume']]),
    scale: segControl('scale', 'Tumor axis', [['linear', 'Linear'], ['log', 'Log']]),
    error: segControl('error', 'Error bars', [['sem', 'SEM'], ['sd', 'SD'], ['none', 'None']]),
    x: segControl('x', 'X axis', [['date', 'Date'], ['day', 'Day', 'Study day: days since the first session'],
      ...(hasStarts() ? [['treat', 'From start', 'Days from each mouse’s treatment start (its own on the Mice sheet, else its group’s); day 0 lines the mice up']] : [])]),
    base: hasStarts() ? segControl('base', 'Change from', [['first', 'First value', 'Weight % change and relative tumor volume from each mouse’s first measurement'],
      ['start', 'Treatment start', 'Weight % change and relative tumor volume from the last value on or before each mouse’s treatment start']]) : '',
    focus: `<label class="seg"><span class="seg-label">Highlight</span><select${inToolbar ? ' id="focus-mouse"' : ''} data-focus-select><option value="">No mouse</option>${mice}</select></label>`,
  };
}

// The settings that change each card, shown with it in full screen. Every card also gets Group by and the chips.
const CARD_CONTROLS = {
  'weight-group': ['weight', 'error', 'x', 'base'],
  'weight-mice': ['weight', 'x', 'base', 'focus'],
  'weight-latest': ['weight', 'base', 'focus'],
  'tumor-group': ['tumor', 'scale', 'error', 'x', 'base'],
  'tumor-mice': ['tumor', 'scale', 'x', 'base', 'focus'],
  'tumor-latest': ['tumor', 'scale', 'base', 'focus'],
  survival: ['x'],
  table: ['base', 'focus'],
  grid: ['base', 'focus'],
  schedule: [],
  'dose-calendar': ['x', 'focus'],
  doses: ['focus'],
};

function cardControls(id) {
  const d = state.derived;
  if (!d || !CARD_CONTROLS[id]) return '';
  const c = prefControls(d);
  return `<div class="card-controls" role="group" aria-label="Settings for this view">${groupByControl(d)}${cageChips(d)}${
    CARD_CONTROLS[id].map(k => c[k]).join('')}</div>`;
}

function renderToolbar(d) {
  const bar = document.getElementById('toolbar');
  const c = prefControls(d, true);
  // On a phone only Group by and the group chips show until "More settings" unfolds the rest (CSS);
  // on wider screens .toolbar-more is display: contents, so its controls sit in the toolbar's own row.
  bar.innerHTML = `
    ${groupByControl(d)}
    ${cageChips(d)}
    <button type="button" class="chip more" data-more-settings aria-controls="toolbar-more">More settings</button>
    <div class="toolbar-more" id="toolbar-more">
    ${c.weight}
    ${c.tumor}
    ${c.scale}
    ${c.error}
    ${c.x}
    ${c.base}
    ${c.focus}
    <div class="seg"><span class="seg-label">Theme</span><button type="button" class="chip" data-pref="theme" data-cycle title="Switch between following the device, light and dark"></button></div>
    <details class="menu seg"><summary class="chip">Export</summary><div class="menu-list" role="group" aria-label="Export">
      <button type="button" data-export="slide" title="Body weight and tumor volume by ${d.unit}, side by side, as a 16:9 slide image">Slide: weight + tumor</button>
      <button type="button" data-export="png" title="All the charts in one PNG image">Dashboard image</button>
      <button type="button" data-export="csv" title="Every measurement and derived value as CSV, one row per mouse per session">All data (CSV)</button>
      <button type="button" data-export="print" title="Print, or save as PDF">Print</button></div></details>
    </div>`;
  bar.hidden = false;
  syncToolbar();
}

function syncToolbar() {
  syncControls(document.getElementById('toolbar'));
  document.querySelectorAll('.card-controls').forEach(syncControls);
}

/** Pressed states, chips and the Highlight select of a set of controls (the toolbar or a full-screen card's). */
function syncControls(bar) {
  const d = state.derived;
  if (!d || !bar) return;
  const shown = shownCages(d);
  const current = key => (key === 'by' ? effectiveBy() : key === 'x' ? effX() : key === 'base' ? effBase() : state.prefs[key]);
  bar.querySelectorAll('[data-pref]:not([data-cycle])').forEach(b => b.setAttribute('aria-pressed', String(current(b.dataset.pref) === b.dataset.value)));
  // Theme: one button that steps through the choices, naming the current one.
  bar.querySelectorAll('[data-cycle]').forEach(b => {
    const vals = PREF_VALUES[b.dataset.pref];
    const now = state.prefs[b.dataset.pref];
    b.dataset.value = vals[(vals.indexOf(now) + 1) % vals.length];
    b.textContent = { auto: 'Auto', light: 'Light', dark: 'Dark' }[now] || now;
  });
  bar.querySelectorAll('[data-cage]').forEach(b => b.setAttribute('aria-pressed', String(shown.includes(b.dataset.cage))));
  const all = bar.querySelector('[data-cage-all]');
  if (all) all.setAttribute('aria-pressed', String(shown.length === d.cages.length));
  bar.querySelectorAll('[data-focus-select]').forEach(sel => { sel.value = state.focus || ''; });
  bar.classList.toggle('open', state.moreSettings);
  const more = bar.querySelector('[data-more-settings]');
  if (more) {
    more.setAttribute('aria-expanded', String(state.moreSettings));
    more.textContent = state.moreSettings ? 'Fewer settings' : 'More settings';
  }
}

function setPref(key, value) {
  if (!PREF_VALUES[key] || !PREF_VALUES[key].includes(value)) return;
  state.prefs[key] = value;
  savePrefs();
  if (key === 'theme') applyTheme();
  if (key === 'by' || key === 'base') { refresh(); return; }
  syncToolbar();
  renderViews();
}

const hasStudyGroups = () => Boolean(state.base && state.base.mice.some(m => m.group));

/** What the views are grouped by: the saved choice if it is available, else workbook groups, else cage. */
function effectiveBy() {
  const p = state.prefs.by;
  if (p === 'cage' || (p === 'group' && hasStudyGroups()) || (p === 'mine' && hasGroups())) return p;
  if (p === 'group' && hasGroups()) return 'mine'; // "group" meant the device's groups before the workbook
  return hasStudyGroups() ? 'group' : 'cage';
}

/** The view data: by current cage, or re-keyed by the workbook's groups or the user's own; from treatment start if set. */
function viewData() {
  const by = effectiveBy();
  const base = effBase() === 'start' ? rebase(state.base) : state.base;
  if (by === 'group') return applyGroups(base, studyGrouping(base));
  if (by === 'mine') return applyGroups(base, state.grouping);
  return base;
}

/** Rebuild the view data and redraw the toolbar, views and groups panel. */
function refresh() {
  if (!state.base) return;
  state.derived = viewData();
  renderToolbar(state.derived);
  renderViews();
  renderGroupPanel();
}

function setHidden(hidden) {
  state.prefs[hiddenKey(state.derived)] = hidden;
  savePrefs();
  syncToolbar();
  renderViews();
}

function toggleCage(cage) {
  const d = state.derived;
  const shown = shownCages(d);
  let next = shown.includes(cage) ? shown.filter(c => c !== cage) : [...shown, cage];
  if (!next.length) next = d.cages; // hiding the last cage shows them all again
  setHidden(d.cages.filter(c => !next.includes(c)));
}

function setFocus(id, toggle = false) {
  state.focus = toggle && state.focus === id ? null : (id || null);
  syncToolbar();
  renderViews();
}

function applyTheme() {
  const root = document.documentElement;
  if (state.prefs.theme === 'auto') delete root.dataset.theme; else root.dataset.theme = state.prefs.theme;
}

/* ----------------------------------------------------------------- groups panel */
// Tick mice, then move them into a group or spread them evenly across the groups. Saved on this device,
// per note name, so choosing an updated copy of the note keeps the groups.

const groupsKey = name => `in-vivo-plots:groups:${name}`;
const hasGroups = () => state.grouping.groups.length > 0;

function loadGrouping(name) {
  try { return cleanGrouping(JSON.parse(store.get(groupsKey(name)) || 'null')); } catch { return cleanGrouping(null); }
}

/** Change the grouping, save it and redraw. The first groups made switch the charts to them. */
function updateGrouping(change) {
  const had = hasGroups();
  change(state.grouping);
  state.grouping = cleanGrouping(state.grouping);
  if (hasGroups()) store.set(groupsKey(state.name), JSON.stringify(state.grouping));
  else store.remove(groupsKey(state.name));
  if (!had && hasGroups()) { state.prefs.by = 'mine'; savePrefs(); }
  refresh();
}

function addGroup() {
  updateGrouping(g => {
    let n = 1;
    while (g.groups.some(x => x.id === `g${n}`)) n++;
    g.groups.push({ id: `g${n}`, label: `Group ${g.groups.length + 1}` });
  });
}

function deleteGroup(id) {
  const n = Object.values(state.grouping.assign).filter(g => g === id).length;
  if (n && !confirm(`Delete “${groupLabel(state.grouping, id)}”? Its ${n} ${n > 1 ? 'mice' : 'mouse'} will be in no group.`)) return;
  updateGrouping(g => { g.groups = g.groups.filter(x => x.id !== id); });
}

function moveSelected(gid) {
  const ids = [...state.selected];
  if (!ids.length) { toast('Tick some mice first.'); return; }
  updateGrouping(g => ids.forEach(id => { if (gid === UNGROUPED) delete g.assign[id]; else g.assign[id] = gid; }));
}

function spreadSelected(by) {
  const ids = state.selected;
  if (!ids.size) { toast('Tick some mice first.'); return; }
  if (state.grouping.groups.length < 2) { toast('Add at least two groups first.'); return; }
  const rows = state.base.latest.filter(r => ids.has(r.id));
  const out = distribute(rows, state.grouping.groups.map(g => g.id), by);
  updateGrouping(g => Object.assign(g.assign, out));
  toast(`${rows.length} mice spread across ${state.grouping.groups.length} groups${by === 'random' ? ' at random' : `, balanced by ${by === 'volume' ? 'tumor volume' : 'body weight'}`}. Click again to re-roll.`);
}

const SELECT_RULES = {
  all: () => true,
  none: () => false,
  tumor: r => r.volume > 0,
  ungrouped: r => groupOf(state.grouping, r.id) === UNGROUPED,
};

// Mice that have ended are never ticked by a rule (they can still be ticked by hand).
function selectWhere(rule) {
  state.selected = new Set(state.base.latest.filter(r => !r.flags.includes('ended') && rule(r)).map(r => r.id));
  renderGroupPanel();
}

/** Latest values of the grouped mice, by group, for copying out. */
function groupRows() {
  const g = state.grouping;
  const pos = id => g.groups.findIndex(x => x.id === id);
  const rows = state.base.latest.filter(r => groupOf(g, r.id) !== UNGROUPED)
    .sort((a, b) => pos(groupOf(g, a.id)) - pos(groupOf(g, b.id)) || byNatural(a.cage, b.cage) || byNatural(a.mouse, b.mouse));
  return [
    ['group', 'mouse', 'cage', 'weight_g', 'weight_pct_change', 'tumor_volume'],
    ...rows.map(r => [groupLabel(g, groupOf(g, r.id)), r.id, r.cage, num(r.weight), num(r.pct), num(r.volume)]),
  ];
}

/** Mouse ID and group for the workbook's Mice sheet: in that sheet's order, then any mice not on it. */
function workbookGroupRows() {
  const g = state.grouping;
  const order = ((state.parsed && state.parsed.mice) || []).map(m => m.id);
  const ids = [...order, ...state.base.mice.map(m => m.id).filter(id => !order.includes(id))];
  return [['Mouse ID', 'Group'], ...ids.map(id => { const gid = groupOf(g, id); return [id, gid === UNGROUPED ? '' : groupLabel(g, gid)]; })];
}

// For pasting into the Obsidian note. The columns differ from a session table, so the parser ignores it.
function groupMarkdown() {
  const rows = groupRows().slice(1);
  const cell = s => String(s ?? '').replace(/\|/g, '\\|');
  return [
    `Groups set ${state.base.latestDate} (latest values from that session):`, '',
    '| Group | Mouse | Weight (g) | Change (%) | Tumor volume |', '|---|---|---:|---:|---:|',
    ...rows.map(([group, mouse, , w, pct, vol]) => `| ${cell(group)} | ${mouse} | ${fmt(w, 2)} | ${fmtSigned(pct)} | ${fmt(vol)} |`),
  ].join('\n');
}

async function copyText(text, done) {
  try { await navigator.clipboard.writeText(text); toast(done); } catch (e) { toast(`Couldn’t copy here (${e.message || e}).`); }
}

const meanSem = (vals, show) => {
  const s = summarize(vals);
  if (!s.n) return '—';
  return s.sem === null ? show(s.mean) : `${show(s.mean)} <span class="pm">± ${show(s.sem).replace(/^[+−]/, '')}</span>`;
};

function renderGroupPanel() {
  const box = document.getElementById('group-panel');
  if (!box) return; // an old cached index.html
  const open = Boolean(state.panel && state.base);
  document.body.classList.toggle('panel-open', open);
  if (!open) { box.hidden = true; box.innerHTML = ''; return; }

  // Keep the mouse list's scroll position and the focused control across the redraw.
  const wrap = box.querySelector('.gp-mice .table-wrap');
  const scroll = wrap ? wrap.scrollTop : 0;
  const a = document.activeElement;
  const focusSel = a && box.contains(a) ? ['data-gp', 'data-move', 'data-spread', 'data-pick', 'data-del', 'data-assign', 'data-sel']
    .filter(k => a.hasAttribute(k)).map(k => `[${k}="${CSS.escape(a.getAttribute(k))}"]`)[0] : null;

  const d = state.base;
  const g = state.grouping;
  const of = id => groupOf(g, id);
  const color = gid => seriesVar(gid === UNGROUPED ? g.groups.length : g.groups.findIndex(x => x.id === gid));
  const dot = gid => `<span class="dot" style="background:${color(gid)}"></span>`;
  const sel = state.selected;
  const date = fmtDate(ts(d.latestDate), { month: 'short', day: 'numeric', year: 'numeric' });

  const keys = [...g.groups.map(x => x.id), UNGROUPED];
  const summary = keys.map((gid, k) => {
    const members = d.latest.filter(r => of(r.id) === gid);
    if (gid === UNGROUPED && !members.length) return '';
    const label = gid === UNGROUPED ? `<span class="gp-none">${dot(gid)}Not grouped</span>`
      : `${dot(gid)}<input type="text" class="gp-label" data-label="${gid}" value="${escapeHtml(g.groups[k].label)}" placeholder="Group ${k + 1}" aria-label="Name of group ${k + 1}" maxlength="60">`;
    return `<tr><th scope="row">${label}</th><td>${members.length}</td>`
      + `<td>${meanSem(members.map(r => r.volume), v => fmt(v))}</td>`
      + `<td>${meanSem(members.map(r => r.weight), v => fmt(v, 2))}</td>`
      + `<td>${meanSem(members.map(r => r.pct), v => `${fmtSigned(v)}%`)}</td>`
      + `<td>${gid === UNGROUPED ? '' : `<button type="button" class="tool" data-del="${gid}" title="Delete group" aria-label="Delete group ${escapeHtml(groupLabel(g, gid))}">×</button>`}</td></tr>`;
  }).join('');

  let rows = [...d.latest];
  if (state.panelSort === 'volume') rows.sort((x, y) => (y.volume ?? -1) - (x.volume ?? -1) || byNatural(x.id, y.id));
  if (state.panelSort === 'group') rows.sort((x, y) => keys.indexOf(of(x.id)) - keys.indexOf(of(y.id)) || byNatural(x.cage, y.cage) || byNatural(x.mouse, y.mouse));
  const options = gid => [...g.groups.map(x => x.id), UNGROUPED].map(id =>
    `<option value="${id}"${id === gid ? ' selected' : ''}>${escapeHtml(groupLabel(g, id))}</option>`).join('');
  const body = rows.map(r => {
    const gid = of(r.id);
    return `<tr class="${sel.has(r.id) ? 'picked' : ''}"><td class="gp-check"><input type="checkbox" data-sel="${escapeHtml(r.id)}"${sel.has(r.id) ? ' checked' : ''} aria-label="Select mouse ${escapeHtml(r.id)}"></td>`
      + `<th scope="row">${escapeHtml(r.id)}${r.flags.includes('ended') ? ` <span class="end-mark" title="${escapeHtml(endText(r))}">✕</span>` : ''}</th><td class="where">${
        escapeHtml(placeText(r.cage, r.mouse))}</td><td>${fmt(r.weight, 2)}</td><td>${r.pct === null ? '—' : `${fmtSigned(r.pct)}%`}</td><td>${fmt(r.volume)}</td>`
      + `<td class="gp-group">${dot(gid)}<select data-assign="${escapeHtml(r.id)}" aria-label="Group of mouse ${escapeHtml(r.id)}">${options(gid)}</select></td></tr>`;
  }).join('');

  const groupsReady = g.groups.length > 0;
  const moveTo = [...g.groups.map(x => x.id), UNGROUPED].map(gid =>
    `<button type="button" class="chip" data-move="${gid}" title="Put the ticked mice in ${escapeHtml(groupLabel(g, gid))}">${dot(gid)}<span class="lbl">${escapeHtml(groupLabel(g, gid))}</span></button>`).join('');
  const n = sel.size;

  box.innerHTML = `
    <div class="gp-head">
      <div class="titles"><h2 id="group-panel-title">Groups</h2>
        <p class="sub">Tick mice, then put them in a group or spread them across the groups. Saved on this device for this file.</p></div>
      <button type="button" class="tool" data-gp="close" title="Close (Esc)" aria-label="Close">${icon('collapse')}</button>
    </div>
    <div class="gp-body">
      <section class="gp-groups" aria-label="Groups">
        <div class="table-wrap"><table>
          <thead><tr><th scope="col">Group</th><th scope="col">Mice</th><th scope="col" title="Mean ± SEM, ${date}">Tumor vol.</th><th scope="col" title="Mean ± SEM, ${date}">Weight (g)</th><th scope="col" title="Mean ± SEM of % change from first weight, ${date}">Change</th><th></th></tr></thead>
          <tbody>${summary || ''}</tbody></table></div>
        ${groupsReady ? '' : '<p class="empty">No groups yet. Add one for each cage or treatment arm, then name it.</p>'}
        <p class="gp-note">Mean ± SEM at the latest session, ${date}. Compare the groups to check they are balanced.</p>
        <div class="gp-actions">
          <button type="button" class="button small primary" data-gp="add">+ Add group</button>
          ${groupsReady ? `<button type="button" class="button small" data-gp="copy" title="Group, mouse and latest values as a table for Excel or Prism">Copy table</button>
          <button type="button" class="button small" data-gp="workbook" title="Mouse ID and group, in the order of the workbook’s Mice sheet">Copy for workbook</button>
          <button type="button" class="button small" data-gp="markdown" title="A Markdown table to paste into the note">Copy for note</button>
          <button type="button" class="button small" data-gp="csv">CSV</button>
          <button type="button" class="button small quiet" data-gp="clear">Delete all groups</button>` : ''}
        </div>
      </section>
      <section class="gp-mice" aria-label="Mice">
        <div class="gp-row"><span class="seg-label">Tick</span>
          <div class="seg-buttons">
            <button type="button" data-pick="all">All</button><button type="button" data-pick="none">None</button>
            <button type="button" data-pick="tumor" title="Mice with a tumor measured in the latest session">With a tumor</button>
            <button type="button" data-pick="ungrouped">Not grouped</button></div>
          <label class="gp-min">Tumor vol. ≥ <input type="number" min="0" step="any" inputmode="decimal" data-min value="${escapeHtml(state.minVolume ?? '')}" aria-label="Minimum tumor volume"></label>
          <button type="button" class="button small" data-pick="min">Tick</button>
          <span class="gp-count" aria-live="polite">${n} of ${d.latest.length} ticked</span>
        </div>
        <div class="gp-row"><span class="seg-label">Put ticked in</span><div class="chips">${groupsReady ? moveTo : '<span class="hint">Add a group first.</span>'}</div></div>
        <div class="gp-row"><span class="seg-label">Spread ticked evenly, balanced by</span>
          <div class="seg-buttons">
            <button type="button" data-spread="volume" title="Rank by latest tumor volume; each run of mice goes one to each group, in random order">Tumor volume</button>
            <button type="button" data-spread="weight" title="Rank by latest body weight; each run of mice goes one to each group, in random order">Body weight</button>
            <button type="button" data-spread="random">Random</button></div>
        </div>
        <div class="gp-row"><span class="seg-label">Sort</span>${segPanelSort()}</div>
        <div class="table-wrap"><table>
          <thead><tr><th></th><th scope="col">Mouse</th><th scope="col">Cage · tail</th><th scope="col">Weight (g)</th><th scope="col">Change</th><th scope="col">Tumor vol.</th><th scope="col">Group</th></tr></thead>
          <tbody>${body}</tbody></table></div>
      </section>
    </div>`;
  box.hidden = false;
  box.querySelectorAll('[data-spread], [data-move]').forEach(b => { b.disabled = !n || (b.dataset.spread !== undefined && g.groups.length < 2); });

  const nw = box.querySelector('.gp-mice .table-wrap');
  if (nw) nw.scrollTop = scroll;
  const f = focusSel && box.querySelector(focusSel);
  if (f) f.focus();
}

const segPanelSort = () => `<div class="seg-buttons">${[['mouse', 'Mouse'], ['volume', 'Tumor vol.'], ['group', 'Group']].map(([v, text]) =>
  `<button type="button" data-gp="sort-${v}" aria-pressed="${state.panelSort === v}">${text}</button>`).join('')}</div>`;

function openGroupPanel(open) {
  state.panel = open;
  // Closing redraws the dashboard too: a name typed and not yet committed (Escape straight away) still shows.
  if (open) renderGroupPanel(); else refresh();
  if (open) { const first = document.querySelector('#group-panel [data-gp="close"]'); if (first) first.focus(); }
  else { const btn = document.querySelector('[data-groups-open]'); if (btn) btn.focus(); }
}

function panelClick(el) {
  const ds = el.dataset;
  if (ds.gp === 'close') openGroupPanel(false);
  else if (ds.gp === 'add') addGroup();
  else if (ds.gp === 'clear') {
    if (confirm('Delete all groups? The mice stay in the note; only the grouping is removed.')) updateGrouping(g => { g.groups = []; g.assign = {}; });
  } else if (ds.gp === 'copy') copyText(toTsv(groupRows()), 'Groups copied. Paste them into Excel, Sheets or Prism.');
  else if (ds.gp === 'workbook') copyText(toTsv(workbookGroupRows()), 'Mouse ID and group copied, in the Mice sheet’s order. Paste them into the workbook, or give them to Claude.');
  else if (ds.gp === 'markdown') copyText(groupMarkdown(), 'Groups copied as Markdown. Paste them into the note, under their own heading.');
  else if (ds.gp === 'csv') download(new Blob([toCsv(groupRows())], { type: 'text/csv' }), fileName('groups', 'csv'));
  else if (ds.gp && ds.gp.startsWith('sort-')) { state.panelSort = ds.gp.slice(5); renderGroupPanel(); }
  else if (ds.del) deleteGroup(ds.del);
  else if (ds.move) moveSelected(ds.move);
  else if (ds.spread) spreadSelected(ds.spread);
  else if (ds.pick === 'min') {
    const v = parseFloat(state.minVolume);
    if (!Number.isFinite(v)) { toast('Type a tumor volume first.'); return; }
    selectWhere(r => r.volume !== null && r.volume >= v);
  } else if (ds.pick) selectWhere(SELECT_RULES[ds.pick]);
}

function panelChange(e) {
  const t = e.target;
  if (t.dataset.sel !== undefined) {
    if (t.checked) state.selected.add(t.dataset.sel); else state.selected.delete(t.dataset.sel);
    renderGroupPanel();
  } else if (t.dataset.assign !== undefined) {
    updateGrouping(g => { if (t.value === UNGROUPED) delete g.assign[t.dataset.assign]; else g.assign[t.dataset.assign] = t.value; });
  } else if (t.dataset.label !== undefined) {
    // Saved on every keystroke (panelInput); redraw the charts once the name is done.
    refreshKeepFocus();
  }
}

// While a name is typed: save it and update the panel's own labels, without redrawing the input.
function panelInput(e) {
  const t = e.target;
  if (t.dataset.min !== undefined) { state.minVolume = t.value; return; }
  if (t.dataset.label === undefined) return;
  const grp = state.grouping.groups.find(x => x.id === t.dataset.label);
  if (!grp) return;
  grp.label = t.value;
  store.set(groupsKey(state.name), JSON.stringify(state.grouping));
  const text = groupLabel(state.grouping, grp.id);
  document.querySelectorAll(`#group-panel [data-move="${grp.id}"] .lbl, #group-panel option[value="${grp.id}"]`).forEach(x => { x.textContent = text; });
}

// Redraw the dashboard behind the panel but leave the panel (and whatever has focus in it) alone.
function refreshKeepFocus() {
  state.derived = viewData();
  renderToolbar(state.derived);
  renderViews();
}

/* ----------------------------------------------------------------- export */

const num = v => (v === null || v === undefined ? null : +v.toFixed(4));
const csvCell = v => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = rows => `${rows.map(r => r.map(csvCell).join(',')).join('\n')}\n`;
const toTsv = rows => rows.map(r => r.map(v => (v === null || v === undefined ? '' : String(v))).join('\t')).join('\n');

function fileName(what, ext) {
  const base = (state.name || 'study').replace(/\.(md|xlsx)$/i, '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${base}-${what}-${state.derived.latestDate}.${ext}`;
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let toastTimer = null;
function toast(text) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

const canvasBlob = canvas => new Promise((resolve, reject) =>
  canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Could not make the image'))), 'image/png'));

/**
 * A chart as a figure: title, subtitle, the chart and a source line on the card color, at `scale`× pixels.
 * The chart is redrawn at that pixel ratio for the copy, then put back.
 */
function chartFigure(id, scale = 3) {
  const view = state.views[id];
  const chart = view.chart;
  const t = theme();
  const prev = chart.options.devicePixelRatio;
  chart.options.devicePixelRatio = scale;
  chart.resize();
  try {
    const W = chart.width;
    const H = chart.height;
    const pad = 16;
    const sub = view.subtitle ? 20 : 0;
    const top = pad + 22 + sub + 6;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round((W + 2 * pad) * scale);
    canvas.height = Math.round((top + H + 22 + pad / 2) * scale);
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.fillStyle = t.surface;
    ctx.fillRect(0, 0, W + 2 * pad, top + H + 22 + pad);
    ctx.textBaseline = 'top';
    ctx.fillStyle = t.ink;
    ctx.font = '600 16px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.fillText(view.title, pad, pad, W);
    if (sub) {
      ctx.fillStyle = t.ink2;
      ctx.font = '13px system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.fillText(view.subtitle, pad, pad + 24, W);
    }
    ctx.drawImage(chart.canvas, pad, top, W, H);
    ctx.fillStyle = t.muted;
    ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.fillText(`${state.name} · exported ${new Date().toLocaleDateString(undefined, { dateStyle: 'medium' })}`, pad, top + H + 6, W);
    return canvas;
  } finally {
    chart.options.devicePixelRatio = prev;
    chart.resize();
  }
}

const CHART_IDS = ['weight-group', 'weight-mice', 'weight-latest', 'tumor-group', 'tumor-mice', 'tumor-latest', 'survival'];

/** Every chart in one image, three per row: weight on top, tumor below. */
function dashboardFigure(scale = 2) {
  const t = theme();
  const figs = CHART_IDS.filter(id => state.views[id] && state.views[id].chart).map(id => chartFigure(id, scale));
  const cols = figs.length > 4 ? 3 : 2;
  const rows = Math.ceil(figs.length / cols);
  const cw = Math.max(...figs.map(f => f.width));
  const ch = Math.max(...figs.map(f => f.height));
  const gap = 12 * scale;
  const head = 44 * scale;
  const canvas = document.createElement('canvas');
  canvas.width = cols * cw + (cols + 1) * gap;
  canvas.height = head + rows * ch + rows * gap;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = t.page;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = t.ink;
  ctx.textBaseline = 'middle';
  ctx.font = `600 ${18 * scale}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  const d = state.derived;
  ctx.fillText(`${state.name} · ${d.dates.length} sessions to ${fmtDate(ts(d.latestDate), { month: 'short', day: 'numeric', year: 'numeric' })} (day ${d.days[d.days.length - 1]})`, gap, head / 2 + gap / 2);
  figs.forEach((f, i) => {
    ctx.drawImage(f, gap + (i % cols) * (cw + gap), head + Math.floor(i / cols) * (ch + gap));
  });
  return canvas;
}

/* ---------------------------------------------------------- slide images */
// Charts drawn for a 16:9 slide (13.33 × 7.5 in), whatever the screen: each chart is drawn again off screen at a fixed
// size in px at 96 per inch, with text SLIDE_FONT px (about 15 pt on the slide) and thicker lines, at SLIDE_SCALE× (240
// dpi). The PNG says 240 dpi, so PowerPoint places it at that size. `pair` puts the weight and tumor charts side by side.
const SLIDE_SIZES = {
  content: { w: 1184, h: 528, label: 'Under a title', tip: 'The area under a slide title, 12.3 × 5.5 in' },
  full: { w: 1280, h: 720, label: 'Full slide', tip: 'The whole slide, 13.3 × 7.5 in' },
  half: { w: 576, h: 528, label: 'Half', tip: 'Half the area under a slide title (two charts side by side), 6 × 5.5 in' },
  pair: { w: 1184, h: 528, label: 'Two charts', tip: 'Weight and tumor side by side (survival: tumor and survival), under a slide title' },
};
// Where each size sits on the slide (px at 96 per inch), for the preview.
const SLIDE_PLACE = { content: [48, 144], full: [0, 0], half: [48, 144], pair: [48, 144] };
const SLIDE_FONT = 20;
const SLIDE_SCALE = 2.5;
const SLIDE_DPI = 96 * SLIDE_SCALE;
const SLIDE_PAIR = { 'weight-group': 'tumor-group', 'weight-mice': 'tumor-mice', 'weight-latest': 'tumor-latest', survival: 'tumor-group' };
// The Export menu's weight + tumor slide opens the dialog at "Two charts" without changing the saved size, so the
// charts' quick copy keeps the size last picked in the dialog.
const slideSize = () => (state.slide && state.slide.size) || state.prefs.slideSize;
const slideOpts = (dialog = false) => ({
  size: dialog ? slideSize() : state.prefs.slideSize, bg: state.prefs.slideBg, title: state.prefs.slideTitle === 'on',
});

/** The charts on the slide: just `id`, or for `pair` it and its counterpart, weight (or tumor, before survival) first. */
function slideIds(id, size) {
  const other = SLIDE_PAIR[id] || Object.keys(SLIDE_PAIR).find(k => SLIDE_PAIR[k] === id);
  const has = k => Boolean(state.views[k] && state.views[k].chart);
  if (size !== 'pair' || !other || !has(other)) return [id];
  return id.startsWith('weight') ? [id, other] : [other, id];
}

/** Theme colors of `name` (light or dark), whatever the page shows. No paint happens in between, so nothing flickers. */
function themeFor(name) {
  const root = document.documentElement;
  const prev = root.dataset.theme;
  root.dataset.theme = name;
  try { return theme(); } finally { if (prev === undefined) delete root.dataset.theme; else root.dataset.theme = prev; }
}

/** Thicker lines and markers for a slide: scale each dataset's sizes (numbers, arrays or functions) by k. */
function thicken(chart, k) {
  for (const ds of chart.data.datasets) {
    for (const key of ['borderWidth', '$width', 'pointRadius', 'pointHoverRadius', 'pointBorderWidth', 'maxBarThickness']) {
      const v = ds[key];
      if (typeof v === 'number') ds[key] = v * k;
      else if (Array.isArray(v)) ds[key] = v.map(x => x * k);
      else if (typeof v === 'function') ds[key] = (...a) => v(...a) * k;
    }
  }
}

/** Draw chart `id` off screen at w × h with theme t and slide text sizes; its pixels at SLIDE_SCALE×, or null. */
function renderOffscreen(id, w, h, t) {
  const host = document.createElement('div');
  host.className = 'export-host';
  host.style.width = `${w}px`;
  host.style.setProperty('--h', `${h}px`);
  document.body.appendChild(host);
  const saved = { views: state.views, charts: state.charts, expanded: state.expanded, size: Chart.defaults.font.size, color: Chart.defaults.color };
  state.views = {};
  state.charts = [];
  state.expanded = null;
  Chart.defaults.font.size = SLIDE_FONT;
  Chart.defaults.color = t.ink2;
  try {
    chartRenderers(state.derived)[id](host, t);
    const view = state.views[id];
    if (!view || !view.chart) return null;
    const chart = view.chart;
    thicken(chart, 1.5);
    chart.options.devicePixelRatio = SLIDE_SCALE;
    chart.resize(w, h);
    chart.update('none');
    const out = document.createElement('canvas');
    out.width = chart.canvas.width;
    out.height = chart.canvas.height;
    out.getContext('2d').drawImage(chart.canvas, 0, 0);
    return { canvas: out, title: view.title, w, h };
  } finally {
    state.charts.forEach(c => c.destroy());
    state.views = saved.views;
    state.charts = saved.charts;
    state.expanded = saved.expanded;
    Chart.defaults.font.size = saved.size;
    Chart.defaults.color = saved.color;
    host.remove();
  }
}

/** The slide image of chart `id`: { size, bg: light | dark | none, title: chart title and source line on the image }. */
function slideFigure(id, { size, bg, title }) {
  const S = SLIDE_SIZES[size] || SLIDE_SIZES.content;
  const t = themeFor(bg === 'dark' ? 'dark' : 'light');
  const ids = slideIds(id, size);
  const gap = 32;
  const head = title ? 52 : 0;
  const foot = title ? 26 : 0;
  const cw = Math.floor((S.w - gap * (ids.length - 1)) / ids.length);
  const figs = ids.map(k => renderOffscreen(k, cw, S.h - head - foot, t)).filter(Boolean);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(S.w * SLIDE_SCALE);
  canvas.height = Math.round(S.h * SLIDE_SCALE);
  const ctx = canvas.getContext('2d');
  ctx.scale(SLIDE_SCALE, SLIDE_SCALE);
  if (bg !== 'none') {
    ctx.fillStyle = bg === 'dark' ? t.surface : '#ffffff';
    ctx.fillRect(0, 0, S.w, S.h);
  }
  ctx.textBaseline = 'top';
  figs.forEach((f, i) => {
    const x = i * (cw + gap);
    if (title) {
      ctx.fillStyle = t.ink;
      ctx.font = `600 26px system-ui, -apple-system, "Segoe UI", sans-serif`;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(f.title, x + 12, 36, cw - 24);
      ctx.textBaseline = 'top';
    }
    ctx.drawImage(f.canvas, x, head, f.w, f.h);
  });
  if (title) {
    ctx.fillStyle = t.muted;
    ctx.font = '14px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.fillText(`${state.name} · exported ${new Date().toLocaleDateString(undefined, { dateStyle: 'medium' })}`, 12, S.h - foot + 6, S.w - 24);
  }
  return canvas;
}

// PNG with a pHYs chunk (pixels per metre), so slide software places it at its physical size.
const CRC_TABLE = (() => {
  const tb = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; tb[n] = c >>> 0; }
  return tb;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
async function pngAtDpi(canvas, dpi) {
  const png = new Uint8Array(await (await canvasBlob(canvas)).arrayBuffer());
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  const v = new DataView(chunk.buffer);
  v.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  v.setUint32(8, ppm);
  v.setUint32(12, ppm);
  chunk[16] = 1; // unit: metre
  v.setUint32(17, crc32(chunk.subarray(4, 17)));
  const at = 33; // after the signature (8 bytes) and IHDR (25)
  return new Blob([png.subarray(0, at), chunk, png.subarray(at)], { type: 'image/png' });
}
const slidePng = (id, o = slideOpts()) => pngAtDpi(slideFigure(id, o), SLIDE_DPI);

/* The slide dialog: size, background and title, a preview on a 16:9 slide, copy or download. */
function openSlide(id, size) {
  state.slide = { id, from: document.activeElement, size: PREF_VALUES.slideSize.includes(size) ? size : null };
  renderSlidePanel();
  const close = document.querySelector('#slide-panel [data-slide-close]');
  if (close) close.focus();
}

function closeSlide() {
  const from = state.slide && state.slide.from;
  state.slide = null;
  renderSlidePanel();
  if (from && from.isConnected) from.focus();
}

function renderSlidePanel() {
  let el = document.getElementById('slide-panel');
  if (!el) {
    el = document.createElement('div');
    el.id = 'slide-panel';
    el.className = 'slide-panel';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'slide-panel-title');
    document.body.appendChild(el);
  }
  const s = state.slide;
  document.body.classList.toggle('slide-open', Boolean(s));
  if (!s || !state.derived || !state.views[s.id]) { el.hidden = true; el.innerHTML = ''; return; }
  const p = { ...state.prefs, slideSize: slideSize() };
  const seg = (key, label, options) => `<div class="seg" role="group" aria-label="${label}"><span class="seg-label">${label}</span><div class="seg-buttons">${
    options.map(([v, text, tip]) => `<button type="button" data-slide-pref="${key}" data-value="${v}" aria-pressed="${p[key] === v}"${
      tip ? ` title="${tip}"` : ''}>${text}</button>`).join('')}</div></div>`;
  const ids = slideIds(s.id, p.slideSize);
  const S = SLIDE_SIZES[p.slideSize];
  const [x, y] = SLIDE_PLACE[p.slideSize];
  const pct = (a, b) => `${((a / b) * 100).toFixed(3)}%`;
  el.innerHTML = `<div class="gp-head"><div class="titles"><h2 id="slide-panel-title">Slide image</h2><p class="sub">${
    escapeHtml(ids.map(k => state.views[k].title).join(' + '))}. Drawn for a 16:9 slide with text about 15 pt. The downloaded PNG inserts into PowerPoint at the size shown; a pasted copy keeps its shape but may need resizing.</p></div>
    <button type="button" class="tool" data-slide-close title="Close (Esc)" aria-label="Close">${icon('close')}</button></div>
    <div class="sp-opts">${seg('slideSize', 'Size', Object.entries(SLIDE_SIZES).map(([k, v]) => [k, v.label, v.tip]))}${
    seg('slideBg', 'Background', [['light', 'White'], ['dark', 'Dark'], ['none', 'None', 'Transparent, for a slide with its own background (dark text)']])}${
    seg('slideTitle', 'Title', [['off', 'Off', 'The slide’s own title says what this is'], ['on', 'On', 'The chart title on the image, and the file name and date at the bottom']])}</div>
    <div class="sp-stage"><div class="sp-slide${p.slideBg === 'dark' ? ' dark' : ''}">${
    p.slideSize === 'full' ? '' : '<div class="sp-title">Slide title</div>'}<img alt="Preview of the slide image" style="left:${pct(x, 1280)};top:${
    pct(y, 720)};width:${pct(S.w, 1280)};height:${pct(S.h, 720)}"></div></div>
    <div class="gp-actions"><button type="button" class="button primary small" data-slide-do="copy">Copy image</button>
    <button type="button" class="button small" data-slide-do="png">Download PNG</button>
    <span class="gp-note">${(S.w / 96).toFixed(1)} × ${(S.h / 96).toFixed(1)} in, ${Math.round(S.w * SLIDE_SCALE)} × ${Math.round(S.h * SLIDE_SCALE)} px</span></div>`;
  el.hidden = false;
  try {
    el.querySelector('img').src = slideFigure(s.id, slideOpts(true)).toDataURL('image/png');
  } catch (e) {
    toast(`Couldn’t draw the slide (${e.message || e}).`);
  }
}

async function slideClick(el) {
  if (el.dataset.slideClose !== undefined) { closeSlide(); return; }
  if (el.dataset.slidePref) {
    const { slidePref: key, value } = el.dataset;
    if (!PREF_VALUES[key].includes(value)) return;
    state.prefs[key] = value;
    if (key === 'slideSize') state.slide.size = null;
    savePrefs();
    renderSlidePanel();
    const again = document.querySelector(`#slide-panel [data-slide-pref="${key}"][data-value="${value}"]`);
    if (again) again.focus();
    return;
  }
  const { id } = state.slide;
  const o = slideOpts(true);
  const name = fileName(`${slideIds(id, o.size).join('+')}-slide`, 'png');
  try {
    if (el.dataset.slideDo === 'copy') await copyImage(slidePng(id, o), name, 'Slide image copied. Paste it into PowerPoint.');
    else if (el.dataset.slideDo === 'png') download(await slidePng(id, o), name);
  } catch (e) {
    toast(`Couldn’t do that here (${e.message || e}).`);
  }
}

/** Long ("tidy") table of every measurement and derived value. */
function allDataRows() {
  const d = state.base;
  const mine = hasGroups() ? [m => { const id = groupOf(state.grouping, m.id); return id === UNGROUPED ? '' : groupLabel(state.grouping, id); }] : [];
  const study = hasStudyGroups();
  const starts = d.hasStarts;
  return [
    ['mouse', 'current_cage', 'current_tail_mark', ...(study ? ['group'] : []), ...(mine.length ? ['my_group'] : []),
      ...(starts ? ['treatment_start'] : []), 'status', 'end_date', 'end_reason', 'date', 'study_day', ...(starts ? ['treatment_day'] : []),
      'cage', 'tail_mark', 'weight_g', 'weight_pct_change', ...(starts ? ['weight_pct_change_from_start'] : []),
      'tumor_length', 'tumor_breadth', 'tumor_volume', 'relative_tumor_volume', ...(starts ? ['relative_tumor_volume_from_start'] : []), 'note'],
    ...d.mice.flatMap(m => m.points.map(p => [m.id, m.cage, m.mouse, ...(study ? [m.group] : []), ...mine.map(f => f(m)),
      ...(starts ? [m.start] : []), m.status, m.endDate, m.endReason, p.date, p.day, ...(starts ? [p.tday] : []),
      p.cage, p.mark, p.weight, num(p.pct), ...(starts ? [num(p.pctStart)] : []),
      p.length, p.breadth, num(p.volume), num(p.rtv), ...(starts ? [num(p.rtvStart)] : []), p.note])),
  ];
}

/** Copy a PNG (a canvas, or a promise of a PNG blob) to the clipboard; download it where that isn't possible. */
async function copyImage(image, name, done = 'Image copied. Paste it into a slide or document.') {
  const blob = image instanceof HTMLCanvasElement ? canvasBlob(image) : image;
  try {
    if (!navigator.clipboard || typeof ClipboardItem === 'undefined') throw new Error('unsupported');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast(done);
  } catch {
    download(await blob, name);
    toast('This browser can’t copy images, so the PNG was downloaded instead.');
  }
}

async function runTool(id, tool) {
  const view = state.views[id];
  if (!view) return;
  try {
    if (tool === 'expand') {
      state.expanded = state.expanded === id ? null : id;
      renderViews();
      const btn = document.querySelector(`#${id} [data-tool="expand"]`);
      if (btn) btn.focus();
    } else if (tool === 'csv') {
      download(new Blob([toCsv(view.rows())], { type: 'text/csv' }), fileName(id, 'csv'));
    } else if (tool === 'tsv') {
      await navigator.clipboard.writeText(toTsv(view.rows()));
      toast('Table copied. Paste it into Excel, Sheets or Prism.');
    } else if (tool === 'slide' && view.chart) {
      openSlide(id);
    } else if (tool === 'png' && view.chart) {
      download(await canvasBlob(chartFigure(id)), fileName(id, 'png'));
    } else if (tool === 'copy' && view.chart) {
      const o = slideOpts();
      await copyImage(slidePng(id, o), fileName(`${id}-slide`, 'png'),
        `Copied for a slide (${SLIDE_SIZES[o.size].label.toLowerCase()}). Paste it into PowerPoint; the slide button changes the size.`);
    } else {
      toast('Nothing to export in this view yet.');
    }
  } catch (e) {
    toast(`Couldn’t do that here (${e.message || e}).`);
  }
}

async function runExport(kind) {
  if (!state.derived) return;
  if (kind === 'slide') {
    const id = ['weight-group', 'tumor-group'].find(k => state.views[k] && state.views[k].chart);
    if (id) openSlide(id, 'pair'); else toast('No charts to put on a slide yet.');
  } else if (kind === 'png') download(await canvasBlob(dashboardFigure()), fileName('dashboard', 'png'));
  else if (kind === 'csv') download(new Blob([toCsv(allDataRows())], { type: 'text/csv' }), fileName('data', 'csv'));
  else if (kind === 'print') window.print();
}

/* ------------------------------------------------------------------- app */

function renderWarnings(warnings) {
  const box = document.getElementById('warnings');
  if (!warnings.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  const open = warnings.length <= 3 && !window.matchMedia('(min-width: 1000px)').matches;
  box.innerHTML = `<details${open ? ' open' : ''}><summary>${warnings.length} problem${warnings.length > 1 ? 's' : ''} reading the file</summary><ul>${
    warnings.map(w => `<li><span class="ln">${escapeHtml(w.where || `Line ${w.line}`)}</span> ${escapeHtml(w.message)}</li>`).join('')}</ul></details>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function setStatus(html) {
  const el = document.getElementById('status');
  el.innerHTML = html;
  el.title = el.textContent;
}

/** Derive and draw parse output. Returns false (and draws nothing) if there are no sessions. */
function show(parsed, name, savedAt) {
  renderWarnings(parsed.warnings);
  if (!parsed.sessions.length) {
    state.derived = state.base = state.parsed = null;
    state.panel = false;
    renderGroupPanel();
    document.getElementById('toolbar').hidden = true;
    renderViews();
    setStatus(/\.xlsx$/i.test(name)
      ? `<strong>${escapeHtml(name)}</strong> has no measurements. The Measurements sheet needs a header row (Date, Cage or Cage ID, Tail mark, Mouse ID or Animal ID, Weight (g), Tumor Length, Tumor Breadth) and one row per mouse per session.`
      : `<strong>${escapeHtml(name)}</strong> has no measurement sessions. Each session starts with a heading like <code>## 2026-11-05</code> followed by the measurement table.`);
    return false;
  }
  const derived = derive(parsed, { today: localToday() });
  if (name !== state.name) state.selected = new Set();
  state.base = derived;
  state.parsed = parsed;
  state.name = name;
  state.grouping = loadGrouping(name);
  if (!derived.mice.some(m => m.id === state.focus)) state.focus = null;
  refresh();
  const when = savedAt ? ` · loaded ${new Date(savedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : '';
  setStatus(`<strong>${escapeHtml(name)}</strong> · ${parsed.sessions.length} session${parsed.sessions.length > 1 ? 's' : ''}, ${derived.mice.length} mice${when}`);
  document.getElementById('forget').hidden = false;
  return true;
}

/** Draw and remember parse output. A workbook is remembered parsed; a note as its text. */
function load(parsed, name, keep) {
  const savedAt = Date.now();
  if (show(parsed, name, savedAt) && !store.set(STORE_NOTE, JSON.stringify({ name, ...keep, savedAt }))) {
    document.getElementById('status').insertAdjacentHTML('beforeend', ' · <em>not remembered (storage unavailable)</em>');
  }
}

const loadText = (text, name) => load(parseNote(text), name, { text });

// SheetJS (vendor/xlsx.mini.min.js, ~280 kB) is only fetched when a workbook is opened.
let xlsxLib = null;
function loadXlsxLib() {
  if (typeof XLSX !== 'undefined') return Promise.resolve(XLSX); // eslint-disable-line no-undef
  xlsxLib = xlsxLib || new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/xlsx.mini.min.js';
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => { xlsxLib = null; reject(new Error('could not load the workbook reader')); };
    document.head.appendChild(s);
  });
  return xlsxLib;
}

async function loadWorkbook(bytes, name) {
  const lib = await loadXlsxLib();
  const parsed = parseWorkbook(readWorkbookSheets(lib, bytes));
  load(parsed, name, { parsed });
}

/** A chosen file: a workbook (zip, starts with "PK") or a Markdown note. */
async function loadFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) await loadWorkbook(bytes, file.name);
  else loadText(new TextDecoder().decode(bytes), file.name);
}

// Charts take their height from the space left under the header (CSS var --top), so the two
// chart rows fit on one desktop screen.
// offsetTop is layout-only (no scroll position), so it is right whenever it is read.
function setTop() {
  const views = document.getElementById('views');
  let top = 0;
  for (let el = views; el; el = el.offsetParent) top += el.offsetTop;
  document.documentElement.style.setProperty('--top', `${Math.round(top)}px`);
}

function trackTop() {
  const set = setTop;
  set();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(set);
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(set);
    ro.observe(document.querySelector('header'));
    const nav = document.getElementById('jump');
    if (nav) ro.observe(nav);
  }
  window.addEventListener('resize', set);
  // Chart text grows on big screens: redraw when a resize crosses a size step.
  let pending = 0;
  window.addEventListener('resize', () => {
    clearTimeout(pending);
    pending = setTimeout(() => { if (state.derived && chartFont() !== state.chartFont) renderViews(); }, 200);
  });
}

function init() {
  applyTheme();
  const input = document.getElementById('note-file');
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    if (!file) return;
    input.value = '';
    if (file.size > 10 * 1024 * 1024) { setStatus(`<strong>${escapeHtml(file.name)}</strong> is too large to be a study file.`); return; }
    loadFile(file).catch(e => setStatus(`Could not read <strong>${escapeHtml(file.name)}</strong> (${escapeHtml(e.message || e)}).`));
  });

  document.getElementById('demo').addEventListener('click', async () => {
    try {
      const res = await fetch('demo/synthetic-demo.xlsx');
      if (!res.ok) throw new Error(String(res.status));
      await loadWorkbook(new Uint8Array(await res.arrayBuffer()), 'Synthetic demo.xlsx');
    } catch {
      setStatus('Could not load the demo workbook.');
    }
  });

  document.getElementById('forget').addEventListener('click', () => {
    store.remove(STORE_NOTE);
    store.remove(groupsKey(state.name));
    state.derived = state.base = state.parsed = null;
    state.grouping = { groups: [], assign: {} };
    state.selected = new Set();
    state.panel = false;
    renderGroupPanel();
    state.focus = null;
    state.expanded = null;
    state.slide = null;
    renderSlidePanel();
    document.getElementById('toolbar').hidden = true;
    renderViews();
    renderWarnings([]);
    document.getElementById('forget').hidden = true;
    setStatus('File and its groups forgotten on this device. Choose a file to plot it.');
  });

  // One click handler for the toolbar and every card.
  document.addEventListener('click', e => {
    // Close an open menu (Export) on any click outside it, or on a choice in it.
    document.querySelectorAll('details.menu[open]').forEach(m => {
      if (!m.contains(e.target) || e.target.closest('.menu-list button')) m.removeAttribute('open');
    });
    const el = e.target.closest('button, tr[data-mouse]');
    if (!el || !state.derived) return;
    if (el.closest('#group-panel')) { panelClick(el); return; }
    if (el.closest('#slide-panel')) { slideClick(el); return; }
    if (el.dataset.groupsOpen !== undefined) { openGroupPanel(true); return; }
    if (el.dataset.moreSettings !== undefined) { state.moreSettings = !state.moreSettings; syncToolbar(); return; }
    if (el.dataset.pref) setPref(el.dataset.pref, el.dataset.value);
    else if (el.dataset.cage !== undefined) toggleCage(el.dataset.cage);
    else if (el.dataset.cageAll !== undefined) setHidden([]);
    else if (el.dataset.export) runExport(el.dataset.export);
    else if (el.dataset.tool) runTool(el.closest('section').id, el.dataset.tool);
    else if (el.dataset.sort) {
      const s = state.prefs.sort;
      state.prefs.sort = { key: el.dataset.sort, dir: s.key === el.dataset.sort ? -s.dir : 1 };
      savePrefs();
      renderViews();
      const btn = document.querySelector(`#table [data-sort="${el.dataset.sort}"]`);
      if (btn) btn.focus();
    } else if (el.dataset.mouse) setFocus(el.dataset.mouse, true);
  });
  document.addEventListener('dblclick', e => {
    const chip = e.target.closest('[data-cage]');
    if (chip && state.derived) setHidden(state.derived.cages.filter(c => c !== chip.dataset.cage));
  });
  document.addEventListener('change', e => {
    if (e.target.closest && e.target.closest('#group-panel')) { panelChange(e); return; }
    if (e.target.dataset.focusSelect !== undefined) setFocus(e.target.value);
    else if (e.target.dataset.prefSelect) setPref(e.target.dataset.prefSelect, e.target.value);
  });
  document.addEventListener('input', e => { if (e.target.closest && e.target.closest('#group-panel')) panelInput(e); });
  document.addEventListener('keydown', e => {
    if (state.panel && e.target.closest && e.target.closest('#group-panel') && e.key === 'Enter') {
      if (e.target.dataset.label !== undefined) { e.preventDefault(); e.target.blur(); return; }
      if (e.target.dataset.min !== undefined) { e.preventDefault(); panelClick({ dataset: { pick: 'min' } }); return; }
    }
    if (e.key === 'Escape' && state.slide) { closeSlide(); return; }
    if (e.key === 'Escape' && state.panel) { openGroupPanel(false); return; }
    if (e.key === 'Escape' && state.expanded) { runTool(state.expanded, 'expand'); return; }
    const row = e.target.closest && e.target.closest('tr[data-mouse]');
    if (row && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      const id = row.dataset.mouse;
      const table = row.closest('section').id;
      setFocus(id, true);
      const again = document.querySelector(`#${table} tr[data-mouse="${CSS.escape(id)}"]`);
      if (again) again.focus();
    }
  });

  // Charts don't follow CSS: redraw when the color scheme changes.
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const redraw = () => { if (state.derived && state.prefs.theme === 'auto') renderViews(); };
  if (mq.addEventListener) mq.addEventListener('change', redraw); else if (mq.addListener) mq.addListener(redraw);
  // Fit the charts to the printed page and back.
  const fit = () => state.charts.forEach(c => c.resize());
  window.addEventListener('beforeprint', fit);
  window.addEventListener('afterprint', fit);
  trackTop();

  // Jump bar: scroll to a topic, and mark the topic in view while scrolling.
  const jumpBar = document.getElementById('jump');
  if (jumpBar) jumpBar.addEventListener('click', e => {
    const a = e.target.closest('[data-jump]');
    if (!a) return;
    e.preventDefault();
    jump(a.dataset.jump);
  });
  let spy = 0;
  const onScroll = () => { if (!spy) spy = requestAnimationFrame(() => { spy = 0; updateJump(); }); };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);

  let saved = null;
  try { saved = JSON.parse(store.get(STORE_NOTE) || 'null'); } catch { saved = null; }
  const savedParse = saved && (saved.parsed && Array.isArray(saved.parsed.sessions) ? saved.parsed
    : typeof saved.text === 'string' ? parseNote(saved.text) : null);
  if (!(savedParse && show(savedParse, saved.name || 'Saved file', saved.savedAt))) {
    setStatus('Choose your study workbook (.xlsx) or experiment note (.md) to plot it. It is read on this device and never uploaded.');
  }

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline support unavailable */ });
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
}

if (typeof module === 'object' && module.exports) {
  module.exports = {
    parseNote, parseWorkbook, readWorkbookSheets, derive, summarize, tumorVolume, cleanGrouping, applyGroups, distribute, groupLabel,
    studyGrouping, survival, dosesByKey, doseCalendar, UNGROUPED, rebase, summarizeByTreatDay, survivalFromStart, dosesByTreatDay,
    measureDates, upcomingWork, addDays,
  };
}
