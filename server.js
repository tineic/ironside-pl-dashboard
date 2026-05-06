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
  const s = String(v).trim().replace(/,/g, '').replace(/\$/g, '').replace(/ /g, '');
  if (!s || s === '' || s === '-') return null;
  const neg = s.startsWith('(') && s.endsWith(')');
  const n = parseFloat(s.replace(/[()]/g, ''));
  if (isNaN(n)) return null;
  return neg ? -n : n;
}

function parseCSVText(text) {
  const lines = text.split('\n');
  return lines.map(line => {
    const cells = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') { inQ = !inQ; continue; }
      if (line[i] === ',' && !inQ) { cells.push(cur.trim()); cur = ''; continue; }
      cur += line[i];
    }
    cells.push(cur.trim());
    return cells;
  });
}

// Get 12 monthly values from a row starting at column 5 (Jan)
function monthVals(row) {
  if (!row) return new Array(12).fill(null);
  return Array.from({ length: 12 }, (_, i) => parseNum(row[5 + i]));
}

function parseActuals(text) {
  const rows = parseCSVText(text);
  // Structure: col 4=category label, col 5=Jan, col 6=Feb ... col 16=Dec
  // Key rows (0-indexed):
  // Row 116: Labor total
  // Row 125: Net Sales
  // Row 126: Cost of Goods
  // Row 127: Gross Profit
  // Row 128: Operating Cost
  // Row 129: Net Income

  const ns   = monthVals(rows[125]);
  const cogs = monthVals(rows[126]);
  const gp   = monthVals(rows[127]);
  const oc   = monthVals(rows[128]);
  const ni   = monthVals(rows[129]);
  const labor = monthVals(rows[116]);

  // Determine act_thru: last month with a real non-zero Net Sales value
  let actThru = -1;
  for (let i = 0; i < 12; i++) {
    if (ns[i] !== null && ns[i] !== 0) actThru = i;
    else break; // stop at first empty/zero month
  }

  console.log('Parsed actuals — act_thru:', actThru, '| NS:', ns.slice(0, actThru+1).map(v => v ? Math.round(v) : null));

  return {
    act_thru: actThru,
    true_ns:    ns,
    true_cogs:  cogs,
    true_gp:    gp,
    true_oc:    oc,
    true_ni:    ni,
    true_labor: labor,
  };
}

function parseProjection(text) {
  const rows = parseCSVText(text);
  // Structure: col 4=category label, col 5=Jan, col 6=Feb ... col 16=Dec
  // Key rows (0-indexed):
  // Row 117: Employee Labor & Taxes (labor_row118 in app)
  // Row 118: Creative Contractors (labor_row119)
  // Row 119: Other Labor (labor_row120)
  // Row 120: Projects/One-Time (labor_row121)
  // Row 121: Company Expense
  // Row 122: Rewards
  // Row 123: Payment Processor
  // Row 124: Building
  // Row 125: Marketing
  // Row 126: Software
  // Row 127: Personal
  // Row 128: Misc
  // Row 129: Net Sales
  // Row 130: Cost of Goods
  // Row 131: Gross Profit
  // Row 132: Operating Cost
  // Row 133: Net Income

  const proj_ns = monthVals(rows[129]);

  console.log('Parsed projection — NS:', proj_ns.map(v => v ? Math.round(v) : null));

  return {
    labor_row118: monthVals(rows[117]),
    labor_row119: monthVals(rows[118]),
    labor_row120: monthVals(rows[119]),
    labor_row121: monthVals(rows[120]),
    proj_ns:      proj_ns,
    proj_cogs:    monthVals(rows[130]),
    proj_gp:      monthVals(rows[131]),
    proj_oc:      monthVals(rows[132]),
    proj_ni:      monthVals(rows[133]),
    FIXED: {
      comp_exp: monthVals(rows[121]),
      rewards:  monthVals(rows[122]),
      base_pp:  monthVals(rows[123]),
      building: monthVals(rows[124]),
      base_mkt: monthVals(rows[125]),
      software: monthVals(rows[126]),
      personal: monthVals(rows[127]),
      misc:     monthVals(rows[128]),
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
    }

    if (hasProjection) {
      const projText = fs.readFileSync(PROJECTION_FILE, 'utf8');
      Object.assign(pdata, parseProjection(projText));
    }

    fs.writeFileSync(PDATA_FILE, JSON.stringify(pdata));
    console.log('pdata.json rebuilt — act_thru:', pdata.act_thru);
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
  laborTab: 'overview',
  tab: 'overview',
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
  if (fs.existsSync(PDATA_FILE)) {
    try { return res.json(JSON.parse(fs.readFileSync(PDATA_FILE, 'utf8'))); } catch(e) {}
  }
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
    // Delete old pdata so it gets rebuilt fresh
    if (fs.existsSync(PDATA_FILE)) fs.unlinkSync(PDATA_FILE);
    const pdata = rebuildPdata();
    res.json({ ok: true, pdata: pdata || null });
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
  console.log(`Ironside Dashboard on port ${PORT}`);
  if (fs.existsSync(ACTUALS_FILE) || fs.existsSync(PROJECTION_FILE)) {
    rebuildPdata();
  }
});
