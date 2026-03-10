#!/bin/bash
# Boot script for first-impression worker EC2 instances.
# Runs as ExecStartPre in systemd: pulls latest code and installs deps.

set -e

cd /home/workspace/first-impression

echo "[boot] Pulling latest code..."
git pull origin main

echo "[boot] Installing dependencies..."
pnpm install --frozen-lockfile

echo "[boot] Ready"
