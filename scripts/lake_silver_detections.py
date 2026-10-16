"""TAGHRID  SILVER : pré-annotation automatique des photos (boîtes englobantes des oiseaux).

Les photos iNaturalist n'ont que l'espèce, pas de boîte. Un YOLO pré-entraîné sur COCO (classe 14 = bird)
détecte les oiseaux sur chaque photo validée de silver/image_catalog ; les boîtes reçoivent ensuite
l'espèce de l'observation (étape gold).

Entrées : s3://taghrid-silver/image_catalog/ (photos décodables, non dupliquées) + images de bronze
Sortie  : s3://taghrid-silver/image_detections/detections.parquet
    observation_id, species, bronze_key, width, height, n_birds,
    boxes = liste de {xc, yc, w, h (normalisés 0-1), conf}

    .venv/bin/python scripts/lake_silver_detections.py              # yolo11l, conf >= 0.25
"""
import argparse
import io
import os
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import boto3
import pyarrow as pa
import pyarrow.dataset as ds
import pyarrow.fs as pafs
import pyarrow.parquet as pq
import torch
from PIL import Image
from ultralytics import YOLO

ROOT = Path(__file__).resolve().parents[1]
COCO_BIRD = 14


def credentials():
    return dict(l.split("=", 1) for l in (ROOT / ".env").read_text().split() if "=" in l)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="yolo11l.pt")
    ap.add_argument("--conf", type=float, default=0.25)
    ap.add_argument("--batch", type=int, default=16)
    args = ap.parse_args()

    env = credentials()
    fs = pafs.S3FileSystem(access_key=env["MINIO_ROOT_USER"], secret_key=env["MINIO_ROOT_PASSWORD"],
                           endpoint_override="localhost:9000", scheme="http", region="us-east-1")
    s3 = boto3.client("s3", endpoint_url="http://localhost:9000", region_name="us-east-1",
                      aws_access_key_id=env["MINIO_ROOT_USER"], aws_secret_access_key=env["MINIO_ROOT_PASSWORD"])
    cat = (ds.dataset("taghrid-silver/image_catalog", filesystem=fs, format="parquet")
           .to_table(columns=["observation_id", "species", "bronze_key", "width", "height"],
                     filter=(ds.field("decodable") == True) & (ds.field("is_duplicate") == False))  # noqa: E712
           .to_pylist())
    print(f"{len(cat)} photos à annoter avec {args.model}")

    weights = ROOT / "models" / args.model
    weights.parent.mkdir(exist_ok=True)
    model = YOLO(str(weights) if weights.exists() else args.model)
    if not weights.exists() and Path(args.model).exists():
        os.replace(args.model, weights)
    device = "mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu"

    def fetch(row):
        body = s3.get_object(Bucket="taghrid-bronze", Key=row["bronze_key"])["Body"].read()
        return Image.open(io.BytesIO(body)).convert("RGB")

    out, t0 = [], time.time()
    with ThreadPoolExecutor(8) as pool:
        for i in range(0, len(cat), args.batch):
            rows = cat[i:i + args.batch]
            images = list(pool.map(fetch, rows))
            results = model.predict(images, classes=[COCO_BIRD], conf=args.conf, imgsz=640, device=device,
                                    verbose=False)
            for row, res in zip(rows, results):
                b = res.boxes
                boxes = [{"xc": float(x), "yc": float(y), "w": float(w), "h": float(h), "conf": float(c)}
                         for (x, y, w, h), c in zip(b.xywhn.tolist(), b.conf.tolist())]
                out.append({**row, "n_birds": len(boxes), "boxes": boxes,
                            "detector": args.model, "detector_conf": args.conf})
            if (i // args.batch) % 50 == 0:
                print(f"  {i + len(rows)}/{len(cat)} photos ({time.time() - t0:.0f}s)", flush=True)

    table = pa.Table.from_pylist(out)
    pq.write_table(table, "taghrid-silver/image_detections/detections.parquet", filesystem=fs)
    n = [r["n_birds"] for r in out]
    print(f"SILVER image_detections : {len(out)} photos | 0 oiseau : {n.count(0)} | 1 oiseau : {n.count(1)} "
          f"| 2+ oiseaux : {sum(k >= 2 for k in n)} | {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
