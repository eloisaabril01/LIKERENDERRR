const express = require('express');
const cron = require('node-cron');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── DATA ────────────────────────────────────────────────────
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      // Ensure new fields always present
      if (!d.uids) d.uids = [];
      if (!d.schedules) d.schedules = {};
      if (!d.stats) d.stats = { total: 0, today: 0, todayDate: '', sessions: 0, autoRuns: 0, lastRun: '' };
      if (!d.history) d.history = [];
      return d;
    }
  } catch (e) { console.error('loadData:', e.message); }
  return {
    history: [],
    stats: { total: 0, today: 0, todayDate: '', sessions: 0, autoRuns: 0, lastRun: '' },
    uids: [],
    schedules: {}
  };
}

function saveData(data) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }
  catch (e) { console.error('saveData:', e.message); }
}

function getIST() {
  return new Date(new Date().getTime() + 5.5 * 3600000);
}

function fmtIST() {
  return getIST().toISOString().replace('T', ' ').substring(0, 19);
}

function pad(n) { return String(n).padStart(2, '0'); }

// ─── SELF PING (keeps Render free tier awake) ────────────────
function startSelfPing() {
  const url = process.env.RENDER_EXTERNAL_URL;
  if (!url) { console.log('⚠️  No RENDER_EXTERNAL_URL set — self-ping disabled'); return; }
  setInterval(async () => {
    try {
      await fetch(`${url}/api/status`);
      console.log(`🏓 Self-ping OK [${fmtIST()} IST]`);
    } catch (e) { console.error('Self-ping failed:', e.message); }
  }, 10 * 60 * 1000);
  console.log(`🏓 Self-ping started → ${url}/api/status`);
}

// ─── LIKE FUNCTION ───────────────────────────────────────────
async function sendLike(uid, server, isAuto = false) {
  const data = loadData();
  const url = `https://sneha-like-api-ixc1.vercel.app/like?uid=${uid}&server_name=${server}`;
  console.log(`[${fmtIST()} IST] ${isAuto ? '🤖 AUTO' : '👆 MANUAL'} like → UID:${uid} Server:${server}`);

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const apiData = await res.json();

    const ist = getIST();
    const timeStr = fmtIST();
    const dateStr = ist.toISOString().substring(0, 10);

    const entry = {
      id: Date.now(),
      time: timeStr,
      date: dateStr,
      uid: apiData.UID || uid,
      nickname: apiData.PlayerNickname || '—',
      server: server.toUpperCase(),
      before: apiData.LikesbeforeCommand ?? '—',
      after: apiData.LikesafterCommand ?? '—',
      given: apiData.LikesGivenByAPI ?? 0,
      type: isAuto ? 'AUTO' : 'MANUAL',
      status: apiData.status === 1 ? 'SUCCESS' : 'FAILED'
    };

    data.history.unshift(entry);
    if (data.history.length > 1000) data.history.pop();
    data.stats.sessions = (data.stats.sessions || 0) + 1;
    data.stats.total = (data.stats.total || 0) + (entry.given || 0);
    if (data.stats.todayDate !== dateStr) { data.stats.today = 0; data.stats.todayDate = dateStr; }
    data.stats.today = (data.stats.today || 0) + (entry.given || 0);
    data.stats.lastRun = timeStr;
    if (isAuto) data.stats.autoRuns = (data.stats.autoRuns || 0) + 1;

    saveData(data);
    console.log(`✅ ${entry.status} — ${entry.nickname} | Before:${entry.before} After:${entry.after} Given:+${entry.given}`);
    return { ok: true, entry, apiData };
  } catch (e) {
    console.error(`❌ Like failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// ─── SLEEP HELPER ─────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── MULTI-UID CRON (every minute, checks IST time) ──────────
// Tracks which uid+date combos already fired today
const firedToday = {}; // key: uid_id + '_' + dateStr
let cronQueueRunning = false;

let cronJob = null;

async function runCronQueue(dueuids) {
  if (cronQueueRunning) {
    console.log('⚠️ Cron queue already running, skipping');
    return;
  }
  cronQueueRunning = true;
  console.log(`🤖 CRON QUEUE START: ${dueuids.length} UIDs to process`);

  for (let i = 0; i < dueuids.length; i++) {
    const { uid, server, nick, uid_id } = dueuids[i];
    console.log(`🤖 [${i+1}/${dueuids.length}] Sending AUTO like → ${nick} (${uid}) on ${server}`);
    await sendLike(uid, server, true);

    if (i < dueuids.length - 1) {
      console.log(`⏳ Waiting 60s before next UID...`);
      await sleep(60000); // 60 second delay between UIDs
    }
  }

  console.log(`✅ CRON QUEUE DONE: ${dueuids.length} UIDs processed`);
  cronQueueRunning = false;
}

function startCron() {
  if (cronJob) { cronJob.destroy(); cronJob = null; }

  cronJob = cron.schedule('* * * * *', () => {
    const data = loadData();
    if (!data.uids || !data.uids.length) return;

    const ist = getIST();
    const hh = pad(ist.getUTCHours());
    const mm = pad(ist.getUTCMinutes());
    const currentTime = `${hh}:${mm}`;
    const dateStr = ist.toISOString().substring(0, 10);

    // Find all UIDs whose schedule time matches right now and haven't fired today
    const due = [];
    for (const u of data.uids) {
      const sc = data.schedules[u.id];
      if (!sc || !sc.enabled || !sc.time) continue;

      const fireKey = u.id + '_' + dateStr;
      if (firedToday[fireKey]) continue; // already ran today

      if (sc.time === currentTime) {
        firedToday[fireKey] = true;
        const server = sc.server || u.server || 'ind';
        due.push({ uid: u.uid, server, nick: u.nick || u.uid, uid_id: u.id });
        console.log(`⏰ CRON MATCH: ${u.nick} (${u.uid}) at ${currentTime} IST → server:${server}`);
      }
    }

    if (due.length > 0) {
      runCronQueue(due); // fire async, don't await in cron tick
    }
  });

  console.log('✅ Multi-UID cron scheduler running');
}

// ─── ROUTES ──────────────────────────────────────────────────

// Status
app.get('/api/status', (req, res) => {
  const data = loadData();
  const activeSchedules = Object.values(data.schedules || {}).filter(sc => sc && sc.enabled).length;
  res.json({
    uptime: Math.floor(process.uptime()),
    serverTime: fmtIST() + ' IST',
    scheduleEnabled: activeSchedules > 0,
    activeSchedules,
    totalUIDs: (data.uids || []).length,
    totalRecords: data.history.length,
    totalLikes: data.stats.total || 0,
    cronQueueRunning
  });
});

// Get all data
app.get('/api/data', (req, res) => res.json(loadData()));

// Save uids + schedules (called by frontend on every change)
app.post('/api/uids', (req, res) => {
  try {
    const data = loadData();
    if (req.body.uids !== undefined) data.uids = req.body.uids;
    if (req.body.schedules !== undefined) data.schedules = req.body.schedules;
    saveData(data);
    startCron(); // restart cron so it picks up new schedules immediately
    const activeSchedules = Object.values(data.schedules || {}).filter(sc => sc && sc.enabled).length;
    console.log(`💾 UIDs saved: ${data.uids.length} UIDs, ${activeSchedules} active schedules`);
    res.json({ ok: true, uids: data.uids.length, activeSchedules });
  } catch (e) {
    console.error('POST /api/uids error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Legacy /api/data POST (keep for compatibility)
app.post('/api/data', (req, res) => {
  try {
    const current = loadData();
    if (req.body.uids !== undefined) current.uids = req.body.uids;
    if (req.body.schedules !== undefined) current.schedules = req.body.schedules;
    if (req.body.stats !== undefined) current.stats = req.body.stats;
    // Never overwrite history from client (server is source of truth for history)
    saveData(current);
    startCron();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Manual like
app.post('/api/like', async (req, res) => {
  const { uid, server } = req.body;
  if (!uid || !server) return res.status(400).json({ error: 'Missing uid or server' });
  const result = await sendLike(uid, server, false);
  res.json(result);
});

// Clear history
app.delete('/api/history', (req, res) => {
  const data = loadData();
  data.history = [];
  data.stats = { total: 0, today: 0, todayDate: '', sessions: 0, autoRuns: 0, lastRun: '' };
  saveData(data);
  res.json({ ok: true });
});

// Schedule per UID (convenience endpoint)
app.post('/api/schedule/:uid_id', (req, res) => {
  try {
    const data = loadData();
    data.schedules[req.params.uid_id] = { ...data.schedules[req.params.uid_id], ...req.body };
    saveData(data);
    startCron();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Debug: show current schedules
app.get('/api/debug', (req, res) => {
  const data = loadData();
  const ist = getIST();
  res.json({
    serverTime: fmtIST() + ' IST',
    cronQueueRunning,
    firedToday,
    uids: (data.uids || []).map(u => ({
      id: u.id, uid: u.uid, nick: u.nick,
      schedule: data.schedules[u.id] || null
    }))
  });
});

// ─── START ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 FreeLike Server on port ${PORT}`);
  const data = loadData();
  const activeSchedules = Object.values(data.schedules || {}).filter(sc => sc && sc.enabled).length;
  console.log(`📋 Loaded: ${(data.uids||[]).length} UIDs, ${activeSchedules} active schedules`);
  startCron();
  startSelfPing();
});
