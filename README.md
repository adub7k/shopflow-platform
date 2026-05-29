# Woods Test CRM — Web + Mobile PWA

Shared backend CRM for desktop and mobile. One database, real-time sync between all devices.

---

## How it works

```
Phone (PWA) ──┐
              ├──→ Express Server + SQLite DB (Railway)
Desktop  ─────┘
```

Both the phone and desktop connect to the same server. Any change on one device shows up on the other instantly.

---

## Deploy to Railway (5 minutes)

### Step 1 — Create a Railway account
Go to **railway.app** and sign up (free, no credit card needed to start).

### Step 2 — Deploy
1. Go to **railway.app/new**
2. Click **"Deploy from GitHub repo"** OR **"Empty project"**
3. If using GitHub: push this folder to a GitHub repo first, then connect it
4. If empty project: click **"Add service"** → **"GitHub Repo"** → select your repo

### Step 3 — Set environment variables (optional)
In Railway dashboard → your service → Variables:
```
PORT=3000
DATA_DIR=/app/data
```

### Step 4 — Get your URL
Railway gives you a URL like: `https://woods-test-crm-production.up.railway.app`

That's your app URL. Open it on your phone and it works immediately.

---

## Install on iPhone (PWA)

1. Open Safari on iPhone
2. Go to your Railway URL
3. Tap the **Share** button (box with arrow)
4. Tap **"Add to Home Screen"**
5. Tap **"Add"**

The app now has an icon on your home screen, opens full screen, and works like a real app.

---

## Install on Android (PWA)

1. Open Chrome on Android
2. Go to your Railway URL
3. Tap the **3-dot menu** → **"Add to Home screen"**
4. Tap **"Add"**

---

## Run locally for testing

```bash
npm install
npm start
```

Then open `http://localhost:3000` in your browser.

---

## Connect the desktop Electron app

Update the desktop CRM's `preload.js` API base URL to point to your Railway URL instead of localhost. This makes the desktop and phone share the same data.

---

## Data

Your data is stored in a SQLite database on Railway's persistent storage.
- File location: `/app/data/woods-test.db`
- Back it up from the Railway dashboard → Files

---

## Features

| Feature | Mobile | Desktop |
|---|---|---|
| Dashboard (morning briefing) | ✓ | ✓ |
| Lead pipeline (6 stages) | ✓ | ✓ |
| Jobs with quick status | ✓ | ✓ |
| Customer profiles | ✓ | ✓ |
| Appointments (month view) | ✓ | ✓ |
| Invoices | ✓ | ✓ |
| Fleet accounts | ✓ | ✓ |
| Follow-up tasks | ✓ | ✓ |
| Revenue analytics | ✓ | ✓ |
| Settings | ✓ | ✓ |
| Loyalty tracking | ✓ | ✓ |
| Works offline | ✓ (cached) | ✓ |
| Installs on home screen | ✓ | ✓ (.exe) |
| Real-time sync | ✓ | ✓ |
