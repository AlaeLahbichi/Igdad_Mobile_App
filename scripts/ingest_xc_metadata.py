import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://xeno-canto.org/api/3/recordings"
ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "datalake" / "raw" / "xeno_canto"
HEADERS = {"User-Agent": "EMSI-bird-dataset/1.0 (projet etudiant)"}


def get_page(area, page, key):
    params = {"query": f"area:{area} grp:birds", "key": key, "page": page, "per_page": 500}
    url = f"{API}?{urllib.parse.urlencode(params)}"
    for attempt in range(6):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=120) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                sys.exit(f"Erreur API ({e.code}) : {e.read().decode(errors='replace')}")
            err = e
        except Exception as e:
            err = e
        time.sleep(2 ** attempt)
    raise RuntimeError(f"{area} page {page} : {err}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--areas", nargs="+", default=["africa", "europe"])
    args = ap.parse_args()
    key = os.environ.get("XC_API_KEY") or sys.exit("XC_API_KEY manquante")

    for area in args.areas:
        out_dir = RAW / f"area={area}"
        out_dir.mkdir(parents=True, exist_ok=True)
        page, n_pages = 1, None
        while n_pages is None or page <= n_pages:
            out = out_dir / f"page_{page:05d}.json"
            if out.exists() and n_pages is not None:
                page += 1
                continue
            if out.exists():
                data = json.loads(out.read_bytes())
            else:
                body = get_page(area, page, key)
                data = json.loads(body)
                if "error" in data:
                    sys.exit(f"Erreur API : {data}")
                out.with_suffix(".part").write_bytes(body)
                out.with_suffix(".part").rename(out)
                time.sleep(1)
            n_pages = int(data["numPages"])
            if page % 25 == 0 or page == n_pages:
                print(f"{area} : page {page}/{n_pages} ({data['numRecordings']} enregistrements au total)", flush=True)
            page += 1
    print("Ingestion terminée ->", RAW)


if __name__ == "__main__":
    main()
