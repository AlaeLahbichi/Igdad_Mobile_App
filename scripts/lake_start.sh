#!/bin/bash
# Démarre/arrête le data lake TAGHRID (MinIO natif macOS) sur ./minio/data
#   bash scripts/lake_start.sh          -> API S3 http://localhost:9000, console http://localhost:9001
#   bash scripts/lake_start.sh stop
# MinIO tourne en natif (brew install minio) et non dans Docker : sur macOS, le partage de fichiers
# Docker (VirtioFS) provoque des erreurs "resource deadlock avoided" lors des écritures parallèles de Spark.
set -euo pipefail
cd "$(dirname "$0")/.."
PID_FILE=logs/minio.pid
if [ "${1:-}" = "stop" ]; then
  [ -f "$PID_FILE" ] && kill "$(cat "$PID_FILE")" 2>/dev/null && rm -f "$PID_FILE" && echo "MinIO arrêté"
  exit 0
fi
if curl -sf http://localhost:9000/minio/health/live >/dev/null; then echo "MinIO tourne déjà"; exit 0; fi
set -a; source .env; set +a
mkdir -p minio/data logs
nohup minio server minio/data --address 127.0.0.1:9000 --console-address 127.0.0.1:9001 > logs/minio.log 2>&1 &
echo $! > "$PID_FILE"
until curl -sf http://localhost:9000/minio/health/live >/dev/null; do sleep 1; done
echo "MinIO TAGHRID prêt : API http://localhost:9000 | console http://localhost:9001"
