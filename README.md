# InsightFlow AI – Production Deployment Guide

## Architecture

```
User Browser
     │
     ├──► Vercel (Frontend – React/Vite)
     │         • Serves static files globally via CDN
     │         • All /api/* calls go to Oracle backend
     │
     └──► Oracle Cloud Ubuntu VM (Backend – Node.js/Express)
               • Nginx (port 80/443) reverse-proxies to
               • PM2-managed Node.js (port 3001, internal only)
               • Proxies requests to: Gemini, OpenAI, Groq, Claude, HuggingFace
               • Sends emails via SMTP (Nodemailer)
               • Fetches article URLs (SSRF-protected)
```

---

## Project Structure

```
InsightFlow_Production/
├── frontend/                  ← Deploy to Vercel
│   ├── src/
│   │   ├── App.jsx            ← Main React app (API calls use VITE_API_URL)
│   │   └── main.jsx           ← React entry point
│   ├── public/
│   │   └── logo.jpg           ← Logo (copy from original project)
│   ├── index.html
│   ├── package.json
│   ├── vite.config.js         ← Includes dev proxy for /api/*
│   ├── vercel.json            ← SPA routing rewrite rule
│   └── .env.example
│
├── backend/                   ← Deploy to Oracle Cloud VM
│   ├── server.js              ← Express API server (production-ready)
│   ├── package.json
│   ├── ecosystem.config.cjs   ← PM2 config for 24/7 operation
│   └── .env.example
│
├── nginx/
│   └── nginx.conf             ← Nginx reverse proxy with SSL
│
├── scripts/
│   └── deploy-oracle.sh       ← One-shot Oracle Cloud setup script
│
└── .gitignore
```

---

## Step 1 – Prepare the Repository

```bash
# Copy logo to frontend/public/
cp <original_project>/public/logo.jpg frontend/public/logo.jpg

# Also place logo in backend/public/ (used by email attachments)
mkdir -p backend/public
cp <original_project>/public/logo.jpg backend/public/logo.jpg

# Initialize git
git init
git add .
git commit -m "Initial production setup"
# Push to GitHub/GitLab (required for Vercel auto-deploy)
git remote add origin https://github.com/YOUR_USERNAME/insightflow-ai.git
git push -u origin main
```

---

## Step 2 – Deploy Frontend to Vercel

### Option A – Vercel Dashboard (recommended)

1. Go to [vercel.com](https://vercel.com) → **New Project**
2. Import your GitHub repository
3. Set these values:
   - **Root Directory:** `frontend`
   - **Framework Preset:** Vite
   - **Build Command:** `npm run build`
   - **Output Directory:** `dist`
4. Add **Environment Variable:**
   - `VITE_API_URL` = `https://api.yourdomain.com`  
     *(or `http://<ORACLE_PUBLIC_IP>:3001` if you don't have a domain yet)*
5. Click **Deploy**

### Option B – Vercel CLI

```bash
cd frontend
npm install -g vercel
vercel login
vercel --prod
# Follow prompts; set VITE_API_URL when asked for env vars
```

> **Note:** After deploying, copy your Vercel URL (e.g. `https://insightflow-abc123.vercel.app`).
> You'll need it for the backend `ALLOWED_ORIGIN` variable.

---

## Step 3 – Set Up Oracle Cloud VM

### 3a. Oracle Cloud Free Tier VM

1. Sign up at [cloud.oracle.com](https://cloud.oracle.com) (free tier)
2. Create a **Compute Instance**: Ubuntu 22.04, VM.Standard.E2.1.Micro (free)
3. Download your SSH key
4. Open ports in Oracle's security list:
   - **Ingress:** TCP port 80, 443 (from 0.0.0.0/0)
   - **Ingress:** TCP port 22 (SSH – restrict to your IP)

### 3b. SSH into your VM

```bash
ssh -i your-key.pem ubuntu@<ORACLE_PUBLIC_IP>
```

### 3c. Run the setup script

```bash
# Upload the scripts folder first
scp -i your-key.pem scripts/deploy-oracle.sh ubuntu@<IP>:~/
ssh -i your-key.pem ubuntu@<IP>
bash deploy-oracle.sh
```

### 3d. Upload backend files

```bash
# From your local machine:
scp -i your-key.pem -r backend/* ubuntu@<IP>:/home/ubuntu/insightflow/backend/
scp -i your-key.pem -r nginx/nginx.conf ubuntu@<IP>:~/nginx.conf
```

### 3e. Create .env on the VM

```bash
cd /home/ubuntu/insightflow/backend
cp .env.example .env
nano .env
```

Fill in:
```env
NODE_ENV=production
PORT=3001
ALLOWED_ORIGIN=https://your-app.vercel.app
```

### 3f. Install dependencies and start PM2

```bash
cd /home/ubuntu/insightflow/backend
npm install --production
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # Copy and run the printed command!
```

### 3g. Configure Nginx

```bash
sudo cp ~/nginx.conf /etc/nginx/sites-available/insightflow
# Edit the file to replace YOUR_DOMAIN with your actual domain or IP
sudo nano /etc/nginx/sites-available/insightflow

sudo ln -s /etc/nginx/sites-available/insightflow /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default   # Remove default site
sudo nginx -t                                  # Test config
sudo systemctl reload nginx
```

### 3h. (Optional) Get SSL with Let's Encrypt

*Only if you have a real domain name pointing to your Oracle IP.*

```bash
sudo certbot --nginx -d api.yourdomain.com \
  --non-interactive --agree-tos -m your@email.com
sudo systemctl reload nginx
```

If you don't have a domain yet, expose port 3001 temporarily:
```bash
sudo ufw allow 3001/tcp
```
And use `VITE_API_URL=http://<ORACLE_IP>:3001` in Vercel.

---

## Step 4 – Verify Everything

```bash
# On Oracle VM – check PM2 is running
pm2 status
pm2 logs insightflow-backend --lines 20

# Health check from anywhere
curl https://api.yourdomain.com/api/health
# Expected: {"status":"ok","timestamp":"..."}
```

Open your Vercel URL in a browser. The app should load and all features should work.

---

## Environment Variables Reference

### Frontend (Vercel Dashboard)

| Variable       | Example Value                         | Description                  |
|----------------|---------------------------------------|------------------------------|
| `VITE_API_URL` | `https://api.yourdomain.com`          | Backend base URL (no slash)  |

### Backend (.env on Oracle VM)

| Variable          | Example Value                          | Description                       |
|-------------------|----------------------------------------|-----------------------------------|
| `NODE_ENV`        | `production`                           | Enables prod mode                 |
| `PORT`            | `3001`                                 | Express listen port               |
| `ALLOWED_ORIGIN`  | `https://your-app.vercel.app`          | Your Vercel domain for CORS       |

---

## Files Modified from Original

| File | Change |
|------|--------|
| `frontend/src/App.jsx` | Added `API_BASE` constant using `import.meta.env.VITE_API_URL`; replaced all `fetch("/api/...")` with `fetch(\`${API_BASE}/api/...\`)` |
| `backend/server.js` | Removed static file serving (frontend is on Vercel); added `/api/health` endpoint; fixed logo path to use `public/` only; SSL rejection only disabled in non-production; added structured logging |
| `frontend/vite.config.js` | New file — adds dev proxy so `/api/*` calls work locally without CORS |
| `frontend/vercel.json` | New file — SPA rewrite rule so React Router URLs don't 404 |
| `backend/ecosystem.config.cjs` | New file — PM2 config for 24/7 uptime |
| `nginx/nginx.conf` | New file — Nginx reverse proxy with SSL and security headers |

---

## Troubleshooting

**CORS error in browser console**
→ Check `ALLOWED_ORIGIN` in backend `.env` matches exactly your Vercel URL (no trailing slash)

**`fetch` calls return 404**
→ Check `VITE_API_URL` in Vercel env vars. Redeploy after changing env vars.

**PM2 process not running after reboot**
→ Run `pm2 startup` and execute the printed command, then `pm2 save`

**Nginx 502 Bad Gateway**
→ PM2 app crashed. Run `pm2 logs insightflow-backend` to see the error.

**Email not sending**
→ SMTP credentials are passed from the browser (not stored server-side). Check the SMTP host/port/credentials in the app's Settings page.
