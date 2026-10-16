#!/usr/bin/env bash
# Lance les serveurs de l'app mobile Igdad : MinIO (data lake TAGHRID) + API Igdad (port 8000).
#   bash scripts/igdad_start.sh            MinIO + API (suffit pour l'app installée sur l'iPhone)
#   bash scripts/igdad_start.sh --expo     + Metro/Expo (port 8081) pour ouvrir l'app dans Expo Go ou développer
#   bash scripts/igdad_start.sh stop       arrête tout (API, Expo, MinIO)
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p logs

if [[ "${1:-}" == "stop" ]]; then
  pkill -f "app/mobile_api.py" && echo "API Igdad arrêtée" || true
  pkill -f "expo start" && echo "Expo arrêté" || true
  bash scripts/lake_start.sh stop || true
  exit 0
fi

bash scripts/lake_start.sh
if ! pgrep -f "app/mobile_api.py" >/dev/null; then
  : > logs/mobile_api.log
  (.venv/bin/python -u app/mobile_api.py > logs/mobile_api.log 2>&1 &)
fi
if [[ "${1:-}" == "--expo" ]] && ! pgrep -f "expo start" >/dev/null; then
  (cd mobile && npx expo start --lan --port 8081 < /dev/null > ../logs/expo.log 2>&1 &)
fi

IP=$(ipconfig getifaddr en0 || echo localhost)
echo "Chargement des modèles…"
until grep -qE "API Igdad|Traceback" logs/mobile_api.log 2>/dev/null; do sleep 1; done
if grep -q Traceback logs/mobile_api.log; then echo "Erreur au démarrage de l'API : voir logs/mobile_api.log"; exit 1; fi
echo "API Igdad : http://$IP:8000   (adresse à mettre dans l'app : Réglages > Serveur)"
[[ "${1:-}" == "--expo" ]] && echo "Expo Go   : exp://$IP:8081"
echo "Console MinIO : http://localhost:9001"
echo "Arrêt : bash scripts/igdad_start.sh stop"
