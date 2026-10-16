#!/bin/bash
# Images TAGHRID : bronze (photos iNaturalist) -> silver (catalogue + boîtes pré-annotées) -> gold (dataset YOLO)
set -uo pipefail
cd "$(dirname "$0")/.."
step() { echo; echo "=== $(date '+%F %T') $* ==="; }
filter() { grep --line-buffered -v "WARN\|FutureWarning\|require_minimum\|SLF4J\|::\|Ivy\|jars for\|Stage [0-9]\|Using Spark\|To adjust\|confs\|found \|from central\|artifacts\|^\s*---\|Warning"; }
step "SILVER : catalogue des photos"
.venv/bin/python -u scripts/lake_silver_images.py 2>&1 | filter | tail -30 || { echo IMAGES_FAILED; exit 1; }
step "SILVER : pré-annotation automatique (YOLO COCO, classe bird)"
.venv/bin/python -u scripts/lake_silver_detections.py 2>&1 | filter | grep -v Downloading | tail -5 || { echo IMAGES_FAILED; exit 1; }
step "GOLD : dataset YOLO"
.venv/bin/python -u scripts/lake_gold_images.py 2>&1 | filter | tail -30 || { echo IMAGES_FAILED; exit 1; }
step "IMAGES_DONE"
