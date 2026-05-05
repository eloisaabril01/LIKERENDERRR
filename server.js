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
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) { console.error('loadData:', e.message); }
  return {
    history: [],
    stats: { total: 0, today: 0, todayDate: '', sessions: 0, autoRuns: 0, lastRun: '' },
    schedule: { enabled: false, time: '06:00', uid: '2908376165', server: 'ind' }
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

// ─── SELF PING (keeps Render free tier awake) ────────────────
function startSelfPing() {
  const url = process.env.RENDER_EXTERNAL_URL;
  if (!url) { console.log('⚠️  No RENDER_EXTERNAL_URL set — self-ping disabled'); return; }
  setInterval(async () => {
    try {
      await fetch(`${url}/api/status`);
      console.log(`🏓 Self-ping OK [${fmtIST()} IST]`);
    } catch (e) { console.error('Self-ping failed:', e.message); }
  }, 10 * 60 * 1000); // every 10 minutes
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

// ─── CRON (every minute, checks IST time) ────────────────────
let cronJob = null;

function startCron() {
  if (cronJob) { cronJob.destroy(); cronJob = null; }
  cronJob = cron.schedule('* * * * *', () => {
    const data = loadData();
    if (!data.schedule.enabled || !data.schedule.uid) return;
    const ist = getIST();
    const hh = String(ist.getHours()).padStart(2, '0');
    const mm = String(ist.getMinutes()).padStart(2, '0');
    if (`${hh}:${mm}` === (data.schedule.time || '06:00')) {
      console.log(`⏰ CRON FIRED at ${hh}:${mm} IST`);
      sendLike(data.schedule.uid, data.schedule.server, true);
    }
  });
  console.log('✅ Cron scheduler running');
}

// ─── ROUTES ──────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  const data = loadData();
  res.json({
    uptime: Math.floor(process.uptime()),
    serverTime: fmtIST() + ' IST',
    scheduleEnabled: data.schedule.enabled,
    scheduleTime: data.schedule.time,
    scheduleUID: data.schedule.uid,
    totalRecords: data.history.length,
    totalLikes: data.stats.total || 0
  });
});

app.get('/api/data', (req, res) => res.json(loadData()));

app.post('/api/data', (req, res) => {
  try {
    const current = loadData();
    const updated = { ...current, ...req.body };
    if (!req.body.history || req.body.history.length === 0) updated.history = current.history;
    saveData(updated);
    startCron();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/like', async (req, res) => {
  const { uid, server } = req.body;
  if (!uid || !server) return res.status(400).json({ error: 'Missing uid or server' });
  const result = await sendLike(uid, server, false);
  res.json(result);
});

app.get('/api/schedule', (req, res) => res.json(loadData().schedule));

app.post('/api/schedule', (req, res) => {
  const data = loadData();
  data.schedule = { ...data.schedule, ...req.body };
  saveData(data);
  startCron();
  res.json({ ok: true, schedule: data.schedule });
});

app.delete('/api/history', (req, res) => {
  const data = loadData();
  data.history = [];
  saveData(data);
  res.json({ ok: true });
});

// ─── START ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 FreeLike Server on port ${PORT}`);
  const data = loadData();
  console.log(`⏰ Schedule: ${data.schedule.enabled ? 'ON at ' + data.schedule.time + ' IST' : 'OFF'}`);
  startCron();
  startSelfPing();
});
