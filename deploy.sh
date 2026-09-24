#!/bin/bash
set -e

echo "=========================================="
echo "   Coffeemia POS PM2 AlmaLinux 9 Deploy   "
echo "=========================================="

# Check for .env file
if [ ! -f .env ] && [ ! -f .env.production ]; then
  echo "[-] Error: No .env file found!"
  echo "[!] Please ensure .env or .env.production exists with database credentials."
  exit 1
fi

echo "[1/3] Installing npm dependencies..."
npm install --production
chmod -R +x node_modules/.bin 2>/dev/null || true

echo "[2/3] Validating application files..."
if [ ! -f server.js ]; then
  echo "[-] Error: server.js not found!"
  exit 1
fi

echo "[3/3] Reloading PM2 process..."
if pm2 describe coffeemia-pos > /dev/null 2>&1; then
  pm2 reload ecosystem.config.js --env production
else
  pm2 start ecosystem.config.js --env production
fi

pm2 save

echo "=========================================="
echo " Deployment successful! PM2 service live. "
echo " Check status with: pm2 status            "
echo " View logs with:   pm2 logs coffeemia-pos "
echo "=========================================="
