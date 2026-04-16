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
const DATA_DIR  = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const ACTUALS_FILE    = path.join(DATA_DIR, 'actuals.csv');
const PROJECTION_FILE = path.join(DATA_DIR, 'projection.csv');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DEFAULT_STATE = {
  scenarioPct: [0,0,0,0,0,0,0,0,0],
  staffingChanges: [],
  actionItems: [],
  dismissedAlerts: {},
  roster: [
    { id:'s1',  name:'Spencer',  dept:'CS',          base:25.00,  hrs:38, salaried:false, builder:false, active:true },
    { id:'s2',  name:'Danni',    dept:'CS',           base:20.00,  hrs:38, salaried:false, builder:false, active:true },
    { id:'s3',  name:'Brett',    dept:'Testing/RMA',  base:29.93,  hrs:38, salaried:true,  builder:false, active:true },
    { id:'s4',  name:'Shawn',    dept:'Testing',      base:22.00,  hrs:38, salaried:false, builder:false, active:true },
    { id:'s5',  name:'Sterling', dept:'Shipping',     base:22.00,  hrs:38, salaried:false, builder:false, active:true },
    { id:'s6',  name:'Riley',    dept:'Inventory',    base:25.00,  hrs:38, salaried:false, builder:false, active:true },
    { id:'s7',  name:'Juan',     dept:'Detailing',    base:23.00,  hrs:38, salaried:false, builder:false, active:true },
    { id:'s8',  name:'Brandon',  dept:'Detailing',    base:20.70,  hrs:38, salaried:false, builder:false, active:true },
    { id:'s9',  name:'Mike',     dept:'Building',     base:24.00,  hrs:38, salaried:false, builder:true,  active:true },
    { id:'s10', name:'Janelle',  dept:'Building',     base:21.00,  hrs:38, salaried:false, builder:true,  active:true },
    { id:'s11', name:'Eli',      dept:'Building',     base:19.50,  hrs:38, salaried:false, builder:true,  active:true },
    { id:'s12', name:'Matt',     dept:'Building',     base:18.00,  hrs:38, salaried:false, builder:true,  active:true }
  ],
  floorModel: { dailyUnits:20, daysPerMonth:22, builderMinutes:90, detailingPct:60 },
  lastUpdated: null
};

function readState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      return Object.assign({}, DEFAULT_STATE, s);
    }
  } catch(e) { console.error('State read error:', e.message); }
  return JSON.parse(JSON.stringify(DEFAULT_STATE));
}

function writeState(state) {
  state.lastUpdated = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

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

app.get('/api/state', (req, res) => res.json(readState()));

app.post('/api/state', (req, res) => {
  try {
    const current = readState();
    const updated = Object.assign(current, req.body);
    writeState(updated);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/state', (req, res) => {
  try {
    const current = readState();
    Object.keys(req.body).forEach(k => { current[k] = req.body[k]; });
    writeState(current);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

const upload = multer({ dest: '/tmp/', limits: { fileSize: 5 * 1024 * 1024 } });

app.post('/api/upload/:type', upload.single('file'), (req, res) => {
  const type = req.params.type;
  if (!['actuals','projection'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
  const dest = type === 'actuals' ? ACTUALS_FILE : PROJECTION_FILE;
  try {
    fs.copyFileSync(req.file.path, dest);
    fs.unlinkSync(req.file.path);
    res.json({ ok: true, message: `${type} uploaded successfully` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/data/:type', (req, res) => {
  const type = req.params.type;
  const file = type === 'actuals' ? ACTUALS_FILE : PROJECTION_FILE;
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'No file uploaded yet' });
  res.setHeader('Content-Type', 'text/csv');
  res.send(fs.readFileSync(file, 'utf8'));
});

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

app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));
app.get('/app/*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.listen(PORT, () => console.log(`Ironside Dashboard running on port ${PORT}`));
