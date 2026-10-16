#!/bin/bash
# Construit tout le data lake TAGHRID : bronze (sync) -> silver -> gold.  Prérequis : scripts/lake_start.sh
#   SKIP_SILVER_AUDIO=1 bash scripts/lake_build.sh   (si le catalogue audio silver est déjà à jour)
set -uo pipefail
cd "$(dirname "$0")/.."
step() { echo; echo "=== $(date '+%F %T') $* ==="; }
filter() { grep --line-buffered -v "WARN\|Warning:\|Note:\|FutureWarning\|require_minimum\|SLF4J\|libmpg123\|Illegal\|resync\|Stage [0-9]"; }
step "BRONZE : métadonnées API (landing locale -> bronze)"
mc mirror -q --overwrite datalake/raw/xeno_canto taghrid/taghrid-bronze/xeno_canto/api > /dev/null && mc du taghrid/taghrid-bronze/xeno_canto/api
if [ -z "${SKIP_SILVER_AUDIO:-}" ]; then
  step "SILVER : catalogue audio"
  .venv/bin/python -u scripts/lake_silver_audio.py 2>&1 | filter | tail -30 || { echo LAKE_FAILED; exit 1; }
fi
step "GOLD : spectrogrammes d'entraînement"
.venv/bin/python -u scripts/lake_gold_audio.py 2>&1 | filter | tail -30 || { echo LAKE_FAILED; exit 1; }
step "SILVER + GOLD : métadonnées Xeno-Canto (Afrique + Europe)"
.venv/bin/python -u scripts/spark_metadata_analytics.py 2>&1 | filter | tail -60 || { echo LAKE_FAILED; exit 1; }
step "LAKE_DONE"
