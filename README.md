# FreeLike v3 — 24/7 Node Server

## Why This Version?
Vercel is "serverless" — it sleeps when nobody is visiting.
This is a real Node.js server that runs 24/7 with a built-in cron job.

## ✅ Best Free Hosting: Railway (Recommended)

### Deploy to Railway (5 minutes, free)
1. Go to https://railway.app → Sign up with GitHub (free)
2. Click **"New Project"** → **"Deploy from GitHub repo"**
   - OR click **"Deploy from template"** → upload this folder
3. Railway auto-detects Node.js and runs `npm start`
4. Done! Your server runs 24/7 — no sleeping

### OR: Render (also free, sleeps after 15min on free tier)
1. Go to https://render.com → New → Web Service
2. Upload or connect repo
3. Build Command: `npm install`
4. Start Command: `node server.js`
5. ⚠️ Free tier sleeps after 15min — upgrade to $7/mo to keep awake

### Railway is better — free tier stays awake 24/7

## Files
- `server.js` — Express server + cron job + API routes
- `public/index.html` — Dashboard frontend
- `package.json` — Dependencies
- `Procfile` — For Railway/Render
- `data.json` — Auto-created, stores all your data permanently

## How Data is Saved
All data is written to `data.json` on the server disk.
Railway keeps this file permanently between deploys.

## API Routes
- GET  /api/data       — get all data
- POST /api/data       — save all data  
- POST /api/like       — send a like
- GET  /api/schedule   — get schedule
- POST /api/schedule   — update schedule
- DELETE /api/history  — clear history
- GET  /api/status     — server health
