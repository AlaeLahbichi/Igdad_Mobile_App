"""Entraîne un détecteur YOLO (Ultralytics) des 83 espèces d'oiseaux du Maroc, sur la couche GOLD de TAGHRID.

    bash scripts/lake_start.sh                                          # MinIO doit tourner
    .venv/bin/python scripts/train_yolo_detector.py --check-data        # synchronise + vérifie, sans entraîner
    .venv/bin/python scripts/train_yolo_detector.py                     # yolo11s, 100 epochs
    .venv/bin/python scripts/train_yolo_detector.py --model yolo11m.pt --epochs 150 --clean-cache

Ultralytics lit des fichiers locaux : s3://taghrid-gold/yolo_detection/ est copié dans
data/cache/yolo_detection/ (synchronisation incrémentale), puis data.yaml est réécrit vers ce dossier.
--clean-cache supprime cette copie après l'entraînement (MinIO reste la source de vérité).

Sorties : runs/detect/<date>/ (weights/best.pt, courbes, matrice de confusion) + test_metrics.txt
"""
import argparse
import shutil
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

import boto3
import psutil
import torch

ROOT = Path(__file__).resolve().parents[1]
PREFIX = "yolo_detection/"
CACHE = ROOT / "data" / "cache" / "yolo_detection"


def s3_client():
    env = dict(l.split("=", 1) for l in (ROOT / ".env").read_text().split() if "=" in l)
    return boto3.client("s3", endpoint_url="http://localhost:9000", region_name="us-east-1",
                        aws_access_key_id=env["MINIO_ROOT_USER"], aws_secret_access_key=env["MINIO_ROOT_PASSWORD"])


def sync_gold(s3):
    """Copie incrémentale gold -> cache local ; supprime du cache ce qui n'existe plus dans gold."""
    remote = {}
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket="taghrid-gold", Prefix=PREFIX):
        for o in page.get("Contents", []):
            remote[o["Key"][len(PREFIX):]] = o["Size"]
    todo = [k for k, size in remote.items()
            if not (CACHE / k).exists() or (CACHE / k).stat().st_size != size]

    def get(k):
        (CACHE / k).parent.mkdir(parents=True, exist_ok=True)
        s3.download_file("taghrid-gold", PREFIX + k, str(CACHE / k))

    with ThreadPoolExecutor(16) as pool:
        list(pool.map(get, todo))
    stale = [p for p in CACHE.rglob("*") if p.is_file() and str(p.relative_to(CACHE)) not in remote
             and p.suffix in (".jpg", ".txt")]
    for p in stale:
        p.unlink()
    for cache_file in CACHE.rglob("*.cache"):       # caches de labels Ultralytics : à régénérer
        cache_file.unlink()
    print(f"Gold -> {CACHE} : {len(remote)} fichiers, {len(todo)} téléchargés, {len(stale)} obsolètes supprimés")

    yaml = (CACHE / "data.yaml").read_text().replace("path: .", f"path: {CACHE}")
    (CACHE / "data_local.yaml").write_text(yaml)
    return CACHE / "data_local.yaml"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="yolo11s.pt", help="poids pré-entraînés COCO (yolo11n/s/m/l/x.pt)")
    ap.add_argument("--epochs", type=int, default=100)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--patience", type=int, default=25, help="arrêt si pas d'amélioration (epochs)")
    ap.add_argument("--cache", default="auto", choices=["auto", "ram", "disk", "none"],
                    help="images pré-décodées : ram (le plus rapide), disk (SSD), auto = ram si la mémoire suffit")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--check-data", action="store_true", help="synchronise et vérifie les données, sans entraîner")
    ap.add_argument("--clean-cache", action="store_true", help="supprime la copie locale après l'entraînement")
    args = ap.parse_args()

    data_yaml = sync_gold(s3_client())
    for split in ("train", "val", "test"):
        imgs = list((CACHE / "images" / split).glob("*.jpg"))
        labels = list((CACHE / "labels" / split).glob("*.txt"))
        n_boxes = sum(len(p.read_text().split("\n")) - 1 for p in labels)
        print(f"  {split:<5} {len(imgs)} images, {len(labels)} fichiers labels, {n_boxes} boîtes")
    if args.check_data:
        return

    # cache des images décodées : ~ largeur x hauteur x 3 octets par image d'entraînement (640 px max)
    n_train = len(list((CACHE / "images" / "train").glob("*.jpg")))
    need_gb = n_train * args.imgsz * args.imgsz * 0.75 * 3 / 1e9
    free_gb = psutil.virtual_memory().available / 1e9
    cache = args.cache
    if cache == "auto":
        cache = "ram" if need_gb < 0.6 * free_gb else "disk"
    print(f"Cache images : {cache} (besoin ≈ {need_gb:.1f} Go, RAM disponible ≈ {free_gb:.1f} Go)")
    cache = {"ram": "ram", "disk": "disk", "none": False}[cache]

    from ultralytics import YOLO
    device = "mps" if torch.backends.mps.is_available() else 0 if torch.cuda.is_available() else "cpu"
    weights = ROOT / "models" / args.model
    model = YOLO(str(weights) if weights.exists() else args.model)
    name = datetime.now().strftime("%Y%m%d_%H%M%S")
    model.train(data=str(data_yaml), epochs=args.epochs, imgsz=args.imgsz, batch=args.batch,
                patience=args.patience, device=device, project=str(ROOT / "runs" / "detect"), name=name,
                workers=args.workers, cache=cache, seed=0, plots=True)

    # évaluation finale sur le split test (jamais utilisé pour choisir le modèle)
    run_dir = ROOT / "runs" / "detect" / name
    best = YOLO(str(run_dir / "weights" / "best.pt"))
    m = best.val(data=str(data_yaml), split="test", imgsz=args.imgsz, device=device,
                 project=str(run_dir), name="test")
    report = (f"TEST  mAP50 {m.box.map50:.3f} | mAP50-95 {m.box.map:.3f} | "
              f"précision {m.box.mp:.3f} | rappel {m.box.mr:.3f}\n")
    (run_dir / "test_metrics.txt").write_text(report)
    print(report + f"Résultats -> {run_dir}")

    if args.clean_cache:
        shutil.rmtree(CACHE)
        print(f"Cache local supprimé ({CACHE})")


if __name__ == "__main__":
    main()
