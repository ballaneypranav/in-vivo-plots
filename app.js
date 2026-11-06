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
 */
function derive(parsed) {
  const dates = parsed.sessions.map(s => s.date);
  const days = dates.map(date => Math.round((ts(date) - ts(dates[0])) / DAY));
  const latestDate = dates[dates.length - 1] ?? null;
  const miceById = new Map();

  for (const s of parsed.sessions) {
    for (const r of s.rows) {
      const id = `${r.cage}-${r.mouse}`;
      if (!miceById.has(id)) miceById.set(id, { id, cage: r.cage, mouse: r.mouse, byDate: {} });
      miceById.get(id).byDate[s.date] = r;
    }
  }

  const mice = [...miceById.values()].sort((a, b) => byNatural(a.cage, b.cage) || byNatural(a.mouse, b.mouse));
  for (const m of mice) {
    const firstWeighed = dates.find(d => m.byDate[d] && m.byDate[d].weight !== null);
    m.baseline = firstWeighed ? m.byDate[firstWeighed].weight : null;
    m.points = dates.map((date, k) => {
      const r = m.byDate[date];
      const weight = r ? r.weight : null;
      const length = r ? r.length : null;
      const breadth = r ? r.breadth : null;
      const pct = weight !== null && m.baseline ? ((weight - m.baseline) / m.baseline) * 100 : null;
      return { date, day: days[k], weight, pct, length, breadth, volume: tumorVolume(length, breadth) };
    });
    const firstTumor = m.points.find(p => p.volume !== null);
    m.firstVolume = firstTumor ? firstTumor.volume : null;
    for (const p of m.points) p.rtv = p.volume !== null && m.firstVolume ? p.volume / m.firstVolume : null;
    const hasData = p => p.weight !== null || p.length !== null || p.breadth !== null;
    const seen = m.points.filter(hasData);
    m.lastSeen = seen.length ? seen[seen.length - 1].date : null;
    delete m.byDate;
  }

  const cages = [...new Set(mice.map(m => m.cage))].sort(byNatural);
  const groups = cages.map(cage => {
    const members = mice.filter(m => m.cage === cage);
    const series = metric => dates.map((date, k) => ({ date, ...summarize(members.map(m => m.points[k][metric])) }));
    return {
      cage, mice: members.map(m => m.id),
      pct: series('pct'), weight: series('weight'), volume: series('volume'), rtv: series('rtv'),
    };
  });

  const latest = mice.map(m => {
    const p = m.points[m.points.length - 1] || {};
    const flags = [];
    if (p.pct !== null && p.pct !== undefined) {
      if (p.pct <= LOSS_ALERT) flags.push('loss-alert');
      else if (p.pct <= LOSS_WARNING) flags.push('loss-warning');
    }
    const missing = m.lastSeen !== null && m.lastSeen !== latestDate;
    if (missing) flags.push('missing');
    return {
      id: m.id, cage: m.cage, mouse: m.mouse,
      weight: p.weight ?? null, pct: p.pct ?? null, volume: p.volume ?? null, rtv: p.rtv ?? null,
      lastSeen: m.lastSeen, flags,
    };
  });

  return { dates, days, latestDate, mice, cages, groups, latest };
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
};
const SORT_KEYS = ['id', 'weight', 'pct', 'volume', 'rtv', 'flags'];

function loadPrefs() {
  let saved = {};
  try { saved = JSON.parse(store.get(STORE_PREFS) || '{}') || {}; } catch { saved = {}; }
  const prefs = {};
  for (const [k, vals] of Object.entries(PREF_VALUES)) prefs[k] = vals.includes(saved[k]) ? saved[k] : vals[0];
  prefs.hidden = Array.isArray(saved.hidden) ? saved.hidden.filter(c => typeof c === 'string') : [];
  const s = saved.sort || {};
  prefs.sort = { key: SORT_KEYS.includes(s.key) ? s.key : 'id', dir: s.dir === -1 ? -1 : 1 };
  return prefs;
}

const state = {
  charts: [], derived: null, name: '', prefs: loadPrefs(),
  focus: null,      // highlighted mouse id
  expanded: null,   // id of the card shown full screen
  views: {},        // id -> { title, subtitle, chart?, rows() } for the export tools
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

const shownCages = d => {
  const shown = d.cages.filter(c => !state.prefs.hidden.includes(c));
  return shown.length ? shown : d.cages;
};
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

function xScale(t, d) {
  const day = state.prefs.x === 'day';
  const xs = d.dates.map((_, k) => xv(d, k));
  const unit = day ? 1 : DAY;
  const pad = Math.max(0.4 * unit, (xs[xs.length - 1] - xs[0]) * 0.03);
  return {
    type: 'linear',
    min: xs[0] - pad,
    max: xs[xs.length - 1] + pad,
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
      text: `Cage ${c}`, fillStyle: seriesStyle(t, k).color, strokeStyle: seriesStyle(t, k).color,
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
  const sec = card(id, title, sub, CHART_TOOLS, { hint: 'Click a cage in the legend to hide it.' });
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
      label: `Cage ${g.cage}`, cage: g.cage, hidden: !shown.includes(g.cage),
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
    ['cage', 'date', 'study_day', 'mean', 'sem', 'sd', 'n'],
    ...d.groups.filter(g => shown.includes(g.cage)).flatMap(g => g[metric].map((p, i) => [
      g.cage, p.date, d.days[i], num(p.mean), num(p.sem), num(p.sem === null ? null : p.sem * Math.sqrt(p.n)), p.n])),
  ];
}

// Dim every line but the hovered (or highlighted) one.
function emphasize(datasets, active) {
  datasets.forEach((ds, i) => {
    const on = active === null || i === active;
    ds.borderColor = ds.backgroundColor = on ? ds.$color : dim(ds.$color);
    ds.pointBorderColor = on ? ds.$ring : 'transparent';
    ds.borderWidth = active !== null && i === active ? ds.$width + 1.5 : ds.$width;
  });
}

// One line per mouse. All cages: color = cage. One cage: color = mouse, by its fixed position in the cage,
// and each line is labelled at its end.
function renderMiceChart(root, t, d, id, metric, title) {
  const M = METRICS[metric];
  const sec = card(id, title, 'One line per mouse.', CHART_TOOLS, { hint: 'Hover to pick out a mouse; click to highlight it everywhere.' });
  root.appendChild(sec);
  const shown = shownCages(d);
  const mice = d.mice.filter(m => shown.includes(m.cage));
  state.views[id].rows = () => [
    ['mouse', 'cage', 'date', 'study_day', metric],
    ...mice.flatMap(m => m.points.map(p => [m.id, m.cage, p.date, p.day, num(p[metric])])),
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
      label: m.id, mouse: m.id, cage: m.cage,
      data: m.points.map((p, i) => ({ x: xv(d, i), y: p[metric], date: p.date, day: p.day })),
      $color: color, $ring: t.surface, $width: width, borderDash: dash,
      pointRadius: solo ? 3.5 : 2.5, pointHoverRadius: 6, pointBorderWidth: 1, spanGaps: true,
      endLabel: solo || m.id === state.focus ? m.id : null,
    };
  });
  const focusIndex = () => { const i = datasets.findIndex(ds => ds.mouse === state.focus); return i < 0 ? null : i; };
  emphasize(datasets, focusIndex());

  const opts = chartOptions(t, d, metric);
  opts.interaction = { mode: 'nearest', intersect: false };
  if (datasets.some(ds => ds.endLabel)) opts.layout.padding.right = 44;
  opts.plugins.tooltip.callbacks.label = c => `Mouse ${c.dataset.label}: ${M.val(c.raw.y)}`;
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
  state.views[id].rows = () => [['mouse', 'cage', 'date', metric], ...rows.map(r => [r.id, r.cage, d.latestDate, num(r[metric])])];
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
  opts.plugins.tooltip.callbacks.label = c => `${M.val(c.raw)} · Cage ${rows[c.dataIndex].cage}`;
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
  missing: { cls: 'missing', icon: '○', text: 'No data since', summary: 'no data in the latest session' },
};
const FLAG_RANK = r => (r.flags.includes('loss-alert') ? 3 : r.flags.includes('loss-warning') ? 2 : r.flags.includes('missing') ? 1 : 0);

const TABLE_COLS = [
  { key: 'id', label: 'Mouse' },
  { key: 'weight', label: 'Weight (g)', show: v => fmt(v, 2) },
  { key: 'pct', label: 'Change', show: v => (v === null ? '—' : `${fmtSigned(v)}%`) },
  { key: 'volume', label: 'Tumor vol.', show: v => fmt(v) },
  { key: 'rtv', label: 'Rel. vol.', show: v => (v === null ? '—' : `${fmt(v, 2)}×`) },
  { key: 'flags', label: 'Flags' },
];

function sortRows(rows) {
  const { key, dir } = state.prefs.sort;
  const val = r => (key === 'flags' ? FLAG_RANK(r) : r[key]);
  return [...rows].sort((a, b) => {
    if (key === 'id') return dir * (byNatural(a.cage, b.cage) || byNatural(a.mouse, b.mouse));
    const va = val(a), vb = val(b);
    if (va === null && vb === null) return 0;
    if (va === null) return 1; // not measured: always last
    if (vb === null) return -1;
    return dir * (va - vb) || byNatural(a.id, b.id);
  });
}

const mouseCell = (d, id, cage) =>
  `<th scope="row"><span class="dot" style="background:${seriesVar(d.cages.indexOf(cage))}"></span>${escapeHtml(id)}</th>`;

function renderLatestTable(root, d) {
  const shown = shownCages(d);
  const rows = sortRows(d.latest.filter(r => shown.includes(r.cage)));
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
    const flags = r.flags.map(f => `<span class="flag ${FLAGS[f].cls}">${FLAGS[f].icon} ${FLAGS[f].text}${
      f === 'missing' ? ` ${fmtDate(ts(r.lastSeen))}` : ''}</span>`).join(' ');
    const rowCls = ['loss-alert', 'loss-warning', 'missing'].find(f => r.flags.includes(f));
    const cls = [rowCls ? FLAGS[rowCls].cls : '', r.id === state.focus ? 'focused' : ''].join(' ').trim();
    return `<tr class="${cls}" data-mouse="${escapeHtml(r.id)}" tabindex="0">${mouseCell(d, r.id, r.cage)}${
      TABLE_COLS.slice(1, -1).map(c => `<td>${c.show(r[c.key])}</td>`).join('')}<td>${flags}</td></tr>`;
  }).join('');
  sec.insertAdjacentHTML('beforeend', `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`);
  root.appendChild(sec);
  state.views.table.rows = () => [
    ['mouse', 'cage', 'weight_g', 'weight_pct_change', 'tumor_volume', 'relative_tumor_volume', 'last_seen', 'flags'],
    ...rows.map(r => [r.id, r.cage, num(r.weight), num(r.pct), num(r.volume), num(r.rtv), r.lastSeen, r.flags.join(' ')]),
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
      const strong = metric === 'pct' && v !== null && v <= LOSS_WARNING ? ' class="strong"' : '';
      const text = v === null ? '' : metric === 'pct' ? fmtSigned(v) : v.toFixed(M.digits);
      return `<td style="${shade(v)}"${strong} title="${escapeHtml(m.id)} · ${fmtLongDate(p.date)}: ${v === null ? 'not measured' : M.val(v)}">${text}</td>`;
    }).join('');
    const cls = [m.cage !== prevCage && prevCage !== null ? 'cage-start' : '', m.id === state.focus ? 'focused' : ''].join(' ').trim();
    prevCage = m.cage;
    return `<tr class="${cls}" data-mouse="${escapeHtml(m.id)}" tabindex="0">${mouseCell(d, m.id, m.cage)}${cells}</tr>`;
  }).join('');
  sec.insertAdjacentHTML('beforeend', `<div class="table-wrap heat"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`);
  root.appendChild(sec);
  state.views.grid.rows = () => [
    ['mouse', 'cage', ...d.dates],
    ...mice.map(m => [m.id, m.cage, ...m.points.map(p => num(p[metric]))]),
  ];
}

function renderKpis(d) {
  const box = document.getElementById('kpis');
  if (!d) { box.hidden = true; box.innerHTML = ''; return; }
  const shown = shownCages(d);
  const rows = d.latest.filter(r => shown.includes(r.cage));
  const count = f => rows.filter(r => r.flags.includes(f)).length;
  const tiles = [
    [`Day ${d.days[d.days.length - 1]}`, `latest, ${fmtDate(ts(d.latestDate))}`, ''],
    [rows.length === d.latest.length ? rows.length : `${rows.length} / ${d.latest.length}`, `mice, ${shown.length} cage${shown.length > 1 ? 's' : ''}`, ''],
    [count('loss-alert'), '⛔ lost ≥ 20%', 'critical'],
    [count('loss-warning'), '⚠ lost 15–20%', 'warning'],
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
  renderGroupChart(root, t, d, 'weight-group', w, w === 'pct' ? 'Body weight change by cage' : 'Body weight by cage');
  renderMiceChart(root, t, d, 'weight-mice', w, w === 'pct' ? 'Individual body weight change' : 'Individual body weights');
  renderLatestBars(root, t, d, 'weight-latest', w, `${w === 'pct' ? 'Weight change' : 'Body weight'} per mouse`);
  renderGroupChart(root, t, d, 'tumor-group', tm, tm === 'rtv' ? 'Relative tumor volume by cage' : 'Tumor volume by cage');
  renderMiceChart(root, t, d, 'tumor-mice', tm, tm === 'rtv' ? 'Individual relative tumor volumes' : 'Individual tumor volumes');
  renderLatestBars(root, t, d, 'tumor-latest', tm, `${tm === 'rtv' ? 'Relative tumor volume' : 'Tumor volume'} per mouse`);
  renderLatestTable(root, d);
  renderHeatmap(root, d);
}

/* ---------------------------------------------------------------- toolbar */

function renderToolbar(d) {
  const bar = document.getElementById('toolbar');
  const chips = d.cages.map((c, k) => `<button type="button" class="chip" data-cage="${escapeHtml(c)}" title="Show or hide cage ${
    escapeHtml(c)}. Double-click to show only this cage."><span class="dot" style="background:${seriesVar(k)}"></span>${escapeHtml(c)}</button>`).join('');
  const mice = d.cages.map(c => `<optgroup label="Cage ${escapeHtml(c)}">${
    d.mice.filter(m => m.cage === c).map(m => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.id)}</option>`).join('')}</optgroup>`).join('');
  bar.innerHTML = `
    <div class="seg" role="group" aria-label="Cages"><span class="seg-label">Cages</span><div class="chips">${chips}<button type="button" class="chip all" data-cage-all>All</button></div></div>
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
  bar.querySelectorAll('[data-pref]').forEach(b => b.setAttribute('aria-pressed', String(state.prefs[b.dataset.pref] === b.dataset.value)));
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
  syncToolbar();
  renderViews();
}

function setHidden(hidden) {
  state.prefs.hidden = hidden;
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

/* ----------------------------------------------------------------- export */

const num = v => (v === null || v === undefined ? null : +v.toFixed(4));
const csvCell = v => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = rows => `${rows.map(r => r.map(csvCell).join(',')).join('\n')}\n`;
const toTsv = rows => rows.map(r => r.map(v => (v === null || v === undefined ? '' : String(v))).join('\t')).join('\n');

function fileName(what, ext) {
  const base = (state.name || 'study').replace(/\.md$/i, '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
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

const CHART_IDS = ['weight-group', 'weight-mice', 'weight-latest', 'tumor-group', 'tumor-mice', 'tumor-latest'];

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
  const d = state.derived;
  return [
    ['mouse', 'cage', 'date', 'study_day', 'weight_g', 'weight_pct_change', 'tumor_length', 'tumor_breadth', 'tumor_volume', 'relative_tumor_volume'],
    ...d.mice.flatMap(m => m.points.map(p => [m.id, m.cage, p.date, p.day, p.weight, num(p.pct), p.length, p.breadth, num(p.volume), num(p.rtv)])),
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
  box.innerHTML = `<details${open ? ' open' : ''}><summary>${warnings.length} problem${warnings.length > 1 ? 's' : ''} reading the note</summary><ul>${
    warnings.map(w => `<li><span class="ln">Line ${w.line}</span> ${escapeHtml(w.message)}</li>`).join('')}</ul></details>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function setStatus(html) {
  const el = document.getElementById('status');
  el.innerHTML = html;
  el.title = el.textContent;
}

/** Parse, derive and draw note text. Returns false (and draws nothing) if the note has no sessions. */
function show(text, name, savedAt) {
  const parsed = parseNote(text);
  renderWarnings(parsed.warnings);
  if (!parsed.sessions.length) {
    state.derived = null;
    document.getElementById('toolbar').hidden = true;
    renderViews();
    setStatus(`<strong>${escapeHtml(name)}</strong> has no measurement sessions. Each session starts with a heading like <code>## 2026-11-05</code> followed by the measurement table.`);
    return false;
  }
  const derived = derive(parsed);
  state.derived = derived;
  state.name = name;
  if (!derived.mice.some(m => m.id === state.focus)) state.focus = null;
  renderToolbar(derived);
  renderViews();
  const when = savedAt ? ` · loaded ${new Date(savedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : '';
  setStatus(`<strong>${escapeHtml(name)}</strong> · ${parsed.sessions.length} session${parsed.sessions.length > 1 ? 's' : ''}, ${derived.mice.length} mice${when}`);
  document.getElementById('forget').hidden = false;
  return true;
}

function loadText(text, name) {
  const savedAt = Date.now();
  if (show(text, name, savedAt) && !store.set(STORE_NOTE, JSON.stringify({ name, text, savedAt }))) {
    document.getElementById('status').insertAdjacentHTML('beforeend', ' · <em>not remembered (storage unavailable)</em>');
  }
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
    if (file.size > 5 * 1024 * 1024) { setStatus(`<strong>${escapeHtml(file.name)}</strong> is too large to be a note.`); return; }
    const reader = new FileReader();
    reader.onload = () => loadText(String(reader.result), file.name);
    reader.onerror = () => setStatus(`Could not read <strong>${escapeHtml(file.name)}</strong>.`);
    reader.readAsText(file);
  });

  document.getElementById('demo').addEventListener('click', async () => {
    try {
      const res = await fetch('demo/synthetic-demo.md');
      if (!res.ok) throw new Error(String(res.status));
      loadText(await res.text(), 'Synthetic demo');
    } catch {
      setStatus('Could not load the demo note.');
    }
  });

  document.getElementById('forget').addEventListener('click', () => {
    store.remove(STORE_NOTE);
    state.derived = null;
    state.focus = null;
    state.expanded = null;
    document.getElementById('toolbar').hidden = true;
    renderViews();
    renderWarnings([]);
    document.getElementById('forget').hidden = true;
    setStatus('Note forgotten on this device. Choose a note to plot it.');
  });

  // One click handler for the toolbar and every card.
  document.addEventListener('click', e => {
    const el = e.target.closest('button, tr[data-mouse]');
    if (!el || !state.derived) return;
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
    if (e.target.id === 'focus-mouse') setFocus(e.target.value);
    else if (e.target.dataset.prefSelect) setPref(e.target.dataset.prefSelect, e.target.value);
  });
  document.addEventListener('keydown', e => {
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
  if (!(saved && typeof saved.text === 'string' && show(saved.text, saved.name || 'Saved note', saved.savedAt))) {
    setStatus('Choose your experiment note (.md) to plot it. It is read on this device and never uploaded.');
  }

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline support unavailable */ });
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
}

if (typeof module === 'object' && module.exports) module.exports = { parseNote, derive, summarize, tumorVolume };
