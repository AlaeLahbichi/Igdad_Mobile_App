"""Ingestion : photos iNaturalist des 83 espèces du modèle audio -> BRONZE du data lake TAGHRID (MinIO).

Pour chaque espèce (liste : s3://taghrid-silver/reference/model_v2_classes.txt) :
  - observations « research grade » (identification validée par la communauté), photo sous licence CC ;
  - priorité géographique : Maroc, puis Espagne, Portugal, puis monde entier, jusqu'à --per-species ;
  - 1 seule photo par observation (évite des quasi-doublons entre train et test).
Écrit dans MinIO, sans copie locale :
    s3://taghrid-bronze/inaturalist/api/<espece>/<zone>_page<N>.json   réponses brutes de l'API
    s3://taghrid-bronze/inaturalist/taxa/<espece>.json                  taxon iNaturalist retenu
    s3://taghrid-bronze/inaturalist/images/<espece>/<obs_id>_<photo_id>.jpg
Reprise automatique : les photos déjà présentes ne sont pas retéléchargées.

    .venv/bin/python scripts/ingest_inat_images.py
"""
import argparse
import json
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import boto3

ROOT = Path(__file__).resolve().parents[1]
API = "https://api.inaturalist.org/v1"
HEADERS = {"User-Agent": "EMSI-taghrid/1.0 (projet etudiant, detection oiseaux Maroc)"}
PLACES = [("morocco", 7306), ("spain", 6774), ("portugal", 7122), ("world", None)]
LICENSES = "cc0,cc-by,cc-by-nc,cc-by-sa,cc-by-nc-sa,cc-by-nd,cc-by-nc-nd"
BUCKET = "taghrid-bronze"
# Taxonomie différente entre Xeno-Canto (IOC) et iNaturalist : identifiants de taxon imposés
TAXON_OVERRIDES = {
    "Bubulcus_ibis": 411086,        # iNaturalist : Ardea ibis (héron garde-bœufs occidental)
    "Oenanthe_halophila": 362733,   # iNaturalist : sous-espèce Oenanthe lugens halophila
    "Strix_mauritanica": 718956,    # iNaturalist : sous-espèce Strix aluco mauritanica
}


def s3_client():
    env = dict(l.split("=", 1) for l in (ROOT / ".env").read_text().split() if "=" in l)
    return boto3.client("s3", endpoint_url="http://localhost:9000", region_name="us-east-1",
                        aws_access_key_id=env["MINIO_ROOT_USER"], aws_secret_access_key=env["MINIO_ROOT_PASSWORD"])


_last_call = [0.0]


def api(path, **params):
    """Appel API iNaturalist, limité à ~1 requête/s (recommandation iNaturalist)."""
    url = f"{API}/{path}?{urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})}"
    for attempt in range(6):
        wait = 1.1 - (time.time() - _last_call[0])
        if wait > 0:
            time.sleep(wait)
        _last_call[0] = time.time()
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=60) as r:
                return r.read()
        except Exception as e:
            err = e
            time.sleep(5 * 2 ** attempt)
    raise RuntimeError(f"{url} : {err}")


def find_taxon(name):
    """Taxon iNaturalist d'une espèce (nom scientifique exact, sinon synonyme reconnu par iNaturalist)."""
    res = json.loads(api("taxa", q=name, rank="species", per_page=10))["results"]
    for t in res:
        if t["name"].lower() == name.lower():
            return t
    for t in res:
        if (t.get("matched_term") or "").lower() == name.lower():
            return t
    return None


def download(job):
    s3, key, url = job
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=60) as r:
            data = r.read()
        s3.put_object(Bucket=BUCKET, Key=key, Body=data, ContentType="image/jpeg")
        return True
    except Exception as e:
        print(f"  échec {key} : {e}", flush=True)
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-species", type=int, default=200)
    ap.add_argument("--size", default="large", choices=["medium", "large"], help="medium≈500 px, large≈1024 px")
    args = ap.parse_args()

    s3 = s3_client()
    classes = s3.get_object(Bucket="taghrid-silver", Key="reference/model_v2_classes.txt")["Body"].read().decode().split()
    total, unmatched = 0, []
    pool = ThreadPoolExecutor(6)
    for n, sp in enumerate(classes, 1):
        name = sp.replace("_", " ")
        if sp in TAXON_OVERRIDES:
            taxon = json.loads(api(f"taxa/{TAXON_OVERRIDES[sp]}"))["results"][0]
        else:
            taxon = find_taxon(name)
        if not taxon:
            unmatched.append(sp)
            print(f"[{n}/{len(classes)}] {sp} : taxon introuvable sur iNaturalist", flush=True)
            continue
        s3.put_object(Bucket=BUCKET, Key=f"inaturalist/taxa/{sp}.json", Body=json.dumps(taxon).encode())
        existing = {o["Key"] for p in s3.get_paginator("list_objects_v2").paginate(
            Bucket=BUCKET, Prefix=f"inaturalist/images/{sp}/") for o in p.get("Contents", [])}

        seen, jobs, per_zone = set(), [], {}
        for zone, place_id in PLACES:
            page = 1
            while len(seen) < args.per_species:
                body = api("observations", taxon_id=taxon["id"], place_id=place_id, quality_grade="research",
                           photos="true", photo_license=LICENSES, per_page=200, page=page,
                           order_by="votes", order="desc")
                s3.put_object(Bucket=BUCKET, Key=f"inaturalist/api/{sp}/{zone}_page{page}.json", Body=body)
                results = json.loads(body)["results"]
                for obs in results:
                    photo = next((p for p in obs.get("photos", []) if p.get("license_code")), None)
                    if obs["id"] in seen or not photo or len(seen) >= args.per_species:
                        continue
                    seen.add(obs["id"])
                    per_zone[zone] = per_zone.get(zone, 0) + 1
                    key = f"inaturalist/images/{sp}/{obs['id']}_{photo['id']}.jpg"
                    if key not in existing:
                        jobs.append((s3, key, photo["url"].replace("/square.", f"/{args.size}.")))
                if len(results) < 200 or page >= 5:
                    break
                page += 1
            if len(seen) >= args.per_species:
                break
        ok = sum(pool.map(download, jobs))
        total += len(seen)
        print(f"[{n}/{len(classes)}] {sp} ({taxon['name']}, taxon {taxon['id']}) : {len(seen)} photos "
              f"{per_zone} | {ok} téléchargées, {len(seen) - len(jobs)} déjà présentes", flush=True)
    pool.shutdown()
    print(f"Terminé : {total} photos, {len(classes) - len(unmatched)} espèces. Introuvables : {unmatched}")


if __name__ == "__main__":
    main()
