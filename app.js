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
const MICE_COLUMNS = {
  mouseid: 'id', animalid: 'id', sex: 'sex', group: 'group', status: 'status', enddate: 'endDate', endreason: 'endReason', notes: 'notes', note: 'notes',
};
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
 *           mice: [{ id, sex, group, status, endDate, endReason, notes }], warnings: [{ where, message }] }.
 */
function parseWorkbook(sheets) {
  const warnings = [];
  const warn = (where, message) => warnings.push({ where, message });
  const meas = pickSheet(sheets, /^measurements?$/i, MEASURE_COLUMNS, ['date', 'id']);
  if (!meas) {
    warn('Workbook', 'No Measurements sheet: it needs a header row with at least Date and Mouse ID columns.');
    return { sessions: [], mice: [], warnings };
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
  return { sessions, mice: roster, warnings };
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
 */
function derive(parsed) {
  const dates = parsed.sessions.map(s => s.date);
  const days = dates.map(date => Math.round((ts(date) - ts(dates[0])) / DAY));
  const dayOf = date => Math.round((ts(date) - ts(dates[0])) / DAY);
  const latestDate = dates[dates.length - 1] ?? null;
  const roster = new Map((parsed.mice || []).map(m => [m.id, m]));
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
    const seen = m.points.filter(p => p.weight !== null || p.length !== null || p.breadth !== null);
    m.lastSeen = seen.length ? seen[seen.length - 1].date : null;
    if (m.ended) {
      // The end marker goes on the last point drawn on or before the end date.
      const last = [...m.points].reverse().find(p => p.date <= m.endDate && (p.weight !== null || p.volume !== null));
      if (last) last.end = true;
    }
    delete m.byDate;
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
      lastSeen: m.lastSeen, flags,
      group: m.group, status: m.status, endDate: m.endDate, endDay: m.endDay, endReason: m.endReason,
    };
  });

  // Workbook groups in the order they first appear on the Mice sheet.
  const groupNames = [...new Set([...(parsed.mice || []).map(m => m.group), ...mice.map(m => m.group)].filter(Boolean))];
  return { unit: 'cage', dates, days, latestDate, mice, cages, groups, latest, groupNames, hasRoster: roster.size > 0 };
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

/** Per-group mean ± SEM of every metric at every session. `keys` are the values of m.cage, in display order. */
function summarizeGroups(mice, keys, dates) {
  return keys.map(cage => {
    const members = mice.filter(m => m.cage === cage);
    const series = metric => dates.map((date, k) => ({ date, ...summarize(members.map(m => m.points[k][metric])) }));
    return {
      cage, mice: members.map(m => m.id),
      pct: series('pct'), weight: series('weight'), volume: series('volume'), rtv: series('rtv'),
    };
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
const fmtLongDate = iso => fmtDate(ts(iso), { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const fmt = (v, digits = 1) => (v === null || v === undefined ? '—' : v.toFixed(digits));
const fmtSigned = (v, digits = 1) => (v === null || v === undefined ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(digits));

// Display settings: allowed values, the first is the default. Saved per device.
const PREF_VALUES = {
  weight: ['pct', 'weight'],     // body weight as % change or grams
  tumor: ['volume', 'rtv'],      // tumor volume, or relative to each mouse's first measured volume
  scale: ['linear', 'log'],      // tumor y axis
  error: ['sem', 'sd', 'none'],  // whiskers on the per-cage charts
  x: ['date', 'day'],            // x axis: calendar date or study day
  theme: ['auto', 'light', 'dark'],
  order: ['value', 'mouse'],     // per-mouse bar charts
  heat: ['pct', 'weight', 'volume', 'rtv'],
  // Aggregate and color by the workbook's groups, the current cage, or the user's own groups (this device).
  // Falls back when the chosen one isn't there (see effectiveBy).
  by: ['group', 'cage', 'mine'],
};
const SORT_KEYS = ['id', 'where', 'weight', 'pct', 'volume', 'rtv', 'flags'];

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
    grid: v('--grid'), axis: v('--axis'), warning: v('--warning'), critical: v('--critical'),
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
const xv = (d, k) => (state.prefs.x === 'day' ? d.days[k] : ts(d.dates[k]));
const errName = () => ({ sem: 'SEM', sd: 'SD', none: '' }[state.prefs.error]);

/* ---------------------------------------------------------- chart plugins */

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
      ctx.lineWidth = 1.5;
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
        ctx.moveTo(pt.x - 4, top); ctx.lineTo(pt.x + 4, top);
        ctx.moveTo(pt.x - 4, bottom); ctx.lineTo(pt.x + 4, bottom);
        ctx.stroke();
      });
      ctx.restore();
    });
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
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(a.left, py); ctx.lineTo(a.right, py); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = opts.labelColor;
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText(l.label, a.right - 4, py - 3);
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
      labels.push({ x: pt.x + 8, y: pt.y, text: ds.endLabel });
    });
    labels.sort((a, b) => a.y - b.y);
    for (let i = 1; i < labels.length; i++) labels[i].y = Math.max(labels[i].y, labels[i - 1].y + 12);
    ctx.save();
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.fillStyle = opts.color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (const l of labels) ctx.fillText(l.text, l.x, l.y);
    ctx.restore();
  },
};

/* --------------------------------------------------------- chart options */

// x of any date (an end date can fall between sessions).
const xOfDate = (d, date) => (state.prefs.x === 'day' ? Math.round((ts(date) - ts(d.dates[0])) / DAY) : ts(date));

function xScale(t, d, extraDates = []) {
  const day = state.prefs.x === 'day';
  const xs = d.dates.map((_, k) => xv(d, k));
  const all = [...xs, ...extraDates.map(date => xOfDate(d, date))];
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const unit = day ? 1 : DAY;
  const pad = Math.max(0.4 * unit, (hi - lo) * 0.03);
  return {
    type: 'linear',
    min: lo - pad,
    max: hi + pad,
    afterBuildTicks: axis => { axis.ticks = xs.map(value => ({ value })); },
    ticks: { color: t.muted, maxRotation: 0, autoSkip: true, callback: v => (day ? `Day ${v}` : fmtDate(v)) },
    grid: { color: t.grid },
    border: { color: t.axis },
  };
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
    title: { display: true, text: M.axis, color: t.ink2 },
    ticks: { color: t.muted, callback: log ? logTick(M) : v => M.tick(v) },
    grid: { color: t.grid },
    border: { color: t.axis },
  };
  if (metric === 'pct') { y.suggestedMin = -22; y.suggestedMax = 5; }
  if (M.tumor && !log) y.beginAtZero = true;
  return y;
}

function chartOptions(t, d, metric) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'nearest', axis: 'xy', intersect: false },
    layout: { padding: { right: 8 } },
    scales: { x: xScale(t, d), y: yScale(t, metric) },
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
          title: items => (items.length && items[0].raw.date ? `${fmtLongDate(items[0].raw.date)} · Day ${items[0].raw.day}` : ''),
        },
      },
      refLines: {
        labelColor: t.ink2,
        lines: metric === 'pct' ? [
          { y: LOSS_WARNING, color: t.warning, label: '−15%' },
          { y: LOSS_ALERT, color: t.critical, label: '−20%' },
        ] : [],
      },
      endLabels: { color: t.ink2 },
    },
  };
}

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
  const chart = new Chart(canvas, { ...config, plugins: [errBars, refLines, endLabels] });
  state.charts.push(chart);
  return chart;
}

/* ------------------------------------------------------------------ cards */

const ICONS = {
  png: '<path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5v-1h-8v8h1"/>',
  csv: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M2.5 6.5h11M2.5 9.75h11M6.5 6.5V13"/>',
  expand: '<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>',
  collapse: '<path d="M6 2.5V6H2.5M13.5 6H10V2.5M10 13.5V10h3.5M2.5 10H6v3.5"/>',
};
const icon = name => `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
const TOOL_TIPS = {
  png: 'Download PNG', copy: 'Copy image', tsv: 'Copy as a table (paste into Excel or Prism)', csv: 'Download CSV',
};
const CHART_TOOLS = ['png', 'copy', 'csv', 'expand'];
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
    + `<div class="card-tools">${extra}<div class="tools">${buttons}</div></div></div>`;
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
  const sub = `${errName() ? `Mean ± ${errName()}` : 'Mean'} of ${what}.`;
  const sec = card(id, title, sub, CHART_TOOLS, { hint: `Click a ${d.unit} in the legend to hide it.` });
  root.appendChild(sec);
  const shown = shownCages(d);
  if (!d.groups.some(g => shown.includes(g.cage) && g[metric].some(p => p.n > 0))) {
    empty(sec, M.tumor ? 'No tumor measurements yet.' : 'No measurements yet.');
    return;
  }

  const n = d.groups.length;
  const xs = d.dates.map((_, k) => xv(d, k));
  const unit = state.prefs.x === 'day' ? 1 : DAY;
  const span = xs.length > 1 ? Math.min(...xs.slice(1).map((x, k) => x - xs[k])) : unit;
  const step = Math.min(0.08 * unit, (span * 0.5) / Math.max(n, 1));
  const errKey = state.prefs.error;
  const datasets = d.groups.map((g, k) => {
    const { color, dash } = seriesStyle(t, k);
    const nudge = (k - (n - 1) / 2) * step;
    const pts = g[metric];
    const err = errKey === 'none' ? null
      : pts.map(p => (p.sem === null ? null : errKey === 'sd' ? p.sem * Math.sqrt(p.n) : p.sem));
    return {
      label: cageName(d, g.cage), cage: g.cage, hidden: !shown.includes(g.cage),
      data: pts.map((p, i) => ({ x: xs[i] + nudge, y: p.mean, date: p.date, day: d.days[i], n: p.n, err: err ? err[i] : null })),
      err,
      borderColor: color, backgroundColor: color, borderDash: dash,
      borderWidth: 2, pointRadius: 4, pointHoverRadius: 6, pointBorderColor: t.surface, pointBorderWidth: 1.5,
      spanGaps: true,
    };
  });
  const opts = chartOptions(t, d, metric);
  opts.plugins.legend.labels.generateLabels = cageLegend(t, d).generateLabels;
  opts.plugins.legend.onClick = cageLegend(t, d).onClick;
  opts.plugins.tooltip.callbacks.label = c =>
    `${c.dataset.label}: ${M.val(c.raw.y)}${c.raw.err !== null ? ` ± ${M.err(c.raw.err)}` : ''} (n=${c.raw.n})`;
  state.views[id].chart = makeChart(chartBox(sec), { type: 'line', data: { datasets }, options: opts });
  state.views[id].rows = () => [
    [d.unit, 'date', 'study_day', 'mean', 'sem', 'sd', 'n'],
    ...d.groups.filter(g => shown.includes(g.cage)).flatMap(g => g[metric].map((p, i) => [
      cageText(d, g.cage), p.date, d.days[i], num(p.mean), num(p.sem), num(p.sem === null ? null : p.sem * Math.sqrt(p.n)), p.n])),
  ];
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
  const shown = shownCages(d);
  const mice = d.mice.filter(m => shown.includes(m.cage));
  const keys = [mice.some(m => m.points.some(p => p.moved)) && '◆ moved cage', mice.some(m => m.ended) && '✕ ended'].filter(Boolean);
  const sub = `One line per mouse.${keys.length ? ` ${keys.join(', ')}.` : ''}`;
  const sec = card(id, title, sub, CHART_TOOLS, { hint: 'Hover to pick out a mouse; click to highlight it everywhere.' });
  root.appendChild(sec);
  state.views[id].rows = () => [
    [...idHead(d), 'date', 'study_day', 'cage_that_day', 'tail_mark_that_day', metric],
    ...mice.flatMap(m => m.points.map(p => [...idVals(d, m), p.date, p.day, p.cage, p.mark, num(p[metric])])),
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
        x: xv(d, i), y: p[metric], date: p.date, day: p.day, cage: p.cage, mark: p.mark, moved: p.moved, end: p.end, note: p.note,
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
  opts.interaction = { mode: 'nearest', intersect: false };
  if (datasets.some(ds => ds.endLabel)) opts.layout.padding.right = 44;
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
    + (left ? ` ${left} ${left > 1 ? 'mice' : 'mouse'} not measured then ${left > 1 ? 'are' : 'is'} left out.` : '');
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
    ticks: { color: t.muted, autoSkip: false, maxRotation: 90, minRotation: 0, font: { size: 11 } },
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

function sortRows(d, rows) {
  const { key, dir } = state.prefs.sort;
  const val = r => (key === 'flags' ? FLAG_RANK(r) : r[key]);
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
  const sec = card('table', `Latest values · ${fmtDate(ts(d.latestDate), { month: 'short', day: 'numeric', year: 'numeric' })}`,
    'Change is from each mouse’s first recorded weight.', TABLE_TOOLS, { hint: 'Click a column to sort, a row to highlight the mouse.' });
  const counts = {};
  rows.forEach(r => r.flags.forEach(f => { counts[f] = (counts[f] || 0) + 1; }));
  const summary = Object.keys(FLAGS).filter(f => counts[f])
    .map(f => `<span class="flag ${FLAGS[f].cls}">${FLAGS[f].icon} ${counts[f]} ${counts[f] > 1 ? 'mice' : 'mouse'} ${FLAGS[f].summary}</span>`);
  sec.insertAdjacentHTML('beforeend', `<p class="flags-summary">${summary.length ? summary.join(' ') : 'No flags.'}</p>`);

  const { key, dir } = state.prefs.sort;
  const head = TABLE_COLS.map(c => {
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
      TABLE_COLS.slice(2, -1).map(c => `<td>${c.show(r[c.key])}</td>`).join('')}<td>${flags}</td></tr>`;
  }).join('');
  sec.insertAdjacentHTML('beforeend', `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`);
  root.appendChild(sec);
  state.views.table.rows = () => [
    [...idHead(d), 'tail_mark', 'weight_g', 'weight_pct_change', 'tumor_volume', 'relative_tumor_volume', 'last_seen', 'status', 'end_date', 'end_reason', 'flags'],
    ...rows.map(r => [...idVals(d, r), r.mouse, num(r.weight), num(r.pct), num(r.volume), num(r.rtv), r.lastSeen,
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
  const colLabel = k => (state.prefs.x === 'day' ? `Day ${d.days[k]}` : fmtDate(ts(d.dates[k])));
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
      const tip = `${m.id}${where ? ` (${where})` : ''} · ${fmtLongDate(p.date)}: ${what}${p.moved ? ` · moved from ${placeLong(p.moved.cage, p.moved.mark)}` : ''}`;
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

// Kaplan–Meier curve per cage or group: share of mice that have not died or reached a humane endpoint.
function renderSurvival(root, t, d) {
  const shown = shownCages(d);
  const curves = survival(d.mice, d.cages, d.dates);
  const ended = d.mice.filter(m => shown.includes(m.cage) && m.ended).length;
  const sub = `Kaplan–Meier. Found dead or euthanized at an endpoint ends the line; euthanized at end of study or removed is censored.${
    ended ? '' : ' No mouse has ended yet.'}`;
  const sec = card('survival', `Survival by ${d.unit}`, sub, CHART_TOOLS, { hint: `Click a ${d.unit} in the legend to hide it.` });
  root.appendChild(sec);
  state.views.survival.rows = () => [
    [d.unit, 'date', 'study_day', 'surviving_pct', 'at_risk', 'events'],
    ...curves.filter(c => shown.includes(c.key)).flatMap(c => c.points.map(p =>
      [cageText(d, c.key), p.date, Math.round((ts(p.date) - ts(d.dates[0])) / DAY), num(p.s * 100), p.atRisk, p.events])),
  ];
  const n = curves.length;
  const datasets = curves.map((c, k) => {
    const { color, dash } = seriesStyle(t, k);
    const nudge = (k - (n - 1) / 2) * 0.6; // keep overlapping 100% lines apart
    return {
      label: cageName(d, c.key), cage: c.key, hidden: !shown.includes(c.key),
      data: c.points.map(p => ({ x: xOfDate(d, p.date), y: p.s * 100 + nudge, s: p.s, date: p.date,
        day: Math.round((ts(p.date) - ts(d.dates[0])) / DAY), atRisk: p.atRisk, events: p.events })),
      stepped: true, borderColor: color, backgroundColor: color, borderDash: dash, borderWidth: 2,
      pointRadius: c.points.map(p => (p.events ? 4 : 0)), pointHoverRadius: 5, pointBorderColor: t.surface, pointBorderWidth: 1.5,
    };
  });
  const opts = chartOptions(t, d, 'pct');
  opts.scales.x = xScale(t, d, curves.flatMap(c => c.points.map(p => p.date)));
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
  ];
  box.innerHTML = tiles.map(([value, label, cls]) =>
    `<div class="kpi${cls && value ? ` ${cls}` : ''}"><span class="kpi-value">${value}</span><span class="kpi-label">${label}</span></div>`).join('');
  box.hidden = false;
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
  if (!d || !d.dates.length) return;
  const t = theme();
  Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", sans-serif';
  Chart.defaults.color = t.ink2;
  const w = state.prefs.weight;
  const tm = state.prefs.tumor;
  const by = `by ${d.unit}`;
  renderGroupChart(root, t, d, 'weight-group', w, w === 'pct' ? `Body weight change ${by}` : `Body weight ${by}`);
  renderMiceChart(root, t, d, 'weight-mice', w, w === 'pct' ? 'Individual body weight change' : 'Individual body weights');
  renderLatestBars(root, t, d, 'weight-latest', w, `${w === 'pct' ? 'Weight change' : 'Body weight'} per mouse`);
  renderGroupChart(root, t, d, 'tumor-group', tm, tm === 'rtv' ? `Relative tumor volume ${by}` : `Tumor volume ${by}`);
  renderMiceChart(root, t, d, 'tumor-mice', tm, tm === 'rtv' ? 'Individual relative tumor volumes' : 'Individual tumor volumes');
  renderLatestBars(root, t, d, 'tumor-latest', tm, `${tm === 'rtv' ? 'Relative tumor volume' : 'Tumor volume'} per mouse`);
  renderSurvival(root, t, d);
  renderLatestTable(root, d);
  renderHeatmap(root, d);
}

/* ---------------------------------------------------------------- toolbar */

function renderToolbar(d) {
  const bar = document.getElementById('toolbar');
  const u = d.unit;
  const chips = d.cages.map((c, k) => `<button type="button" class="chip" data-cage="${escapeHtml(c)}" title="Show or hide ${
    escapeHtml(cageName(d, c))}. Double-click to show only this ${u}."><span class="dot" style="background:${seriesVar(k)}"></span>${
    escapeHtml(cageText(d, c))}</button>`).join('');
  const grouped = hasGroups();
  const byOptions = [
    hasStudyGroups() && ['group', 'Group', 'Groups from the Mice sheet of the workbook'],
    ['cage', 'Cage', 'Each mouse’s current cage, with its whole history'],
    grouped && ['mine', 'My groups', 'Your groups, set in the groups panel on this device'],
  ].filter(Boolean);
  const groupBy = `<div class="seg" role="group" aria-label="Group by"><span class="seg-label">Group by</span>${byOptions.length > 1
    ? `<div class="seg-buttons">${byOptions.map(([v, text, tip]) => `<button type="button" data-pref="by" data-value="${v}" title="${tip}">${text}</button>`).join('')}</div>`
    : ''}<button type="button" class="chip edit" data-groups-open title="Pick mice and sort them into labelled groups, on this device">${grouped ? 'Edit my groups' : 'Make groups'}</button></div>`;
  const mice = d.cages.map(c => `<optgroup label="${escapeHtml(cageName(d, c))}">${
    d.mice.filter(m => m.cage === c).map(m => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.id)}</option>`).join('')}</optgroup>`).join('');
  bar.innerHTML = `
    ${groupBy}
    <div class="seg" role="group" aria-label="${u === 'group' ? 'Groups' : 'Cages'}"><span class="seg-label">${u === 'group' ? 'Groups' : 'Cages'}</span><div class="chips">${chips}<button type="button" class="chip all" data-cage-all>All</button></div></div>
    ${segControl('weight', 'Weight', [['pct', '% change'], ['weight', 'Grams']])}
    ${segControl('tumor', 'Tumor', [['volume', 'Volume'], ['rtv', 'Relative', 'Each mouse’s volume ÷ its first measured volume']])}
    ${segControl('scale', 'Tumor axis', [['linear', 'Linear'], ['log', 'Log']])}
    ${segControl('error', 'Error bars', [['sem', 'SEM'], ['sd', 'SD'], ['none', 'None']])}
    ${segControl('x', 'X axis', [['date', 'Date'], ['day', 'Day', 'Study day: days since the first session']])}
    <label class="seg"><span class="seg-label">Highlight</span><select id="focus-mouse"><option value="">No mouse</option>${mice}</select></label>
    ${segControl('theme', 'Theme', [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']])}
    <div class="seg" role="group" aria-label="Export"><span class="seg-label">Export</span><div class="seg-buttons">
      <button type="button" data-export="png" title="All six charts in one PNG image">Dashboard</button>
      <button type="button" data-export="csv" title="Every measurement and derived value as CSV, one row per mouse per session">Data</button>
      <button type="button" data-export="print" title="Print, or save as PDF">Print</button></div></div>`;
  bar.hidden = false;
  syncToolbar();
}

function syncToolbar() {
  const bar = document.getElementById('toolbar');
  const d = state.derived;
  if (!d) return;
  const shown = shownCages(d);
  const current = key => (key === 'by' ? effectiveBy() : state.prefs[key]);
  bar.querySelectorAll('[data-pref]').forEach(b => b.setAttribute('aria-pressed', String(current(b.dataset.pref) === b.dataset.value)));
  bar.querySelectorAll('[data-cage]').forEach(b => b.setAttribute('aria-pressed', String(shown.includes(b.dataset.cage))));
  const all = bar.querySelector('[data-cage-all]');
  if (all) all.setAttribute('aria-pressed', String(shown.length === d.cages.length));
  const sel = document.getElementById('focus-mouse');
  if (sel) sel.value = state.focus || '';
}

function setPref(key, value) {
  if (!PREF_VALUES[key] || !PREF_VALUES[key].includes(value)) return;
  state.prefs[key] = value;
  savePrefs();
  if (key === 'theme') applyTheme();
  if (key === 'by') { refresh(); return; }
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

/** The view data: by current cage, or re-keyed by the workbook's groups or the user's own. */
function viewData() {
  const by = effectiveBy();
  if (by === 'group') return applyGroups(state.base, studyGrouping(state.base));
  if (by === 'mine') return applyGroups(state.base, state.grouping);
  return state.base;
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

/** Long ("tidy") table of every measurement and derived value. */
function allDataRows() {
  const d = state.base;
  const mine = hasGroups() ? [m => { const id = groupOf(state.grouping, m.id); return id === UNGROUPED ? '' : groupLabel(state.grouping, id); }] : [];
  const study = hasStudyGroups();
  return [
    ['mouse', 'current_cage', 'current_tail_mark', ...(study ? ['group'] : []), ...(mine.length ? ['my_group'] : []), 'status', 'end_date', 'end_reason',
      'date', 'study_day', 'cage', 'tail_mark', 'weight_g', 'weight_pct_change', 'tumor_length', 'tumor_breadth', 'tumor_volume', 'relative_tumor_volume', 'note'],
    ...d.mice.flatMap(m => m.points.map(p => [m.id, m.cage, m.mouse, ...(study ? [m.group] : []), ...mine.map(f => f(m)), m.status, m.endDate, m.endReason,
      p.date, p.day, p.cage, p.mark, p.weight, num(p.pct), p.length, p.breadth, num(p.volume), num(p.rtv), p.note])),
  ];
}

async function copyImage(canvas, name) {
  try {
    if (!navigator.clipboard || typeof ClipboardItem === 'undefined') throw new Error('unsupported');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': canvasBlob(canvas) })]);
    toast('Image copied. Paste it into a slide or document.');
  } catch {
    download(await canvasBlob(canvas), name);
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
    } else if (tool === 'png' && view.chart) {
      download(await canvasBlob(chartFigure(id)), fileName(id, 'png'));
    } else if (tool === 'copy' && view.chart) {
      await copyImage(chartFigure(id), fileName(id, 'png'));
    } else {
      toast('Nothing to export in this view yet.');
    }
  } catch (e) {
    toast(`Couldn’t do that here (${e.message || e}).`);
  }
}

async function runExport(kind) {
  if (!state.derived) return;
  if (kind === 'png') download(await canvasBlob(dashboardFigure()), fileName('dashboard', 'png'));
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
  const derived = derive(parsed);
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
function trackTop() {
  const set = () => {
    const top = document.getElementById('views').getBoundingClientRect().top + window.scrollY;
    document.documentElement.style.setProperty('--top', `${Math.round(top)}px`);
  };
  set();
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(set).observe(document.querySelector('header'));
  window.addEventListener('resize', set);
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
    document.getElementById('toolbar').hidden = true;
    renderViews();
    renderWarnings([]);
    document.getElementById('forget').hidden = true;
    setStatus('File and its groups forgotten on this device. Choose a file to plot it.');
  });

  // One click handler for the toolbar and every card.
  document.addEventListener('click', e => {
    const el = e.target.closest('button, tr[data-mouse]');
    if (!el || !state.derived) return;
    if (el.closest('#group-panel')) { panelClick(el); return; }
    if (el.dataset.groupsOpen !== undefined) { openGroupPanel(true); return; }
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
    if (e.target.id === 'focus-mouse') setFocus(e.target.value);
    else if (e.target.dataset.prefSelect) setPref(e.target.dataset.prefSelect, e.target.value);
  });
  document.addEventListener('input', e => { if (e.target.closest && e.target.closest('#group-panel')) panelInput(e); });
  document.addEventListener('keydown', e => {
    if (state.panel && e.target.closest && e.target.closest('#group-panel') && e.key === 'Enter') {
      if (e.target.dataset.label !== undefined) { e.preventDefault(); e.target.blur(); return; }
      if (e.target.dataset.min !== undefined) { e.preventDefault(); panelClick({ dataset: { pick: 'min' } }); return; }
    }
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
    studyGrouping, survival, UNGROUPED,
  };
}
