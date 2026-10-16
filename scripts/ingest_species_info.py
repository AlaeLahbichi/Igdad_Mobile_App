"""Bronze : fiches descriptives des 83 espèces (application mobile Igdad).

Pour chaque espèce du modèle, enregistre dans taghrid-bronze/species_info/ :
  inat/<espece>.json         taxon iNaturalist en français (nom, famille, ordre, statut UICN, photos)
  wikipedia/<espece>.json    article Wikipédia en texte brut (fr, sinon en), découpé en sections par la couche gold
  photos/<espece>.jpg        photo de référence : 1re photo du taxon sous licence Creative Commons
  photos/<espece>.json       auteur, licence et URL de cette photo

    .venv/bin/python scripts/ingest_species_info.py            # n'ajoute que ce qui manque
    .venv/bin/python scripts/ingest_species_info.py --force
"""
import argparse
import json
import re
import sys
import time
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ingest_inat_images import TAXON_OVERRIDES  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
BUCKET, PREFIX = "taghrid-bronze", "species_info/"
# Espèce séparée chez Xeno-Canto (IOC) mais sous-espèce chez iNaturalist : on prend le taxon de la sous-espèce
INFO_TAXON = {"Galerida_macrorhyncha": 1444003}   # Galerida cristata macrorhyncha, « Cochevis du Maghreb »
WIKI_TITLE = {"Galerida_macrorhyncha": ("fr", "Cochevis huppé")}   # pas d'article dédié
UA = {"User-Agent": "Igdad-EMSI-student-project/1.0 (bird recognition, non commercial)"}


def s3_client():
    import boto3
    env = dict(l.split("=", 1) for l in (ROOT / ".env").read_text().split() if "=" in l)
    return boto3.client("s3", endpoint_url="http://localhost:9000", region_name="us-east-1",
                        aws_access_key_id=env["MINIO_ROOT_USER"], aws_secret_access_key=env["MINIO_ROOT_PASSWORD"])


def get(url, **params):
    for attempt in range(8):
        r = requests.get(url, params=params, headers=UA, timeout=30)
        if r.status_code == 429 or r.status_code >= 500:
            wait = r.headers.get("Retry-After", "")
            time.sleep(int(wait) if wait.isdigit() else 5 * (attempt + 1))
            continue
        r.raise_for_status()
        return r
    r.raise_for_status()


def inat_taxon(s3, species):
    """Taxon iNaturalist (locale fr). L'id vient du bronze inaturalist/taxa (déjà résolu à l'ingestion images)."""
    tid = INFO_TAXON.get(species) or TAXON_OVERRIDES.get(species)
    if tid is None:
        tid = json.loads(s3.get_object(Bucket=BUCKET, Key=f"inaturalist/taxa/{species}.json")["Body"].read())["id"]
    return get(f"https://api.inaturalist.org/v1/taxa/{tid}", locale="fr").json()["results"][0]


def wiki_article(lang, title):
    r = get(f"https://{lang}.wikipedia.org/w/api.php", action="query", prop="extracts", explaintext=1,
            redirects=1, titles=title, format="json").json()
    page = next(iter(r["query"]["pages"].values()))
    if "missing" in page or not page.get("extract"):
        return None
    return {"lang": lang, "title": page["title"], "url": f"https://{lang}.wikipedia.org/wiki/{page['title'].replace(' ', '_')}",
            "extract": page["extract"]}


def wikipedia(taxon, species):
    """Article français (lien iNaturalist, sinon nom scientifique), complété par l'anglais si absent."""
    sci = species.replace("_", " ")
    candidates = [WIKI_TITLE[species]] if species in WIKI_TITLE else []
    url = taxon.get("wikipedia_url") or ""
    if "fr.wikipedia.org/wiki/" in url:
        candidates.append(("fr", requests.utils.unquote(url.rsplit("/wiki/", 1)[1])))
    candidates += [("fr", sci), ("en", sci)]
    for lang, title in candidates:
        art = wiki_article(lang, title)
        if art and len(art["extract"].split("\n==", 1)[0]) > 80:
            return art
    return None


def save_photo(s3, sp, taxon):
    """Première photo du taxon sous licence CC (la photo par défaut est parfois « tous droits réservés »)."""
    cands = [taxon.get("default_photo") or {}] + [tp.get("photo", {}) for tp in taxon.get("taxon_photos", [])]
    photo = next((p for p in cands if p.get("license_code") and p.get("url")), None)
    if not photo:
        return None
    url = re.sub(r"/(square|small|medium|original)\.", "/large.", photo["url"])
    s3.put_object(Bucket=BUCKET, Key=f"{PREFIX}photos/{sp}.jpg", Body=get(url).content, ContentType="image/jpeg")
    meta = {"photo_id": photo["id"], "license": photo["license_code"], "attribution": photo.get("attribution"),
            "url": url, "source_url": f"https://www.inaturalist.org/photos/{photo['id']}"}
    s3.put_object(Bucket=BUCKET, Key=f"{PREFIX}photos/{sp}.json", Body=json.dumps(meta, ensure_ascii=False).encode(),
                  ContentType="application/json")
    return meta


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--only", nargs="*", help="espèces à (re)traiter")
    ap.add_argument("--wiki-only", action="store_true", help="refait seulement les articles Wikipédia")
    ap.add_argument("--photos-only", action="store_true", help="refait seulement les photos depuis inat/<espece>.json")
    args = ap.parse_args()
    s3 = s3_client()
    classes = s3.get_object(Bucket="taghrid-gold", Key="audio_training/classes.txt")["Body"].read().decode().split()
    have = {o["Key"] for p in s3.get_paginator("list_objects_v2").paginate(Bucket=BUCKET, Prefix=PREFIX)
            for o in p.get("Contents", [])}
    for i, sp in enumerate(classes, 1):
        if args.only and sp not in args.only:
            continue
        keys = [f"{PREFIX}inat/{sp}.json", f"{PREFIX}wikipedia/{sp}.json", f"{PREFIX}photos/{sp}.json"]
        if args.photos_only:
            taxon = json.loads(s3.get_object(Bucket=BUCKET, Key=keys[0])["Body"].read())
            meta = save_photo(s3, sp, taxon)
            print(f"[{i:>2}/{len(classes)}] {sp:<28} photo {meta['license'] if meta else 'AUCUNE (CC)'}", flush=True)
            continue
        if not (args.force or args.wiki_only or args.photos_only) and all(k in have for k in keys):
            continue
        taxon = inat_taxon(s3, sp)
        s3.put_object(Bucket=BUCKET, Key=keys[0], Body=json.dumps(taxon, ensure_ascii=False).encode(),
                      ContentType="application/json")
        if args.wiki_only:
            taxon = json.loads(s3.get_object(Bucket=BUCKET, Key=keys[0])["Body"].read())
            art = wikipedia(taxon, sp)
            s3.put_object(Bucket=BUCKET, Key=keys[1], Body=json.dumps(art, ensure_ascii=False).encode(),
                          ContentType="application/json")
            print(f"[{i:>2}/{len(classes)}] {sp:<28} wiki={art['lang'] + ':' + art['title'] if art else 'aucun'}", flush=True)
            time.sleep(0.5)
            continue
        art = wikipedia(taxon, sp)
        s3.put_object(Bucket=BUCKET, Key=keys[1], Body=json.dumps(art, ensure_ascii=False).encode(),
                      ContentType="application/json")
        save_photo(s3, sp, taxon)
        print(f"[{i:>2}/{len(classes)}] {sp:<28} {taxon.get('preferred_common_name', '?'):<32} "
              f"wiki={art['lang'] + ':' + art['title'] if art else 'aucun'}", flush=True)
        time.sleep(1.1)   # iNaturalist : ~1 requête/s


if __name__ == "__main__":
    main()
