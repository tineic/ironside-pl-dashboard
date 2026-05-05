'use strict';
const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const multer   = require('multer');
const fetch    = require('node-fetch');

const app  = express();
const PORT = process.env.PORT || 3000;
const PASS = process.env.DASHBOARD_PASSWORD || 'ironside2026';
const CLICKUP_KEY  = process.env.CLICKUP_API_KEY || '';
const CLICKUP_LIST = process.env.CLICKUP_LIST_ID || '901113608834';
const DATA_DIR        = path.join(__dirname, 'data');
const STATE_FILE      = path.join(DATA_DIR, 'state.json');
const ACTUALS_FILE    = path.join(DATA_DIR, 'actuals.csv');
const PROJECTION_FILE = path.join(DATA_DIR, 'projection.csv');
const PDATA_FILE      = path.join(DATA_DIR, 'pdata.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── CSV PARSING ───────────────────────────────────────────────────────────────
function parseNum(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/,/g, '').replace(/ /g, '');
  if (!s || s === 'nan' || s === 'NaN') return null;
  const neg = s.startsWith('(') && s.endsWith(')');
  const n = parseFloat(s.replace(/[()]/g, ''));
  if (isNaN(n)) return null;
  return neg ? -n : n;
}

function parseCSV(text) {
  const lines = text.split('\n');
  return lines.map(line => {
    const cells = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') { inQ = !inQ; continue; }
      if (line[i] === ',' && !inQ) { cells.push(cur); cur = ''; continue; }
      cur += line[i];
    }
    cells.push(cur);
    return cells;
  });
}

function rowVals(rows, idx, startCol) {
  const row = rows[idx];
  if (!row) return new Array(12).fill(0);
  return Array.from({length: 12}, (_, i) => parseNum(row[startCol + i]) || 0);
}

function findRow(rows, name, colCheck) {
  for (let i = 0; i < rows.length; i++) {
    const cell = (rows[i][colCheck] || '').trim();
    if (cell === name) return i;
  }
  return -1;
}

function parseActuals(text) {
  const rows = parseCSV(text);
  const COL = 4; // name column
  const START = 5; // Jan data starts

  // Find key rows
  const nsIdx    = findRow(rows, 'Net Sales', COL);
  const cogsIdx  = findRow(rows, 'Cost of Goods Sold', COL) || findRow(rows, 'Cost of Goods', COL);
  const gpIdx    = findRow(rows, 'Gross Profit', COL);
  const ocIdx    = findRow(rows, 'Total Expense', COL) !== -1 ? findRow(rows, 'Total Expense', COL) : findRow(rows, 'Total Operating Expenses', COL);
  const niIdx    = findRow(rows, 'Net Income', COL) !== -1 ? findRow(rows, 'Net Income', COL) : findRow(rows, 'Net Ordinary Income', COL);
  const labIdx   = findRow(rows, 'Labor', COL);
  const ppIdx    = findRow(rows, 'Payment Processor', COL);
  const mktIdx   = findRow(rows, 'Marketing', COL);
  const compIdx  = findRow(rows, 'Company Expense', COL);
  const rewIdx   = findRow(rows, 'Rewards', COL);
  const bldgIdx  = findRow(rows, 'Building', COL);
  const swIdx    = findRow(rows, 'Software', COL);
  const persIdx  = findRow(rows, 'Personal', COL);
  const miscIdx  = findRow(rows, 'Misc', COL);

  // Determine act_thru: last month with non-zero net sales
  const ns = rowVals(rows, nsIdx, START);
  let actThru = -1;
  for (let i = 0; i < 12; i++) {
    if (ns[i] && Math.abs(ns[i]) > 100) actThru = i;
    else break;
  }

  return {
    act_thru: actThru,
    actuals: {
      ns:   rowVals(rows, nsIdx, START),
      cogs: rowVals(rows, cogsIdx, START),
      gp:   rowVals(rows, gpIdx, START),
      oc:   rowVals(rows, ocIdx, START),
      ni:   rowVals(rows, niIdx, START),
      labor: rowVals(rows, labIdx, START),
      pp:    rowVals(rows, ppIdx, START),
      mkt:   rowVals(rows, mktIdx, START),
      comp:  rowVals(rows, compIdx, START),
      rew:   rowVals(rows, rewIdx, START),
      bldg:  rowVals(rows, bldgIdx, START),
      sw:    rowVals(rows, swIdx, START),
      pers:  rowVals(rows, persIdx, START),
      misc:  rowVals(rows, miscIdx, START),
    }
  };
}

function parseProjection(text) {
  const rows = parseCSV(text);
  const START = 5;

  // Key rows (0-indexed) — same structure as original spreadsheet
  return {
    proj_ns:   rowVals(rows, 129, START),
    proj_cogs: rowVals(rows, 130, START),
    proj_oc:   rowVals(rows, 132, START),
    proj_ni:   rowVals(rows, 133, START),
    lr118: rowVals(rows, 117, START),
    lr119: rowVals(rows, 118, START),
    lr120: rowVals(rows, 119, START),
    lr121: rowVals(rows, 120, START),
    fixed: {
      comp_exp: rowVals(rows, 121, START),
      rewards:  rowVals(rows, 122, START),
      base_pp:  rowVals(rows, 123, START),
      building: rowVals(rows, 124, START),
      base_mkt: rowVals(rows, 125, START),
      software: rowVals(rows, 126, START),
      personal: rowVals(rows, 127, START),
      misc:     rowVals(rows, 128, START),
    }
  };
}

function rebuildPdata() {
  try {
    const hasActuals    = fs.existsSync(ACTUALS_FILE);
    const hasProjection = fs.existsSync(PROJECTION_FILE);
    if (!hasActuals && !hasProjection) return null;

    let pdata = {};

    if (hasActuals) {
      const actText = fs.readFileSync(ACTUALS_FILE, 'utf8');
      Object.assign(pdata, parseActuals(actText));
      console.log(`Parsed actuals: act_thru=${pdata.act_thru}`);
    }

    if (hasProjection) {
      const projText = fs.readFileSync(PROJECTION_FILE, 'utf8');
      Object.assign(pdata, parseProjection(projText));
      console.log('Parsed projection');
    }

    // Preserve static values that don't come from CSVs
    pdata.dec_2025_ns   = pdata.dec_2025_ns   || 1152634.85;
    pdata.units_2025    = pdata.units_2025    || [306,325,330,346,308,278,235,313,295,316,488,443];

    fs.writeFileSync(PDATA_FILE, JSON.stringify(pdata));
    return pdata;
  } catch(e) {
    console.error('rebuildPdata error:', e.message);
    return null;
  }
}

// ── DEFAULT STATE ─────────────────────────────────────────────────────────────
const DEFAULT_STATE = {
  scenarioPct: [0,0,0,0,0,0,0,0,0],
  staffingChanges: [],
  customItems: [],
  dismissedAlerts: {},
  clickupSent: {},
  laborOverrides: {},
  rosterSliders: {},
  lastUpdated: null
};

function readState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return Object.assign({}, DEFAULT_STATE, JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
    }
  } catch(e) { console.error('State read error:', e.message); }
  return JSON.parse(JSON.stringify(DEFAULT_STATE));
}

function writeState(state) {
  state.lastUpdated = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Auth
app.get('/', (req, res) => {
  const cookie = (req.headers.cookie || '').split(';').find(c => c.trim().startsWith('auth='));
  if (cookie && cookie.split('=')[1] === PASS) return res.redirect('/app');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.use((req, res, next) => {
  if (req.path === '/auth') return next();
  const cookie = (req.headers.cookie || '').split(';').find(c => c.trim().startsWith('auth='));
  if (cookie && cookie.split('=')[1] === PASS) return next();
  const token = req.headers['x-auth-token'] || req.query.token;
  if (token === PASS) return next();
  if (req.path.startsWith('/api')) return res.status(401).json({ error: 'Unauthorized' });
  return res.redirect('/');
});

app.post('/auth', (req, res) => {
  const { password } = req.body;
  if (password === PASS) {
    res.setHeader('Set-Cookie', `auth=${PASS}; Path=/; HttpOnly; SameSite=Strict`);
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Wrong password' });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// ── API: PDATA ────────────────────────────────────────────────────────────────
app.get('/api/pdata', (req, res) => {
  // Return cached pdata if available
  if (fs.existsSync(PDATA_FILE)) {
    try {
      return res.json(JSON.parse(fs.readFileSync(PDATA_FILE, 'utf8')));
    } catch(e) {}
  }
  // Try to build from CSVs
  const pdata = rebuildPdata();
  if (pdata) return res.json(pdata);
  res.status(404).json({ error: 'No data uploaded yet' });
});

// ── API: STATE ────────────────────────────────────────────────────────────────
app.get('/api/state', (req, res) => res.json(readState()));

app.patch('/api/state', (req, res) => {
  try {
    const current = readState();
    Object.keys(req.body).forEach(k => { current[k] = req.body[k]; });
    writeState(current);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── API: FILE UPLOAD ──────────────────────────────────────────────────────────
const upload = multer({ dest: '/tmp/', limits: { fileSize: 10 * 1024 * 1024 } });

app.post('/api/upload/:type', upload.single('file'), (req, res) => {
  const type = req.params.type;
  if (!['actuals', 'projection'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
  const dest = type === 'actuals' ? ACTUALS_FILE : PROJECTION_FILE;
  try {
    fs.copyFileSync(req.file.path, dest);
    fs.unlinkSync(req.file.path);
    // Rebuild pdata immediately after upload
    const pdata = rebuildPdata();
    res.json({ ok: true, pdata: pdata || null, message: `${type} uploaded and parsed` });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: CLICKUP ──────────────────────────────────────────────────────────────
app.post('/api/clickup/task', async (req, res) => {
  if (!CLICKUP_KEY) return res.status(503).json({ error: 'ClickUp not configured' });
  const { name, description, priority } = req.body;
  try {
    const response = await fetch(`https://api.clickup.com/api/v2/list/${CLICKUP_LIST}/task`, {
      method: 'POST',
      headers: { 'Authorization': CLICKUP_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description: description || '', priority: priority || 3, status: 'to do' })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.err || 'ClickUp error');
    res.json({ ok: true, taskId: data.id, taskUrl: data.url });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ROUTES ────────────────────────────────────────────────────────────────────
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.listen(PORT, () => {
  console.log(`Ironside Dashboard running on port ${PORT}`);
  // Try to rebuild pdata on startup if CSVs exist
  if (fs.existsSync(ACTUALS_FILE) || fs.existsSync(PROJECTION_FILE)) {
    rebuildPdata();
    console.log('pdata rebuilt from existing CSVs');
  }
});
