#!/bin/bash
# ─────────────────────────────────────────────────────────────
# InsightFlow AI – Oracle Cloud Ubuntu VM Setup Script
# Run as: bash deploy-oracle.sh
# ─────────────────────────────────────────────────────────────
set -e

echo "══════════════════════════════════════════"
echo "  InsightFlow AI – Oracle Cloud Setup"
echo "══════════════════════════════════════════"

# ── 1. System update ──────────────────────────────────────────
echo "[1/8] Updating system packages..."
sudo apt-get update -y && sudo apt-get upgrade -y

# ── 2. Install Node.js 20 LTS ─────────────────────────────────
echo "[2/8] Installing Node.js 20 LTS..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

node -v && npm -v

# ── 3. Install PM2 globally ───────────────────────────────────
echo "[3/8] Installing PM2..."
sudo npm install -g pm2

# ── 4. Install Nginx ──────────────────────────────────────────
echo "[4/8] Installing Nginx..."
sudo apt-get install -y nginx

# ── 5. Install Certbot (Let's Encrypt) ───────────────────────
echo "[5/8] Installing Certbot..."
sudo apt-get install -y certbot python3-certbot-nginx

# ── 6. Configure UFW firewall ─────────────────────────────────
echo "[6/8] Configuring firewall..."
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
# Only allow port 3001 from localhost (Nginx proxies to it)
sudo ufw deny 3001/tcp
sudo ufw --force enable
sudo ufw status

# ── 7. Create project directory ──────────────────────────────
echo "[7/8] Creating project directories..."
mkdir -p /home/ubuntu/insightflow/backend
mkdir -p /home/ubuntu/insightflow/logs

# ── 8. Print next steps ──────────────────────────────────────
echo "[8/8] Base setup complete!"
echo ""
echo "══════ NEXT STEPS ══════"
echo ""
echo "1. Upload your backend files to /home/ubuntu/insightflow/backend/"
echo "   You can use: scp -r ./backend/* ubuntu@<YOUR_IP>:/home/ubuntu/insightflow/backend/"
echo ""
echo "2. Create .env file:"
echo "   nano /home/ubuntu/insightflow/backend/.env"
echo "   (paste contents from backend/.env.example and fill in values)"
echo ""
echo "3. Install Node dependencies:"
echo "   cd /home/ubuntu/insightflow/backend && npm install --production"
echo ""
echo "4. Start with PM2:"
echo "   pm2 start ecosystem.config.cjs"
echo "   pm2 save"
echo "   pm2 startup  ← copy and run the printed command"
echo ""
echo "5. Configure Nginx:"
echo "   sudo cp nginx/nginx.conf /etc/nginx/sites-available/insightflow"
echo "   sudo ln -s /etc/nginx/sites-available/insightflow /etc/nginx/sites-enabled/"
echo "   sudo nginx -t && sudo systemctl reload nginx"
echo ""
echo "6. Get SSL certificate (replace with your domain):"
echo "   sudo certbot --nginx -d YOUR_DOMAIN --non-interactive --agree-tos -m your@email.com"
echo ""
echo "7. Verify:"
echo "   curl https://YOUR_DOMAIN/api/health"
