/**
 * FreeLike v3 — Server
 * ────────────────────────────────────────────────────────────────
 * • Serves the HTML dashboard
 * • Handles /api/like, /api/data, /api/status, /api/uids, /api/schedule, /api/history
 * • Built-in cron: checks schedules every 60s, runs UIDs one-by-one with 60s delay between each
 * • Works 24/7 — browser does NOT need to be open
 *
 * INSTALL & RUN:
 *   npm install express node-fetch
 *   node server.js
 *
 * Or with auto-restart (recommended):
 *   npm install -g pm2
 *   pm2 start server.js --name freelike
 *   pm2 save && pm2 startup
 */

const express  = require('express');
const fs       = require('fs');
const path     = require('path');

// node-fetch v2 is CommonJS compatible
let fetch;
try { fetch = require('node-fetch'); }
catch(e) { fetch = globalThis.fetch; } // Node 18+ has built-in fetch

const app  = express();
const PORT = process.env.PORT || 3000;
const DB   = path.join(__dirname, 'freelike_data.json');

app.use(express.json());
app.use(express.static(__dirname)); // serve HTML from same folder

// ── DATABASE ──────────────────────────────────────────────────
function loadDB() {
  try {
    if (fs.existsSync(DB)) return JSON.parse(fs.readFileSync(DB,'utf8'));
  } catch(e) {}
  return { history:[], stats:{}, uids:[], schedules:{} };
}

function saveDB(data) {
  try { fs.writeFileSync(DB, JSON.stringify(data, null, 2)); }
  catch(e) { console.error('DB save error:', e.message); }
}

function recalcStats(data) {
  const h = data.history || [];
  const IST_OFFSET = 5.5 * 60 * 60 * 1000;
  const nowIST = new Date(Date.now() + IST_OFFSET);
  const todayStr = nowIST.toISOString().substring(0,10);

  data.stats = {
    total   : h.reduce((a,e)=>a+(e.given||0), 0),
    today   : h.filter(e=>e.date===todayStr).reduce((a,e)=>a+(e.given||0),0),
    todayDate: todayStr,
    sessions: h.length,
    autoRuns: h.filter(e=>e.type==='AUTO').length,
    lastRun : h.length ? h[0].time : null
  };
}

// ── HELPERS ───────────────────────────────────────────────────
function nowIST() {
  const IST_OFFSET = 5.5 * 60 * 60 * 1000;
  const d = new Date(Date.now() + IST_OFFSET);
  const pad = n => String(n).padStart(2,'0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function todayIST() {
  const IST_OFFSET = 5.5 * 60 * 60 * 1000;
  return new Date(Date.now() + IST_OFFSET).toISOString().substring(0,10);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── LIKE API CALL ─────────────────────────────────────────────
async function sendLikeAPI(uid, server) {
  // Replace this URL with the actual FreeFire Like API endpoint you use
  const url = `https://aryan-like-api.vercel.app/api/like?uid=${uid}&server=${server}`;
  const res  = await fetch(url, { timeout: 15000 });
  if (!res.ok) throw new Error(`API HTTP ${res.status}`);
  return await res.json();
}

function recordEntry(data, uid, server, apiData, type) {
  const IST_OFFSET = 5.5 * 60 * 60 * 1000;
  const d = new Date(Date.now() + IST_OFFSET);
  const pad = n => String(n).padStart(2,'0');
  const timeStr = `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  const dateStr = timeStr.substring(0,10);

  const entry = {
    time    : timeStr,
    date    : dateStr,
    uid     : String(uid),
    nickname: apiData.PlayerNickname || uid,
    server  : server,
    before  : apiData.LikesbeforeCommand ?? 0,
    after   : apiData.LikesafterCommand  ?? 0,
    given   : apiData.LikesGivenByAPI    ?? 0,
    type    : type,   // 'MANUAL' | 'AUTO'
    status  : apiData.status === 1 ? 'SUCCESS' : 'FAILED'
  };

  data.history.unshift(entry);
  if (data.history.length > 5000) data.history = data.history.slice(0, 5000);
  recalcStats(data);
  saveDB(data);
  return entry;
}

// ── ROUTES ────────────────────────────────────────────────────

// Serve dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Get all data
app.get('/api/data', (req, res) => {
  res.json(loadDB());
});

// Server status
app.get('/api/status', (req, res) => {
  const data = loadDB();
  const activeScheds = Object.values(data.schedules||{}).filter(s=>s.enabled).length;
  res.json({
    uptime        : Math.floor(process.uptime()),
    serverTime    : nowIST() + ' IST',
    scheduleEnabled: activeScheds > 0,
    activeSchedules: activeScheds,
    scheduleTime  : 'per-UID',
    totalRecords  : data.history.length,
    totalLikes    : data.stats.total || 0,
    cronRunning   : cronRunning
  });
});

// Send like (manual from browser)
app.post('/api/like', async (req, res) => {
  const { uid, server, type } = req.body;
  if (!uid || !server) return res.json({ ok:false, error:'Missing uid or server' });

  try {
    const apiData = await sendLikeAPI(uid, server);
    const data  = loadDB();
    const entry = recordEntry(data, uid, server, apiData, type || 'MANUAL');
    res.json({ ok:true, apiData, entry });
  } catch(e) {
    res.json({ ok:false, error: e.message });
  }
});

// Save UIDs and schedules
app.post('/api/uids', (req, res) => {
  const { uids, schedules } = req.body;
  const data = loadDB();
  if (uids)      data.uids      = uids;
  if (schedules) data.schedules = schedules;
  saveDB(data);
  res.json({ ok:true });
});

// Save single schedule (legacy compat)
app.post('/api/schedule', (req, res) => {
  const { enabled, time, uid, server } = req.body;
  const data = loadDB();
  data.schedule = { enabled, time, uid, server };
  saveDB(data);
  res.json({ ok:true });
});

// Clear history
app.delete('/api/history', (req, res) => {
  const data = loadDB();
  data.history = [];
  data.stats   = {};
  saveDB(data);
  res.json({ ok:true });
});

// ── SERVER-SIDE CRON ENGINE ───────────────────────────────────
// Runs every 30 seconds. When a UID's schedule time matches current IST time,
// it queues all matching UIDs and sends them one-by-one with 60s delay between each.
// This runs on the SERVER — browser does NOT need to be open.

const DELAY_BETWEEN_UIDS = 60 * 1000; // 60 seconds
let cronRunning = false;
const firedToday = {}; // { uid_id_YYYY-MM-DD: true }

async function runCronQueue(targets) {
  if (cronRunning) {
    console.log('[CRON] Queue already running, skipping');
    return;
  }
  cronRunning = true;
  console.log(`[CRON] Starting queue for ${targets.length} UID(s)...`);

  const data = loadDB();

  for (let i = 0; i < targets.length; i++) {
    const u  = targets[i];
    const sc = data.schedules[u.id] || {};
    const server = sc.server || u.server;

    console.log(`[CRON] [${i+1}/${targets.length}] Sending like → UID: ${u.uid} (${u.nick}) Server: ${server}`);

    try {
      const apiData = await sendLikeAPI(u.uid, server);
      const freshData = loadDB(); // reload in case browser changed data
      const entry = recordEntry(freshData, u.uid, server, apiData, 'AUTO');
      console.log(`[CRON] ✅ Success: +${entry.given} likes → ${entry.nickname} (total: ${entry.after})`);
    } catch(e) {
      console.error(`[CRON] ❌ Failed for UID ${u.uid}: ${e.message}`);
      // Still record a FAILED entry so auto runs counter increments
      const freshData = loadDB();
      recordEntry(freshData, u.uid, server, {
        PlayerNickname: u.nick,
        LikesbeforeCommand: 0,
        LikesafterCommand: 0,
        LikesGivenByAPI: 0,
        status: 0
      }, 'AUTO');
    }

    // 60-second delay before next UID (skip after last)
    if (i < targets.length - 1) {
      console.log(`[CRON] ⏱ Waiting 60s before next UID (${targets[i+1].nick})...`);
      await sleep(DELAY_BETWEEN_UIDS);
    }
  }

  cronRunning = false;
  console.log(`[CRON] ✅ Queue complete for ${targets.length} UID(s).`);
}

function startCron() {
  console.log('[CRON] Scheduler started — checking every 30s (IST)');

  setInterval(() => {
    const data = loadDB();
    const uids      = data.uids      || [];
    const schedules = data.schedules || {};

    if (!uids.length) return;

    // Current IST hour:minute
    const IST_OFFSET = 5.5 * 60 * 60 * 1000;
    const nowIST_d   = new Date(Date.now() + IST_OFFSET);
    const curH   = nowIST_d.getUTCHours();
    const curM   = nowIST_d.getUTCMinutes();
    const today  = nowIST_d.toISOString().substring(0,10);

    const due = uids.filter(u => {
      const sc = schedules[u.id];
      if (!sc || !sc.enabled || !sc.time) return false;
      const [h, m] = sc.time.split(':').map(Number);
      const fireKey = `${u.id}_${today}`;
      if (firedToday[fireKey]) return false; // already ran today
      // Fire if current IST minute matches scheduled time (30s window = within same minute)
      return curH === h && curM === m;
    });

    if (due.length > 0) {
      // Mark all as fired so they don't re-trigger within the same minute
      due.forEach(u => { firedToday[`${u.id}_${today}`] = true; });
      console.log(`[CRON] ⏰ ${due.length} UID(s) due at ${String(curH).padStart(2,'0')}:${String(curM).padStart(2,'0')} IST → starting queue`);
      runCronQueue(due); // async, non-blocking
    }

    // Clean up firedToday keys older than today to prevent memory leak
    Object.keys(firedToday).forEach(k => {
      if (!k.endsWith(today)) delete firedToday[k];
    });

  }, 30 * 1000); // check every 30 seconds
}

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║   FreeLike v3 Server — PORT ${PORT}      ║`);
  console.log(`╚══════════════════════════════════════╝`);
  console.log(`🌐 Dashboard: http://localhost:${PORT}`);
  console.log(`📁 Data file: ${DB}`);
  console.log(`⏰ Cron: runs every 30s, 60s delay between UIDs\n`);
  startCron();
});
