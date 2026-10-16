"""Interface web TAGHRID : reconnaissance des oiseaux du Maroc par le CHANT (audio) et par la PHOTO (image).

    bash scripts/lake_start.sh                         # MinIO (exemples de test)
    .venv/bin/python app/server.py                     # derniers modèles de runs/audio/ et runs/detect/
    .venv/bin/python app/server.py --model runs/audio/<date>/best.pt --detector runs/detect/<date>/weights/best.pt

Puis ouvrir http://localhost:8000 (le micro n'est autorisé que sur localhost ou en https).

Le navigateur envoie chaque seconde les 5 dernières secondes de son (PCM float32) à /api/predict ;
le serveur refait exactement le prétraitement de l'entraînement (32 kHz, mel 128, dB) et renvoie le top 5.
Image : /api/detect reçoit une photo (JPEG/PNG) et renvoie l'oiseau détecté avec la plus forte confiance
(YOLO entraîné sur les 83 espèces) ; l'interface ne l'affiche que s'il dépasse le seuil choisi.

Les enregistrements de démonstration sont lus dans le data lake TAGHRID (MinIO, lancer
scripts/lake_start.sh) : métadonnées dans taghrid-bronze, split de test dans taghrid-gold.
"""
import argparse
import csv
import io
import json
import random
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import boto3
import librosa
import numpy as np
import timm
import torch
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]
STATIC = Path(__file__).resolve().parent / "static"
BRONZE, GOLD = "taghrid-bronze", "taghrid-gold"
AUDIO_PREFIX = "xeno_canto/audio/"
IMAGE_PREFIX = "yolo_detection/images/test/"


def s3_client():
    env = dict(l.split("=", 1) for l in (ROOT / ".env").read_text().split() if "=" in l)
    return boto3.client("s3", endpoint_url="http://localhost:9000", region_name="us-east-1",
                        aws_access_key_id=env["MINIO_ROOT_USER"], aws_secret_access_key=env["MINIO_ROOT_PASSWORD"])


def read_csv(s3, bucket, key):
    body = s3.get_object(Bucket=bucket, Key=key)["Body"].read().decode()
    return list(csv.DictReader(io.StringIO(body)))


class Predictor:
    def __init__(self, ckpt_path):
        ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=False)
        self.cfg = ckpt["config"]
        self.classes = ckpt["classes"]
        self.model = timm.create_model(ckpt["model"], pretrained=False, num_classes=len(self.classes),
                                       in_chans=1, drop_rate=0.3)
        self.model.load_state_dict(ckpt["state_dict"])
        self.model.eval()
        self.lock = threading.Lock()

    def predict(self, pcm, sr, k=5):
        c = self.cfg
        y = pcm.astype(np.float32)
        if sr != c["sr"]:
            y = librosa.resample(y, orig_sr=sr, target_sr=c["sr"])
        n = int(c["chunk_s"] * c["sr"])
        y = y[-n:] if len(y) >= n else np.pad(y, (n - len(y), 0))
        if not np.any(y):
            return []
        m = librosa.feature.melspectrogram(y=y, sr=c["sr"], n_fft=c["n_fft"], hop_length=c["hop_length"],
                                           n_mels=c["n_mels"], fmin=c["fmin"], fmax=c["fmax"], power=2.0)
        db = librosa.power_to_db(m, ref=np.max, top_db=80.0).astype(np.float16).astype(np.float32)
        x = torch.from_numpy((db + 40.0) / 40.0)[None, None]
        with self.lock, torch.no_grad():
            p = self.model(x).softmax(-1)[0].numpy()
        top = np.argsort(p)[::-1][:k]
        return [{"species": self.classes[i], "prob": float(p[i])} for i in top]


class Detector:
    """Détecteur YOLO des 83 espèces : ne renvoie que la détection la plus sûre."""

    def __init__(self, weights):
        from ultralytics import YOLO
        self.model = YOLO(str(weights))
        self.names = self.model.names
        self.device = "mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu"
        self.lock = threading.Lock()

    def detect(self, data):
        im = ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("RGB")
        with self.lock:
            res = self.model.predict(im, conf=0.05, imgsz=640, device=self.device, verbose=False)[0]
        out = {"width": im.width, "height": im.height, "best": None}
        if len(res.boxes):
            i = int(res.boxes.conf.argmax())
            x1, y1, x2, y2 = res.boxes.xyxyn[i].tolist()
            out["best"] = {"species": self.names[int(res.boxes.cls[i])], "conf": float(res.boxes.conf[i]),
                           "box": [x1, y1, x2, y2]}
        return out


def list_image_samples(s3):
    """Images du split test du détecteur (jamais vues à l'entraînement), lues dans taghrid-gold."""
    keys = []
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=GOLD, Prefix=IMAGE_PREFIX):
        keys += [o["Key"][len(IMAGE_PREFIX):] for o in page.get("Contents", [])]
    by_sp = {}
    for k in keys:
        by_sp.setdefault(k.rsplit("_", 1)[0], []).append(k)
    return by_sp


def load_species_info(s3):
    """Nom anglais + enregistrements de test (jamais vus à l'entraînement) par espèce, depuis le data lake."""
    meta = read_csv(s3, BRONZE, "xeno_canto/downloads/metadata.csv")
    test_ids = {r["recording_id"] for r in read_csv(s3, GOLD, "audio_training/manifest.csv") if r["split"] == "test"}
    info = {}
    for r in meta:
        info.setdefault(r["species"], {"en": r["en"], "samples": []})
        if r["id"] in test_ids:
            info[r["species"]]["samples"].append({"id": r["id"], "path": r["path"], "type": r["type"],
                                                  "length": r["length"], "q": r["q"]})
    return info


def make_handler(predictor, info, s3, detector, images):
    allowed = {smp["path"] for v in info.values() for smp in v["samples"]}  # seuls les extraits de test
    allowed_img = {k for v in images.values() for k in v}
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(STATIC), **kw)

        def log_message(self, fmt, *args):
            if not any(p in (str(args[0]) if args else "") for p in ("/api/predict", "/api/detect")):
                super().log_message(fmt, *args)

        def send_json(self, obj, code=200):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            url = urlparse(self.path)
            if url.path == "/api/species":
                return self.send_json({s: {"en": v["en"], "n_test": len(v["samples"])}
                                       for s, v in info.items() if s in predictor.classes})
            if url.path == "/api/samples":
                out = []
                for s, v in sorted(info.items()):
                    if s in predictor.classes and v["samples"]:
                        smp = random.choice(v["samples"])
                        out.append({"species": s, "en": v["en"], **smp})
                return self.send_json(out)
            if url.path == "/api/image_samples":
                out = [{"species": s, "en": info.get(s, {}).get("en", ""), "name": random.choice(v)}
                       for s, v in sorted(images.items())]
                return self.send_json(out)
            if url.path.startswith("/image/"):
                name = unquote(url.path[len("/image/"):])
                if name not in allowed_img:
                    return self.send_error(404)
                data = s3.get_object(Bucket=GOLD, Key=IMAGE_PREFIX + name)["Body"].read()
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                return self.wfile.write(data)
            if url.path.startswith("/audio/"):
                rel = unquote(url.path[len("/audio/"):])
                if rel not in allowed:
                    return self.send_error(404)
                data = s3.get_object(Bucket=BRONZE, Key=AUDIO_PREFIX + rel)["Body"].read()
                self.send_response(200)
                self.send_header("Content-Type", "audio/wav" if rel.endswith(".wav") else "audio/mpeg")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                return self.wfile.write(data)
            return super().do_GET()

        def do_POST(self):
            url = urlparse(self.path)
            if url.path == "/api/detect":
                n = int(self.headers.get("Content-Length", 0))
                if n <= 0 or n > 25 * 1024 * 1024:
                    return self.send_error(400)
                try:
                    out = detector.detect(self.rfile.read(n))
                except Exception as e:
                    return self.send_json({"error": f"image illisible : {e}"}, 400)
                if out["best"]:
                    out["best"]["en"] = info.get(out["best"]["species"], {}).get("en", "")
                return self.send_json(out)
            if url.path != "/api/predict":
                return self.send_error(404)
            sr = int(parse_qs(url.query).get("sr", ["32000"])[0])
            n = int(self.headers.get("Content-Length", 0))
            if n <= 0 or n > 4 * 48000 * 12:
                return self.send_error(400)
            pcm = np.frombuffer(self.rfile.read(n), dtype=np.float32)
            top = predictor.predict(pcm, sr)
            for t in top:
                t["en"] = info.get(t["species"], {}).get("en", "")
            self.send_json({"top": top})

    return Handler


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=None, help="chemin vers best.pt (défaut : dernier run)")
    ap.add_argument("--detector", default=None, help="poids YOLO (défaut : dernier runs/detect/*/weights/best.pt)")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()
    ckpt = Path(args.model) if args.model else sorted((ROOT / "runs" / "audio").glob("*/best.pt"))[-1]
    det = Path(args.detector) if args.detector else sorted((ROOT / "runs" / "detect").glob("*/weights/best.pt"))[-1]
    print(f"Modèle audio : {ckpt}\nDétecteur image : {det}")
    predictor = Predictor(ckpt)
    detector = Detector(det)
    s3 = s3_client()
    info = load_species_info(s3)
    images = list_image_samples(s3)
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(predictor, info, s3, detector, images))
    print(f"Interface : http://localhost:{args.port}")
    srv.serve_forever()


if __name__ == "__main__":
    main()
