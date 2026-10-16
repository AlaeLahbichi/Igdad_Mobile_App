#!/bin/bash
# Initialise le data lake TAGHRID sur MinIO (lancer d'abord scripts/lake_start.sh) : alias mc + buckets médaillon.
#   bronze : données brutes, telles que reçues (audio Xeno-Canto + JSON de l'API)
#   silver : données nettoyées, typées, validées (Parquet)
#   gold   : données prêtes à l'emploi (spectrogrammes d'entraînement, tables d'analyse)
set -euo pipefail
cd "$(dirname "$0")/.."
source .env
until curl -sf http://localhost:9000/minio/health/live >/dev/null; do sleep 1; done
mc alias set taghrid http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
for b in taghrid-bronze taghrid-silver taghrid-gold; do mc mb --ignore-existing "taghrid/$b"; done
mc ls taghrid
